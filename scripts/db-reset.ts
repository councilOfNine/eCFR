#!/usr/bin/env node
/**
 * Reset the LOCAL D1 database: drop, migrate, seed.
 *
 * The contract this has to meet is "a contributor clones the repo and has a working database
 * in under 30 seconds with no network and no Cloudflare account". Every choice below follows
 * from that:
 *
 *   - It deletes wrangler's local D1 state directory rather than issuing DROP TABLE. Miniflare
 *     keeps local D1 as SQLite files under .wrangler/state; removing them is both faster and
 *     more complete than trying to enumerate objects, and it cannot leave a half-dropped
 *     schema behind.
 *   - Every wrangler call is --local, which needs no credentials and makes no requests.
 *   - WRANGLER_SEND_METRICS=false, because a first-run telemetry prompt on a fresh machine
 *     turns a 30-second script into a hang.
 *
 * Refuses to run against remote D1. There is no flag to make it do so — a script whose whole
 * job is "delete everything" should not have a production mode.
 *
 * Runs as plain `node scripts/db-reset.ts`: the entry file is type-stripped natively (Node
 * 22.18+) and imports nothing but node builtins, so it needs none of the sync pipeline's
 * resolve-hook machinery.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const database = process.env.ECFR_D1_DATABASE ?? 'ecfr-atlas';
const wranglerConfig = resolve(
  repoRoot,
  process.env.ECFR_WRANGLER_CONFIG ?? 'apps/api/wrangler.jsonc',
);
const seedFile = join(repoRoot, 'fixtures', 'seed.sql');
const migrationsDir = join(repoRoot, 'packages', 'db', 'migrations');
// Wrangler keeps local state next to the config file it was given, NOT at the repo root.
// With the D1 binding living in apps/api/wrangler.jsonc that means apps/api/.wrangler — a
// root-relative guess here silently "succeeds" while dropping nothing, and the reset becomes
// a no-op that leaves yesterday's rows in place.
const stateDir = join(dirname(wranglerConfig), '.wrangler', 'state', 'v3', 'd1');

const wranglerBin = existsSync(join(repoRoot, 'node_modules', '.bin', 'wrangler'))
  ? join(repoRoot, 'node_modules', '.bin', 'wrangler')
  : 'wrangler';

function log(message: string): void {
  process.stdout.write(`db-reset: ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`db-reset: ${message}\n`);
  process.exit(1);
}

/** execFile rejections carry the child's stderr; that is the only useful part of a failure. */
function stderrOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'stderr' in error
    ? String((error as { stderr: unknown }).stderr)
    : '';
}

async function wrangler(args: readonly string[], label: string): Promise<string> {
  const started = Date.now();
  try {
    const { stdout } = await execFileAsync(wranglerBin, [...args], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
    log(`${label} (${Date.now() - started} ms)`);
    return stdout;
  } catch (error) {
    process.stderr.write(`${stderrOf(error)}\n`);
    fail(`${label} failed`);
  }
}

if (!existsSync(wranglerConfig)) {
  fail(
    `no wrangler config at ${wranglerConfig}. The D1 binding lives in the API Worker's config; ` +
      `set ECFR_WRANGLER_CONFIG if yours is elsewhere.`,
  );
}
if (!existsSync(migrationsDir)) fail(`no migrations directory at ${migrationsDir}`);

const started = Date.now();

// 1. Drop.
if (existsSync(stateDir)) {
  await rm(stateDir, { recursive: true, force: true });
  log(`removed local D1 state at ${stateDir}`);
} else {
  log('no local D1 state to remove');
}

// 2. Migrate.
await wrangler(
  ['d1', 'migrations', 'apply', database, '--local', '--config', wranglerConfig],
  'applied migrations',
);

// 3. Seed.
if (existsSync(seedFile)) {
  await wrangler(
    ['d1', 'execute', database, '--local', '--config', wranglerConfig, '--file', seedFile],
    `loaded fixtures from ${seedFile}`,
  );
} else {
  // Not fatal. An empty schema is a legitimate starting point, and failing here would make
  // the very first `pnpm db:reset` on a fresh checkout look broken.
  log(`no fixtures at ${seedFile}; schema is empty`);
}

const elapsed = Date.now() - started;
log(`done in ${(elapsed / 1000).toFixed(1)}s`);
if (elapsed > 30_000) {
  process.stderr.write(
    'db-reset: took longer than the 30s budget. Check that wrangler is not reaching the network.\n',
  );
}
