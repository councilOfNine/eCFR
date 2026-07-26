#!/usr/bin/env node

/**
 * Builds the JSON manifest that accompanies each nightly open-data export.
 *
 * The manifest exists so a consumer can verify what they downloaded without trusting us:
 * a sha256 of the exact bytes, the row count of every table in the dump, and the run id and
 * eCFR source date the data came from. Without it, "latest.sql.gz" is an anonymous blob and a
 * truncated upload is indistinguishable from a quiet week in the Federal Register.
 *
 * It also carries the withheld-table list. Saying out loud which tables are NOT in the dump,
 * and why, is the difference between an omission and a surprise.
 *
 * Usage:
 *   node scripts/ci/export-manifest.ts \
 *     --db ecfr-atlas --date 2026-07-26 \
 *     --sql export.sql --gz export.sql.gz --out manifest.json
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
// Explicit .ts specifier: this runs as plain `node`, whose type stripping resolves .ts
// imports natively but never rewrites a .js specifier the way the sync pipeline's hook does.
import { PUBLIC_TABLES, rowCountQuery, WITHHELD_TABLES } from './public-tables.ts';

const execFileAsync = promisify(execFile);

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = process.argv[i + 1];
  if (i !== -1 && value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** One `SELECT '<table>' AS "table", COUNT(*) AS "rows"` arm of the row-count UNION. */
interface RowCountRow {
  table: string;
  rows: number | string;
}

/** The slice of wrangler's `--json` output this script reads. */
interface WranglerJsonResult {
  results?: RowCountRow[];
}

/**
 * `wrangler --json` is documented to emit JSON on stdout, but wrangler has historically also
 * printed a version banner and update nag there. Slicing from the first bracket is tolerant of
 * that without silently accepting garbage: if the slice does not parse we surface the raw text.
 */
function parseWranglerJson(stdout: string): WranglerJsonResult[] | WranglerJsonResult {
  const start = stdout.indexOf('[');
  const objectStart = stdout.indexOf('{');
  const from =
    start === -1 ? objectStart : objectStart === -1 ? start : Math.min(start, objectStart);
  if (from === -1) throw new Error(`no JSON in wrangler output:\n${stdout}`);
  try {
    return JSON.parse(stdout.slice(from)) as WranglerJsonResult[] | WranglerJsonResult;
  } catch (cause) {
    throw new Error(`wrangler output was not JSON:\n${stdout}`, { cause });
  }
}

async function rowCounts(db: string): Promise<Record<string, number>> {
  // A single UNION ALL rather than one query per table: eleven separate round trips to a
  // remote D1 for a manifest field is not a good use of the nightly budget.
  const { stdout } = await execFileAsync(
    'pnpm',
    ['exec', 'wrangler', 'd1', 'execute', db, '--remote', '--json', '--command', rowCountQuery()],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = parseWranglerJson(stdout);
  const results = Array.isArray(parsed) ? (parsed[0]?.results ?? []) : (parsed.results ?? []);
  const counts: Record<string, number> = {};
  for (const row of results) counts[row.table] = Number(row.rows);

  // Every table we claimed to export must have reported a count. A missing key means the table
  // vanished from the schema, and publishing a manifest that quietly omits it would hide that.
  const missing = PUBLIC_TABLES.filter((t) => !(t in counts));
  if (missing.length > 0) {
    throw new Error(`row count missing for exported table(s): ${missing.join(', ')}`);
  }
  return counts;
}

/** `schema: ecfr-atlas/export-manifest/1`. Versioned so consumers can parse it defensively. */
interface ExportManifest {
  schema: string;
  generatedAt: string;
  snapshotDate: string;
  database: string;
  license: { data: string; derived: string; source: string };
  files: Record<
    string,
    {
      alsoPublishedAs: string;
      bytes: number;
      sha256: string;
      contentEncoding: string;
      uncompressedBytes: number;
      uncompressedSha256: string;
    }
  >;
  tables: Record<string, number>;
  totalRows: number;
  withheldTables: Readonly<Record<string, string>>;
  provenance: { workflowRunUrl: string | null; commit: string | null };
}

async function main(): Promise<void> {
  const db = arg('db');
  const date = arg('date');
  const sqlPath = arg('sql');
  const gzPath = arg('gz');
  const outPath = arg('out');

  const [sqlStat, gzStat, gzHash, sqlHash, counts] = await Promise.all([
    stat(sqlPath),
    stat(gzPath),
    sha256(gzPath),
    sha256(sqlPath),
    rowCounts(db),
  ]);

  const manifest: ExportManifest = {
    schema: 'ecfr-atlas/export-manifest/1',
    generatedAt: new Date().toISOString(),
    snapshotDate: date,
    database: db,
    license: {
      data: 'Public domain (17 U.S.C. § 105) as published by the eCFR.',
      derived:
        'Word counts, rollups and overlap analysis are derived measurements produced by ' +
        'ecfr-atlas, not by any government agency. See /methodology.',
      source: 'https://www.ecfr.gov',
    },
    files: {
      'latest.sql.gz': {
        alsoPublishedAs: `${date}.sql.gz`,
        bytes: gzStat.size,
        sha256: gzHash,
        contentEncoding: 'gzip',
        uncompressedBytes: sqlStat.size,
        uncompressedSha256: sqlHash,
      },
    },
    tables: counts,
    totalRows: Object.values(counts).reduce((a, b) => a + b, 0),
    withheldTables: WITHHELD_TABLES,
    provenance: {
      workflowRunUrl:
        process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
          ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : null,
      commit: process.env.GITHUB_SHA ?? null,
    },
  };

  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(
    `manifest: ${outPath} — ${manifest.totalRows.toLocaleString('en-US')} rows across ` +
      `${PUBLIC_TABLES.length} tables, ${(gzStat.size / 1024 / 1024).toFixed(1)} MiB gzipped`,
  );
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`::error title=Export manifest failed::${message.split('\n')[0]}`);
  console.error(error instanceof Error ? (error.stack ?? message) : message);
  process.exitCode = 1;
});
