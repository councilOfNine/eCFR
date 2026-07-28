#!/usr/bin/env node
/**
 * Nightly incremental sync.
 *
 * eCFR publishes on business days only — 57 issue dates in 84 days, zero weekends, median 48
 * changed sections a day. Most nights this touches a handful of titles and a few dozen parts,
 * and on a weekend it finds nothing dirty and exits in seconds. That is the expected outcome,
 * not a failure.
 *
 * Exit codes:
 *   0  synced and published
 *   1  synced, but the publish gate refused to advance published_run_id
 *   2  the run failed
 *   75 eCFR is mid-import (EX_TEMPFAIL — retry later, nothing is wrong here)
 *
 * The entry itself is stripped natively by Node 22.18+; bootstrap.mjs then installs the
 * resolve hook. The imports below MUST stay dynamic: a static `import ... from './lib/x.js'`
 * is resolved during instantiation, before bootstrap has evaluated and registered the hook,
 * and there is no `x.js` on disk for bare Node to find.
 */

import './lib/bootstrap.mjs';

const { loadConfig } = await import('./lib/config.js');
const { createLogger } = await import('./lib/log.js');
const { createContext, runDelta } = await import('./lib/pipeline.js');
const { ImportInProgressError } = await import('./lib/delta.js');
const { D1Error } = await import('./lib/d1.js');

const config = loadConfig();
const log = createLogger('delta');

log.info('configuration', {
  target: config.local ? 'local D1' : 'remote D1',
  database: config.d1Database,
  cache: config.cacheDir,
  r2: config.r2 ? config.r2.bucket : 'none (dry render)',
  dryRun: config.dryRun,
});

try {
  const ctx = await createContext(config);
  const published = await runDelta(ctx);
  process.exit(published ? 0 : 1);
} catch (error) {
  if (error instanceof ImportInProgressError) {
    log.warn(error.message);
    process.exit(75);
  }
  log.error('delta failed', {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
  // D1Error carries wrangler's raw output. Printing it is the difference between "execute
  // failed" and "no such table: sync_run" — the second one tells you what to do next.
  if (error instanceof D1Error && error.stderr) {
    process.stderr.write(`\nwrangler output:\n${error.stderr}\n`);
  }
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(2);
}
