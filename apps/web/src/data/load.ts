/**
 * Resolves which `AtlasData` implementation this build runs on, once.
 *
 * Precedence is explicit rather than clever: the snapshot wins because it is the only source
 * that carries regulation text, D1 is the contributor fallback, and the fixture is last so that
 * a machine with neither configured still gets a working site to look at.
 *
 * `ECFR_USE_FIXTURE=1` overrides everything, which is how you reproduce a rendering bug without
 * standing up a database.
 *
 * The resolution is announced on stdout at build start. A build that silently fell back to the
 * fixture and published invented numbers as if they were measured would be the worst possible
 * failure of this project, so the fallback is loud, and it also sets `manifest.fixture`, which
 * puts a banner on every page.
 */

import { isAbsolute } from 'node:path';

import type { AtlasData } from './contract.js';
import { loadD1Source } from './sources/d1-sqlite.js';
import { loadFixtureSource } from './sources/fixture.js';
import { loadSnapshotSource } from './sources/snapshot-dir.js';

let pending: Promise<AtlasData> | null = null;

/**
 * Astro resolves relative paths against apps/web, not against the directory the build was
 * launched from — a mismatch that has now broken one local build and one CI deploy in a
 * single evening, each time as a confusing "manifest.json is missing" two minutes in.
 * Rejecting the relative form up front turns that into an instant, self-explaining error.
 */
function mustBeAbsolute(name: string, value: string): void {
  if (!isAbsolute(value)) {
    throw new Error(
      `${name} must be an absolute path, got "${value}". Relative paths resolve against ` +
        'apps/web under Astro, not your shell working directory — prefix it with $PWD/ ' +
        'locally, or with the github.workspace expression in CI.',
    );
  }
}

async function resolve(): Promise<AtlasData> {
  const { ECFR_SNAPSHOT_DIR, ECFR_D1_SQLITE, ECFR_USE_FIXTURE } = process.env;

  if (ECFR_USE_FIXTURE === '1') {
    console.warn(
      '[data] ECFR_USE_FIXTURE=1 — building from the committed fixture. Every figure on the ' +
        'resulting site is invented and every page will say so.',
    );
    return loadFixtureSource();
  }

  if (ECFR_SNAPSHOT_DIR) {
    mustBeAbsolute('ECFR_SNAPSHOT_DIR', ECFR_SNAPSHOT_DIR);
    const data = await loadSnapshotSource(ECFR_SNAPSHOT_DIR);
    console.log(
      `[data] snapshot ${ECFR_SNAPSHOT_DIR} — run ${data.manifest.run_id ?? 'unknown'}, ` +
        `source date ${data.manifest.source_date ?? 'unknown'}`,
    );
    return data;
  }

  if (ECFR_D1_SQLITE) {
    mustBeAbsolute('ECFR_D1_SQLITE', ECFR_D1_SQLITE);
    const data = await loadD1Source(ECFR_D1_SQLITE);
    console.log(
      `[data] local D1 ${ECFR_D1_SQLITE} — run ${data.manifest.run_id ?? 'unknown'}. ` +
        'Regulation body text is not available from D1; reader pages will say so.',
    );
    return data;
  }

  console.warn(
    '[data] neither ECFR_SNAPSHOT_DIR nor ECFR_D1_SQLITE is set — falling back to the committed ' +
      'fixture. This build must not be deployed.',
  );
  return loadFixtureSource();
}

/**
 * Every page calls this. Memoised because Astro evaluates each route module independently and
 * a 49-title D1 open per route would dominate build time.
 */
export function atlas(): Promise<AtlasData> {
  pending ??= resolve();
  return pending;
}
