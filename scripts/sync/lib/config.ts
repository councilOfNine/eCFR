/**
 * Environment and paths for the sync pipeline.
 *
 * Everything the pipeline needs from the outside world is resolved once, here, so that a
 * misconfigured CI job fails on line one with a readable message instead of halfway through a
 * five-minute corpus pull.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Measured clean ceiling against ecfr.gov. `ECFR_MAX_RPS` overrides it; CI sets it to 8. */
export const DEFAULT_MAX_RPS = 8;

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Cloudflare's S3 endpoint is account-scoped; region is always `auto`. */
  endpoint: string;
}

export interface SyncConfig {
  repoRoot: string;
  /** D1 database name as declared in the Worker's wrangler config. */
  d1Database: string;
  /** Path to the wrangler config that owns the D1 binding. */
  wranglerConfig: string;
  /** `--local` targets the miniflare SQLite file; `--remote` targets real D1. */
  local: boolean;
  /** Resumable per-title checkpoints. Gitignored; safe to delete. */
  cacheDir: string;
  /** Generated .sql segments and the render manifest. */
  outDir: string;
  /**
   * The JSON snapshot the Astro build consumes (`ECFR_SNAPSHOT_DIR` on the web side).
   *
   * Written only by a run the publish gate accepted. Rendered body HTML accumulates in
   * `content/` across runs, because a nightly delta re-renders only the parts that moved.
   */
  snapshotDir: string;
  /**
   * eCFR asks for a descriptive UA with a contact URL. Automated clients without one get
   * treated as scrapers, and scraping ecfr.gov HTML earns a 302 to a CAPTCHA.
   */
  userAgent: string;
  /**
   * Sustained requests per second against ecfr.gov. `ECFR_MAX_RPS`, default 8.
   *
   * Measured: sustained <=8 req/s is clean at any parallelism and ~10 req/s is where 429s
   * begin. It is configurable because an operator throttling a backfill down (or an eCFR
   * policy change) should not need a code edit — but it is deliberately NOT a per-client
   * option. eCFR's limiter is a token bucket rather than a concurrency gate, so the budget
   * belongs to the PROCESS: `createContext` installs this as `@ecfr-atlas/ecfr`'s shared
   * `RateGovernor` and every client in the process draws on that one bucket. Two clients each
   * "limited" to 8 req/s would run at 16 while both looked correctly configured.
   */
  maxRps: number;
  /** Null when R2 credentials are absent: rendering still runs, but writes nothing. */
  r2: R2Config | null;
  /** Generate and validate everything, apply nothing. */
  dryRun: boolean;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** Walk up from this file to the directory holding pnpm-workspace.yaml. */
export function findRepoRoot(from = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (;;) {
    if (existsSync(resolvePath(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate the repo root (no pnpm-workspace.yaml above ${from})`);
    }
    dir = parent;
  }
}

function readR2Config(): R2Config | null {
  const accountId = env('R2_ACCOUNT_ID');
  const bucket = env('R2_BUCKET');
  const accessKeyId = env('R2_ACCESS_KEY_ID');
  const secretAccessKey = env('R2_SECRET_ACCESS_KEY');
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    accountId,
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint: env('R2_ENDPOINT') ?? `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

/**
 * Parse a positive-rate env var, refusing anything that would silently disable pacing.
 *
 * `Number('')` is 0 and `Number('eight')` is NaN; either one reaching the governor would
 * either throw deep inside a fetch or, worse, be interpreted as "no limit". A misconfigured
 * rate has to fail on line one, next to the value that caused it.
 */
export function parseRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `ECFR_MAX_RPS must be a positive number of requests per second, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

export function loadConfig(argv: readonly string[] = process.argv.slice(2)): SyncConfig {
  const repoRoot = findRepoRoot();
  const flags = new Set(argv.filter((a) => a.startsWith('--')));

  // Default to --local so a contributor who clones the repo and runs the pipeline cannot
  // accidentally write to production D1 by omitting a flag.
  const local = !flags.has('--remote');

  return {
    repoRoot,
    d1Database: env('ECFR_D1_DATABASE') ?? 'ecfr-atlas',
    wranglerConfig: resolvePath(repoRoot, env('ECFR_WRANGLER_CONFIG') ?? 'apps/api/wrangler.jsonc'),
    local,
    cacheDir: resolvePath(repoRoot, env('SYNC_CACHE_DIR') ?? '.sync-cache'),
    outDir: resolvePath(repoRoot, env('SYNC_OUT_DIR') ?? '.sync-cache/out'),
    snapshotDir: resolvePath(repoRoot, env('ECFR_SNAPSHOT_DIR') ?? '.sync-cache/snapshot'),
    userAgent:
      env('ECFR_USER_AGENT') ??
      'ecfr-atlas/0.1 (+https://github.com/ecfr-atlas/ecfr-atlas; nightly corpus sync)',
    maxRps: parseRate(env('ECFR_MAX_RPS'), DEFAULT_MAX_RPS),
    r2: readR2Config(),
    dryRun: flags.has('--dry-run') || env('SYNC_DRY_RUN') === '1',
  };
}
