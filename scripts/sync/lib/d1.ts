/**
 * Thin wrapper over `wrangler d1 execute`.
 *
 * The pipeline runs in Node under GitHub Actions, not in a Worker, so it has no D1 binding.
 * wrangler's CLI is the only supported write path from outside the Workers runtime.
 *
 * Every invocation uses `execFile` with an argv ARRAY and no shell. That is not stylistic:
 * SQL passed via `--command` contains quotes, semicolons and arbitrary corpus text, and a
 * shell in the middle of that would be a command-injection hole one bad label away from
 * being real.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { SyncConfig } from './config.js';
import type { Logger } from './log.js';

const execFileAsync = promisify(execFile);

/** wrangler emits one result object per statement when given `--json`. */
interface WranglerResult<T> {
  results?: T[];
  success?: boolean;
  meta?: Record<string, unknown>;
}

export class D1Error extends Error {
  // Assigned in the body rather than declared as a constructor parameter property: Node's
  // strip-only TypeScript mode rejects parameter properties, and these entry points run
  // straight from source with no build step. `erasableSyntaxOnly` in tsconfig.json enforces
  // it at typecheck time so it cannot regress.
  readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.name = 'D1Error';
    this.stderr = stderr;
  }
}

/**
 * wrangler prints a banner, update notices and occasionally warnings before the JSON payload.
 * Scan forward to the first plausible JSON start and parse from there, rather than trusting
 * the whole of stdout to be JSON.
 */
export function parseWranglerJson<T>(stdout: string): Array<WranglerResult<T>> {
  const start = stdout.search(/^[[{]/m);
  if (start === -1) return [];
  const candidate = stdout.slice(start).trim();
  try {
    const parsed: unknown = JSON.parse(candidate);
    return Array.isArray(parsed)
      ? (parsed as Array<WranglerResult<T>>)
      : [parsed as WranglerResult<T>];
  } catch {
    throw new D1Error('could not parse wrangler --json output', candidate.slice(0, 2000));
  }
}

/**
 * Pull the human sentence out of wrangler's `--json` error envelope.
 *
 * Shape is `{"error":{"text":"no such table: sync_run: SQLITE_ERROR"}}`, emitted on stdout
 * with a non-zero exit. Returns null for anything else so the caller can fall back to the
 * raw streams rather than inventing a message.
 */
function extractWranglerError(stdout: string): string | null {
  const start = stdout.indexOf('{');
  if (start === -1) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start));
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const err = (parsed as { error: unknown }).error;
      if (typeof err === 'string') return err;
      if (typeof err === 'object' && err !== null && 'text' in err) {
        return String((err as { text: unknown }).text);
      }
    }
  } catch {
    // Not JSON — a crash or a usage error. The caller falls back to the raw streams.
  }
  return null;
}

export class D1 {
  #config: SyncConfig;
  #log: Logger;
  #binary: string;

  constructor(config: SyncConfig, log: Logger) {
    this.#config = config;
    this.#log = log.child('d1');

    // Prefer the workspace-pinned wrangler over whatever is on PATH; a version skew between
    // the CLI applying migrations and the one deploying the Worker is a real source of
    // "works locally, fails in CI".
    const local = join(config.repoRoot, 'node_modules', '.bin', 'wrangler');
    this.#binary = existsSync(local) ? local : 'wrangler';
  }

  #baseArgs(): string[] {
    const args = ['d1', 'execute', this.#config.d1Database];
    if (existsSync(this.#config.wranglerConfig)) {
      args.push('--config', this.#config.wranglerConfig);
    }
    args.push(this.#config.local ? '--local' : '--remote');
    return args;
  }

  async #run(extra: string[], label: string): Promise<string> {
    const args = [...this.#baseArgs(), ...extra];
    this.#log.debug('wrangler', { label, args: args.length });
    try {
      const { stdout } = await execFileAsync(this.#binary, args, {
        cwd: this.#config.repoRoot,
        // A 275k-row read can produce tens of MB of JSON on stdout. The default 1 MB buffer
        // truncates it into a parse error that looks like a wrangler bug.
        maxBuffer: 512 * 1024 * 1024,
        env: {
          ...process.env,
          // Keeps the nightly job from blocking on a telemetry prompt on a fresh runner.
          WRANGLER_SEND_METRICS: 'false',
        },
      });
      return stdout;
    } catch (error) {
      // BOTH streams, because wrangler splits them by mode. Under `--json` a SQL error is
      // written to STDOUT as {"error":{"text":"..."}} and stderr is left EMPTY, so reading
      // stderr alone — which this did — captured "" and produced a failure with no stated
      // cause. That is how a missing table surfaced only as "wrangler d1 execute failed
      // (open-run)" and cost a debugging session.
      const streamOf = (key: 'stdout' | 'stderr'): string =>
        typeof error === 'object' && error !== null && key in error
          ? String((error as Record<string, unknown>)[key] ?? '')
          : '';
      const stdout = streamOf('stdout');
      const stderr = streamOf('stderr');

      // Lift wrangler's own sentence into the message. A caller reading a log line should not
      // have to know which stream a given wrangler mode happens to use.
      const detail = extractWranglerError(stdout) ?? (stderr.trim() || stdout.trim());
      const suffix = detail ? `: ${detail}` : '';
      throw new D1Error(
        `wrangler d1 execute failed (${label})${suffix}`,
        [stderr, stdout].filter(Boolean).join('\n').trim(),
      );
    }
  }

  /** Run one or more statements supplied inline. Use for small, code-built SQL only. */
  async command(sql: string, label = 'command'): Promise<void> {
    await this.#run(['--command', sql], label);
  }

  /** Run a query and return its rows. */
  async query<T>(sql: string, label = 'query'): Promise<T[]> {
    const stdout = await this.#run(['--command', sql, '--json'], label);
    const parsed = parseWranglerJson<T>(stdout);
    const rows: T[] = [];
    for (const result of parsed) {
      if (result.results) rows.push(...result.results);
    }
    return rows;
  }

  /** Exactly one row, or null. Throws if the query returns more than one. */
  async queryOne<T>(sql: string, label = 'queryOne'): Promise<T | null> {
    const rows = await this.query<T>(sql, label);
    if (rows.length > 1) {
      throw new D1Error(`expected at most 1 row from ${label}, got ${rows.length}`, sql);
    }
    return rows[0] ?? null;
  }

  /** Apply a generated .sql segment. */
  async applyFile(path: string): Promise<void> {
    await this.#run(['--file', path], `file:${path}`);
  }

  /** Apply segments in order, stopping at the first failure. */
  async applyFiles(paths: readonly string[]): Promise<void> {
    for (const [index, path] of paths.entries()) {
      this.#log.info('applying segment', { index: index + 1, of: paths.length, path });
      await this.applyFile(path);
    }
  }
}
