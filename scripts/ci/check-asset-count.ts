#!/usr/bin/env node

/**
 * Static-asset budget gate for the Astro build.
 *
 * Cloudflare Workers Static Assets caps a free-plan deployment at 20,000 files and 25 MiB per
 * file. Blowing either one fails at DEPLOY time, after the nightly sync has already written to
 * D1 and R2 — the worst possible moment to find out. This runs in CI instead, at 18,000 files,
 * so there is ~2,000 files of headroom to notice the trend and react.
 *
 * The ceiling is not theoretical. The site prerenders one page per part (9,664) plus subpart
 * splits for the 94 parts over 1 MB, and title 40 alone contains 24,614 sections. Any change
 * that starts emitting a page per SECTION rather than per part takes the build from ~11,100
 * files to well past 200,000 in a single commit. This gate is the tripwire for that.
 *
 * Usage:  node scripts/ci/check-asset-count.ts [distDir]   (default apps/web/dist/client)
 * Env:    MAX_ASSET_FILES (default 18000), MAX_ASSET_BYTES (default 25 MiB)
 */

import { existsSync } from 'node:fs';
import { appendFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// dist/CLIENT, not dist. @astrojs/cloudflare splits its output: dist/client holds the
// uploadable assets (and is what apps/web/wrangler.jsonc points at), dist/server holds build
// internals and is empty while every route is prerendered. Measuring dist/ would count the
// wrong tree and report per-directory totals that are all one directory deep.
const DIST = path.resolve(process.argv[2] ?? 'apps/web/dist/client');
const MAX_FILES = Number(process.env.MAX_ASSET_FILES ?? 18_000);
/** Workers Static Assets rejects any single file over 25 MiB. 26 CFR Part 1 is 69,598,633 B. */
const MAX_BYTES = Number(process.env.MAX_ASSET_BYTES ?? 25 * 1024 * 1024);
const REPORT = path.resolve(process.env.ASSET_BUDGET_REPORT ?? 'asset-budget.json');

/**
 * Emitted by @astrojs/cloudflare but NOT uploaded as static assets — the adapter lists them in
 * .assetsignore. Counting them would overstate the budget; ignoring anything else would
 * understate it, which is the direction that hurts. Keep this list in sync with the adapter's
 * .assetsignore if it ever grows.
 */
const NOT_ASSETS: ReadonlySet<string> = new Set([
  '_worker.js',
  '_routes.json',
  '.assetsignore',
  // Wrangler consumes and strips these rather than serving them.
  '_headers',
  '_redirects',
  // Emitted into the output by @cloudflare/vite-plugin. Excluded from upload by
  // apps/web/public/.assetsignore, which also keeps its absolute build paths off the internet.
  'wrangler.json',
]);

interface AssetFile {
  /** Relative to the dist root, native separators. */
  path: string;
  bytes: number;
}

async function walk(dir: string, relativeTo: string): Promise<AssetFile[]> {
  const found: AssetFile[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(relativeTo, abs);
    // Only top-level exclusions: a nested file literally named _routes.json IS an asset.
    if (!rel.includes(path.sep) && NOT_ASSETS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      found.push(...(await walk(abs, relativeTo)));
    } else if (entry.isFile()) {
      const info = await stat(abs);
      found.push({ path: rel, bytes: info.size });
    }
    // Symlinks are neither followed nor counted: wrangler does not upload them.
  }
  return found;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

async function summarise(markdown: string): Promise<void> {
  process.stdout.write(markdown);
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) await appendFile(target, markdown, 'utf8');
}

async function main(): Promise<void> {
  // A missing dist is a hard failure, never a skip. "We could not measure the build" and "the
  // build is fine" must not produce the same exit code — that conflation is the exact bug this
  // whole project exists to correct.
  if (!existsSync(DIST)) {
    console.error(
      `asset budget: ${DIST} does not exist.\n` +
        'The site build did not produce output, so the asset count is unknown, not zero.',
    );
    process.exit(1);
  }

  const files = await walk(DIST, DIST);

  if (files.length === 0) {
    console.error(`asset budget: ${DIST} exists but contains no uploadable files.`);
    process.exit(1);
  }

  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  const oversized = files.filter((f) => f.bytes > MAX_BYTES).sort((a, b) => b.bytes - a.bytes);

  // Per-directory counts make a regression diagnosable at a glance: a jump concentrated in
  // one route folder names the offending page template without any further digging.
  const byTopLevel = new Map<string, number>();
  for (const f of files) {
    const key = f.path.includes(path.sep) ? (f.path.split(path.sep)[0] ?? '(root)') : '(root)';
    byTopLevel.set(key, (byTopLevel.get(key) ?? 0) + 1);
  }
  const topDirs = [...byTopLevel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  const overFileBudget = files.length > MAX_FILES;
  const ok = !overFileBudget && oversized.length === 0;

  await writeFile(
    REPORT,
    `${JSON.stringify(
      {
        dist: DIST,
        checkedAt: new Date().toISOString(),
        fileCount: files.length,
        maxFiles: MAX_FILES,
        cloudflareFreePlanCap: 20_000,
        totalBytes,
        largestFile: [...files].sort((a, b) => b.bytes - a.bytes)[0],
        oversized: oversized.slice(0, 20),
        byTopLevelDirectory: Object.fromEntries(topDirs),
        ok,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const pct = ((files.length / 20_000) * 100).toFixed(1);
  const lines = [
    '## Static-asset budget',
    '',
    `| metric | value |`,
    `| --- | --- |`,
    `| files | **${files.length.toLocaleString('en-US')}** |`,
    `| CI limit | ${MAX_FILES.toLocaleString('en-US')} |`,
    `| Cloudflare free-plan cap | 20,000 (${pct}% used) |`,
    `| total size | ${formatBytes(totalBytes)} |`,
    `| files over ${formatBytes(MAX_BYTES)} | ${oversized.length} |`,
    '',
    '<details><summary>Files per top-level directory</summary>',
    '',
    '| directory | files |',
    '| --- | --- |',
    ...topDirs.map(([dir, count]) => `| \`${dir}\` | ${count.toLocaleString('en-US')} |`),
    '',
    '</details>',
    '',
  ];
  await summarise(`${lines.join('\n')}\n`);

  if (overFileBudget) {
    console.error(
      `\nasset budget FAILED: ${files.length.toLocaleString('en-US')} files exceeds the CI ` +
        `limit of ${MAX_FILES.toLocaleString('en-US')} (Cloudflare free plan caps at 20,000).\n` +
        'Either reduce the number of prerendered pages or move a route to on-demand rendering.',
    );
  }
  for (const f of oversized) {
    console.error(
      `asset budget FAILED: ${f.path} is ${formatBytes(f.bytes)}, over the ` +
        `${formatBytes(MAX_BYTES)} per-file cap. Split it (26 CFR Part 1 must be split by subpart).`,
    );
  }

  process.exit(ok ? 0 : 1);
}

await main();
