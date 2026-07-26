/**
 * The fixture is a published artefact, so it gets held to the same standard as published data.
 *
 * `fixtures/seed.sql` is what a contributor sees on their first `pnpm db:reset`, what the
 * Worker tests render pages from, and what anyone reviewing a change to the rollup logic will
 * eyeball. A fixture containing a fabricated number would teach every reader that fabricated
 * numbers are acceptable here, and would make the tests built on it prove the opposite of what
 * they claim.
 *
 * So: the same rules as the database. A count only exists alongside a status that says it was
 * measured. An unknown says why. Nothing is a placeholder.
 *
 * These assertions read the SQL text rather than loading it into SQLite. The CHECK constraints
 * are exercised against a real D1 in packages/db/test/schema-constraints.test.ts; what this
 * file adds is the properties SQL cannot express — that the corpus-level counts match what was
 * measured from eCFR, and that the generator has not been quietly pointed at different data.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_STATUSES, UNKNOWN_STATUSES } from '@ecfr-atlas/core';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.join(REPO_ROOT, 'fixtures');

const seed = readFileSync(path.join(FIXTURES, 'seed.sql'), 'utf8');

interface Manifest {
  source_date: string;
  fixture_titles: number[];
  counts: Record<string, number>;
}
const manifest = JSON.parse(readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8')) as Manifest;

/**
 * Rows of one generated INSERT block, as raw cell text.
 *
 * The generator emits one row per line with a fixed column order, and `sqlString()`
 * hex-encodes control characters, so no literal newline can occur inside a quoted value. That
 * makes line-oriented parsing sound HERE and nowhere else.
 */
function rowsOf(table: string): string[][] {
  const rows: string[][] = [];
  let inBlock = false;

  for (const line of seed.split('\n')) {
    if (line.startsWith(`INSERT INTO ${table} `)) {
      inBlock = true;
      continue;
    }
    if (inBlock && (line.startsWith('ON CONFLICT') || line.startsWith('INSERT INTO'))) {
      inBlock = line.startsWith(`INSERT INTO ${table} `);
      continue;
    }
    if (!inBlock) continue;
    const match = /^\s*\((.*)\),?$/.exec(line);
    if (match?.[1]) rows.push(splitTuple(match[1]));
  }
  return rows;
}

function splitTuple(tuple: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < tuple.length; i++) {
    const char = tuple[i];
    if (char === "'") {
      if (quoted && tuple[i + 1] === "'") {
        current += "''";
        i += 1;
        continue;
      }
      quoted = !quoted;
    }
    if (char === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

/** Column order of `STRUCTURE_NODE` in scripts/sync/lib/sql.ts. */
const NODE_COLUMNS = [
  'citation',
  'parent_citation',
  'title_number',
  'node_type',
  'identifier',
  'label',
  'reserved',
  'subtitle_id',
  'chapter_id',
  'subchapter_id',
  'part_id',
  'xml_bytes',
  'content_key',
  'word_count',
  'word_count_status',
  'word_count_method',
  'word_count_reason',
  'word_count_run_id',
  'last_seen_run_id',
] as const;

const nodeRows = rowsOf('structure_node').map((cells) => {
  const row: Record<string, string> = {};
  NODE_COLUMNS.forEach((column, index) => {
    row[column] = cells[index] ?? 'NULL';
  });
  return row;
});

const unquote = (cell: string): string => cell.replace(/^'|'$/g, '').replaceAll("''", "'");

describe('the fixture parses at all', () => {
  it('has the structure_node rows the manifest claims', () => {
    // If the line parser above ever stops matching, every assertion below passes over an empty
    // array. This is the one that notices.
    expect(nodeRows.length).toBe(manifest.counts.structure_nodes);
    expect(nodeRows.length).toBeGreaterThan(1000);
  });

  it('has the corpus-wide counts measured against the live API', () => {
    // These are facts about the CFR, not about this code. A change means eCFR reorganised
    // something and the fixture wants regenerating — which is information worth surfacing,
    // not a flake.
    expect(manifest.counts.titles).toBe(50);
    expect(manifest.counts.agencies).toBe(316);
    expect(manifest.counts.references).toBe(487);
    expect(manifest.counts.overlaps).toBe(17);
  });

  it('is small enough to review as a diff', () => {
    // A fixture nobody reads is a fixture nobody checks. The 25 MiB figure is Cloudflare's
    // per-file static asset cap; this bound is far tighter and is about human review.
    const bytes = Buffer.byteLength(seed);
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
  });

  it('is SQL text, never a binary database', () => {
    expect(existsSync(path.join(FIXTURES, 'seed.sql'))).toBe(true);
    const binaries = readdirSync(FIXTURES).filter((name) => /\.(sqlite|db)$/.test(name));
    expect(binaries).toEqual([]);
  });
});

describe('no fabricated number in the fixture', () => {
  it('every word_count is accompanied by a status that claims a measurement', () => {
    const offenders: string[] = [];

    for (const row of nodeRows) {
      const status = unquote(row.word_count_status ?? '');
      const hasCount = row.word_count !== 'NULL';
      const known = (KNOWN_STATUSES as readonly string[]).includes(status);
      const unknown = (UNKNOWN_STATUSES as readonly string[]).includes(status);

      if (!known && !unknown) {
        offenders.push(`${unquote(row.citation ?? '')}: unrecognised status ${status}`);
        continue;
      }
      if (hasCount !== known) {
        offenders.push(
          `${unquote(row.citation ?? '')}: word_count=${row.word_count} with status ${status}`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every unknown carries a reason and no method', () => {
    for (const row of nodeRows) {
      if (row.word_count !== 'NULL') continue;
      const citation = unquote(row.citation ?? '');
      expect(row.word_count_reason, citation).not.toBe('NULL');
      expect(row.word_count_method, citation).toBe('NULL');
    }
  });

  it('every known count carries a method and no reason', () => {
    for (const row of nodeRows) {
      if (row.word_count === 'NULL') continue;
      const citation = unquote(row.citation ?? '');
      expect(row.word_count_method, citation).not.toBe('NULL');
      expect(row.word_count_reason, citation).toBe('NULL');
      expect(Number.parseInt(row.word_count ?? '', 10), citation).toBeGreaterThanOrEqual(0);
    }
  });

  it('uses only the three real count methods', () => {
    const methods = new Set(
      nodeRows.map((row) => row.word_count_method).filter((value) => value !== 'NULL'),
    );
    expect([...methods].map((m) => unquote(m ?? '')).sort()).toEqual(
      ['descendant_sum', 'reserved', 'xml_parse'].filter((m) =>
        [...methods].some((value) => unquote(value ?? '') === m),
      ),
    );
    expect([...methods].map((m) => unquote(m ?? ''))).not.toContain('estimate');
  });

  it('contains at least one unknown, so the site cannot be written assuming completeness', () => {
    // Deliberate. A fixture where every number is known would let a page that renders `null`
    // as `0` pass review — which is the exact defect this project exists to prevent. Title 12
    // supplies a real one: an unnamed `hed1` node with no identifier to locate it by, which
    // makes its whole ancestor chain unmeasurable through `rollUp()`.
    const unknowns = nodeRows.filter((row) => row.word_count === 'NULL');
    expect(unknowns.length).toBeGreaterThan(0);
    expect(manifest.counts.unmeasured_nodes).toBe(unknowns.length);

    // But not so many that nothing renders.
    expect(unknowns.length / nodeRows.length).toBeLessThan(0.05);
  });

  it('propagates that unknown to its ancestors and to nothing else', () => {
    // rollUp() returning unavailable for a parent with one unknown child is the invariant; the
    // fixture is where it is visible end to end. Every unknown must be either the leaf itself
    // or an ancestor of it.
    const unknownCitations = nodeRows
      .filter((row) => row.word_count === 'NULL')
      .map((row) => unquote(row.citation ?? ''))
      .sort();

    const leaves = unknownCitations.filter(
      (citation) =>
        !unknownCitations.some((other) => other !== citation && other.startsWith(`${citation}/`)),
    );

    for (const citation of unknownCitations) {
      const isAncestorOfALeaf = leaves.some((leaf) => leaf.startsWith(citation));
      expect(isAncestorOfALeaf, `${citation} is unknown but has no unknown descendant`).toBe(true);
    }
  });
});

describe('the fixture renders every kind of page', () => {
  it('covers the node types the site has routes for', () => {
    const types = new Set(nodeRows.map((row) => unquote(row.node_type ?? '')));
    for (const required of ['title', 'chapter', 'part', 'section']) {
      expect(types, `no ${required} rows`).toContain(required);
    }
  });

  it('has enough parts to exercise the table-of-contents queries', () => {
    const parts = nodeRows.filter((row) => unquote(row.node_type ?? '') === 'part');
    expect(parts.length).toBeGreaterThan(400);
  });

  it('includes reserved nodes, which render differently from measured ones', () => {
    const reserved = nodeRows.filter(
      (row) => unquote(row.word_count_status ?? '') === 'reserved_empty',
    );
    expect(reserved.length).toBeGreaterThan(0);
    for (const row of reserved) {
      expect(row.word_count).toBe('0');
      expect(unquote(row.word_count_method ?? '')).toBe('reserved');
    }
  });

  it('points at rendered content that exists on disk', () => {
    // `content_key` is documented as always resolving. A fixture that pointed at objects it
    // did not ship would teach a reader the opposite.
    const contentDir = path.join(FIXTURES, 'content');
    const onDisk = new Set(readdirSync(contentDir));

    const keys = nodeRows
      .map((row) => row.content_key)
      .filter((value): value is string => value !== undefined && value !== 'NULL')
      .map(unquote);

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(onDisk, key).toContain(`${key.replaceAll('/', '__')}.gz`);
    }
  });

  it('has a published run for app_meta to point at', () => {
    // Every read path resolves through app_meta.published_run_id. A fixture that left it null
    // would render an empty site and look like a query bug.
    expect(seed).toMatch(/UPDATE app_meta\s+SET published_run_id = 1/);
    expect(seed).toMatch(/INSERT INTO sync_run[\s\S]*'succeeded'/);
  });
});

describe('provenance', () => {
  it('says where the data came from and how to regenerate it', () => {
    // A generated file with no header is a file somebody will hand-edit.
    expect(seed).toContain('GENERATED by scripts/build-fixtures.ts');
    expect(seed).toContain('node scripts/build-fixtures.ts');
    expect(seed).toContain('https://www.ecfr.gov');
    expect(seed).toContain(manifest.source_date);
  });

  it('states which parts are complete and which are partial', () => {
    // The distinction a reader has to be able to make without running anything.
    expect(seed).toContain('REAL AND COMPLETE');
    expect(seed).toContain('REAL AND PARTIAL');
    expect(seed).toContain('NOT PRESENT');
  });

  it('carries an eCFR snapshot date', () => {
    expect(manifest.source_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
