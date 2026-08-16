#!/usr/bin/env node
/**
 * Fill the snapshot's `content/` directory from R2 before a delta runs.
 *
 * `content/` lives under ECFR_SNAPSHOT_DIR, which is deliberately outside the checkpoint cache
 * so the guards and the Astro build read the same place. Nothing put it back between runs, and
 * a delta only re-renders the parts that moved that day — so every nightly snapshot carried
 * about ten parts of body text instead of ten thousand, and the site build rejected all of
 * them. Because the snapshot is published to R2 before the build, each rejected snapshot still
 * replaced the object every code deploy builds from, and the site froze for a week.
 *
 * The fix is to treat R2 as what it already is. `uploadUnit` writes each rendered part to the
 * content bucket AND to the snapshot; the bucket copy is the canonical one, written on every
 * run including runs whose build later failed, so it is never behind. Rebuilding `content/`
 * from it makes the directory a materialised view of that store rather than a second copy with
 * its own vintage — which is what made the earlier tarball-based fix need a run-parity guard,
 * since pairing a delta with older text silently backdates every part that changed in between.
 *
 * Exit codes: 0 hydrated (or nothing to hydrate), 2 failed.
 *
 * Imports stay dynamic for the same reason delta.ts documents: bootstrap installs the resolve
 * hook, and a static import would be resolved before it has run.
 */

import './lib/bootstrap.mjs';

const { mkdir, writeFile } = await import('node:fs/promises');
const { dirname, join } = await import('node:path');

const { loadConfig } = await import('./lib/config.js');
const { createLogger } = await import('./lib/log.js');
const { R2Client } = await import('./lib/r2.js');
const { contentPathFor } = await import('./lib/render.js');

/** Matches `contentKeyFor` in lib/render.ts; only these objects are body text. */
const CONTENT_PREFIX = 'parts/';
/** Wide enough to saturate the link on ~10,300 small objects, narrow enough to stay polite. */
const CONCURRENCY = 32;

const config = loadConfig();
const log = createLogger('hydrate');

if (!config.r2) {
  log.error('no R2 credentials; cannot hydrate rendered content', {
    hint: 'set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY',
  });
  process.exit(2);
}

const contentDir = join(config.snapshotDir, 'content');
const client = new R2Client(config.r2, log);

let written = 0;
let missing = 0;
let bytes = 0;

async function hydrate(key: string): Promise<void> {
  const body = await client.get(key);
  if (body === null) {
    // Listed a moment ago, gone now: a concurrent run replacing an object. The part keeps
    // whatever text it had; the count guard before publish decides whether that is enough.
    missing += 1;
    log.warn('object vanished between list and get', { key });
    return;
  }
  const target = contentPathFor(contentDir, key);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
  written += 1;
  bytes += body.byteLength;
}

try {
  const keys = await log.time('list content objects', () => client.list(CONTENT_PREFIX));
  log.info('content objects listed', { keys: keys.length, prefix: CONTENT_PREFIX });

  if (keys.length === 0) {
    // First run against an empty bucket. Not an error here: the render stage will populate it,
    // and the rendered-count guard before publish is what decides whether the result is fit to
    // publish. Saying so plainly beats a silent success that looks identical to a full restore.
    log.warn('no content objects found; this run renders from scratch', { prefix: CONTENT_PREFIX });
    process.exit(0);
  }

  await mkdir(contentDir, { recursive: true });

  // Fixed pool of workers over a shared cursor: bounded memory and no 10,300-promise burst,
  // which is what a chunked Promise.all does at this size.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const key = keys[index];
      if (key === undefined) return;
      await hydrate(key);
    }
  };
  await log.time('download content objects', async () => {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  });

  log.info('content hydrated', {
    written,
    missing,
    megabytes: Math.round(bytes / 1e6),
    contentDir,
  });
  process.exit(0);
} catch (error) {
  log.error('hydration failed', { error: error instanceof Error ? error.message : String(error) });
  process.exit(2);
}
