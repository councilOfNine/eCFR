#!/usr/bin/env node
/**
 * The allow-list of D1 tables that may appear in the public open-data export.
 *
 * This is an ALLOW-list, not a deny-list, and that direction is deliberate. A new table added
 * by a future migration is excluded until someone consciously adds it here. The opposite
 * arrangement — enumerate the secrets, ship the rest — leaks the first table nobody remembered
 * to think about, and in this schema that table holds subscriber email addresses.
 *
 * The same list drives both the `wrangler d1 export --table` flags and the manifest's row
 * counts, so the thing we publish and the thing we describe cannot drift apart.
 */

import { pathToFileURL } from 'node:url';

/** Tables published in the nightly export. Everything here is derived from public eCFR data. */
export const PUBLIC_TABLES = [
  'title',
  'agency',
  'structure_node',
  'agency_cfr_reference',
  'scope_overlap',
  'agency_rollup',
  'agency_snapshot',
  'amendment',
  'sync_run',
  'title_watermark',
  'app_meta',
] as const;

export type PublicTable = (typeof PUBLIC_TABLES)[number];

/**
 * Tables deliberately withheld, with the reason. Exported into the manifest so consumers can
 * see that the omission is a decision rather than an oversight.
 */
export const WITHHELD_TABLES: Readonly<Record<string, string>> = {
  api_account: 'contains subscriber email addresses and verification token hashes',
  api_key: 'contains API key hashes; publishing them would enable offline cracking',
  api_usage_day: 'per-key request volume is attributable to an individual account',
};

/** `--table a --table b ...` for `wrangler d1 export`. */
export function wranglerTableFlags(): string[] {
  return PUBLIC_TABLES.flatMap((t) => ['--table', t]);
}

/**
 * One round trip for every row count. D1 bills and rate-limits per query, and a nightly
 * eleven-query fan-out for a number that goes into a manifest is not worth it.
 */
export function rowCountQuery(): string {
  // Both aliases are quoted: `table` is reserved outright and `rows` is a keyword in SQLite's
  // window-function grammar, so an unquoted `AS rows` is a parse error waiting for a version bump.
  return PUBLIC_TABLES.map((t) => `SELECT '${t}' AS "table", COUNT(*) AS "rows" FROM "${t}"`).join(
    ' UNION ALL ',
  );
}

// Tiny CLI so the workflow YAML never has to restate the table list.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const mode = process.argv[2];
  if (mode === '--wrangler-flags') process.stdout.write(`${wranglerTableFlags().join(' ')}\n`);
  else if (mode === '--row-count-query') process.stdout.write(`${rowCountQuery()}\n`);
  else if (mode === '--list') process.stdout.write(`${PUBLIC_TABLES.join('\n')}\n`);
  else {
    console.error('usage: public-tables.ts --wrangler-flags | --row-count-query | --list');
    process.exit(2);
  }
}
