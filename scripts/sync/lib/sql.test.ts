/**
 * Escaping is the injection surface of this pipeline: every byte eCFR returns ends up inside
 * a literal in a .sql file that is then executed with full write privileges.
 *
 * These tests do not just assert on the generated text — they round-trip it through a real
 * SQLite (`node:sqlite`, built into Node 22) and compare what comes back out. A test that
 * only checks the string is a test of my beliefs about SQLite's grammar; a round-trip is a
 * test of SQLite's.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  AGENCY,
  buildPrune,
  buildPruneCount,
  buildUpsert,
  SqlWriter,
  STRUCTURE_NODE,
  sanitizeForSqliteText,
  sqlBool,
  sqlIdent,
  sqlInt,
  sqlReal,
  sqlString,
  sqlValue,
} from './sql.js';

// node:sqlite is built in from Node 22.5 but still flagged experimental; if the runtime
// refuses it, the round-trip tests skip rather than fail the suite.
let DatabaseSync: (new (path: string) => SqliteLike) | null = null;
interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}
try {
  ({ DatabaseSync } = (await import('node:sqlite')) as unknown as {
    DatabaseSync: new (path: string) => SqliteLike;
  });
} catch {
  DatabaseSync = null;
}

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ecfr-sql-'));
  tempDirs.push(dir);
  return dir;
}

/** Round-trip a JS string through a SQLite TEXT column using only our escaping. */
function roundTrip(value: string): string {
  if (!DatabaseSync) throw new Error('node:sqlite unavailable');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE t (v TEXT);');
    db.exec(`INSERT INTO t (v) VALUES (${sqlString(value)});`);
    const rows = db.prepare('SELECT v FROM t;').all() as Array<{ v: string }>;
    return rows[0]?.v ?? '';
  } finally {
    db.close();
  }
}

describe('sqlString', () => {
  it('doubles single quotes', () => {
    expect(sqlString("O'Brien")).toBe("'O''Brien'");
    expect(sqlString("''")).toBe("''''''");
  });

  it('leaves backslashes alone — SQLite has no backslash escape', () => {
    // A pipeline that "helpfully" escaped these would corrupt every Windows path and every
    // regex quoted in a regulation.
    expect(sqlString('C:\\temp\\x')).toBe("'C:\\temp\\x'");
  });

  it('passes non-ASCII through as UTF-8 text, not hex', () => {
    expect(sqlString('§ 60.1 — naïve café 🏛')).toBe("'§ 60.1 — naïve café 🏛'");
  });

  it('hex-encodes control characters instead of embedding them', () => {
    expect(sqlString('line1\nline2')).toMatch(/^CAST\(x'[0-9a-f]+' AS TEXT\)$/);
    expect(sqlString('esc\u001b[31m')).toMatch(/^CAST\(x'[0-9a-f]+' AS TEXT\)$/);
  });

  it('substitutes NUL, which no SQLite TEXT encoding can carry', () => {
    // Proven by the next test against a real SQLite: a blob cast stops at the first zero
    // byte. Writing the NUL through would silently drop everything after it.
    expect(sanitizeForSqliteText('a\u0000b')).toBe('a\uFFFDb');
    expect(sqlString('a\u0000b')).toBe("'a\uFFFDb'");
  });

  it.skipIf(!DatabaseSync)('DOCUMENTS why: SQLite truncates a blob cast at the first NUL', () => {
    if (!DatabaseSync) return;
    const db = new DatabaseSync(':memory:');
    try {
      // The bytes 61 00 62 are 'a', NUL, 'b'. Only 'a' survives the cast.
      const rows = db.prepare("SELECT CAST(x'610062' AS TEXT) AS v;").all() as Array<{ v: string }>;
      expect(rows[0]?.v).toBe('a');
    } finally {
      db.close();
    }
  });

  it('replaces lone surrogates before encoding', () => {
    // A lone surrogate cannot be UTF-8 encoded; without toWellFormed the two escaping paths
    // would substitute differently and the same input could produce two different literals.
    const result = sqlString('a\uD800b');
    expect(result).toBe("'a\uFFFDb'");
  });

  it.skipIf(!DatabaseSync)('round-trips adversarial strings through real SQLite', () => {
    const cases = [
      "'; DROP TABLE structure_node; --",
      "') ,(1,2,3); DELETE FROM agency WHERE '1'='1",
      'normal text',
      '',
      "quote'inside",
      'multi\nline\ttabbed',
      'nul\u0000byte',
      '§ 1.1 “smart quotes” — em-dash',
      'x'.repeat(10_000),
      String.raw`C:\path\to\thing`,
      '\u007f\u001b[31mansi',
    ];
    for (const value of cases) {
      expect(roundTrip(value)).toBe(sanitizeForSqliteText(value));
    }
  });

  it.skipIf(!DatabaseSync)('an injection attempt inserts one row containing the payload', () => {
    if (!DatabaseSync) return;
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE t (v TEXT);');
      const payload = "'); DELETE FROM t; INSERT INTO t VALUES ('pwned";
      db.exec(`INSERT INTO t (v) VALUES (${sqlString(payload)});`);
      const rows = db.prepare('SELECT v FROM t;').all() as Array<{ v: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.v).toBe(payload);
    } finally {
      db.close();
    }
  });
});

describe('numeric literals', () => {
  it('accepts safe integers', () => {
    expect(sqlInt(0)).toBe('0');
    expect(sqlInt(-105_096_026)).toBe('-105096026');
  });

  it('refuses anything that would print as a bare identifier or exponent', () => {
    // NaN would emit the token `NaN`, which SQLite parses as a column name and resolves to
    // NULL in some contexts — a silent null word count, which is exactly the failure class
    // this project exists to eliminate.
    expect(() => sqlInt(Number.NaN)).toThrow(RangeError);
    expect(() => sqlInt(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => sqlInt(1.5)).toThrow(RangeError);
    expect(() => sqlInt(2 ** 53)).toThrow(RangeError);
    expect(() => sqlReal(Number.NaN)).toThrow(RangeError);
  });

  it('routes floats to REAL and integers to INTEGER via sqlValue', () => {
    expect(sqlValue(3)).toBe('3');
    expect(sqlValue(0.4212)).toBe('0.4212');
    expect(sqlBool(true)).toBe('1');
    expect(sqlValue(null)).toBe('NULL');
    expect(sqlValue(undefined)).toBe('NULL');
  });
});

describe('sqlIdent', () => {
  it('rejects anything that is not a bare identifier', () => {
    expect(sqlIdent('structure_node')).toBe('structure_node');
    expect(() => sqlIdent('structure_node; DROP TABLE x')).toThrow();
    expect(() => sqlIdent('"quoted"')).toThrow();
    expect(() => sqlIdent('')).toThrow();
  });
});

describe('buildUpsert', () => {
  it('emits a multi-row insert with excluded-based updates', () => {
    const sql = buildUpsert(AGENCY, [
      {
        slug: 'epa',
        name: 'Environmental Protection Agency',
        short_name: 'EPA',
        display_name: 'Environmental Protection Agency',
        sortable_name: 'Environmental Protection Agency',
        parent_slug: null,
        depth: 0,
        last_seen_run_id: 7,
      },
    ]);
    expect(sql).toContain('INSERT INTO agency (slug, name');
    expect(sql).toContain('ON CONFLICT (slug) DO UPDATE SET');
    expect(sql).toContain('name = excluded.name');
    expect(sql).not.toContain('slug = excluded.slug');
  });

  it('omits content_key from the update list so a verified pointer is never clobbered', () => {
    const sql = buildUpsert(STRUCTURE_NODE, [
      {
        citation: 'title-40/chapter-I/part-60',
        parent_citation: 'title-40/chapter-I',
        title_number: 40,
        node_type: 'part',
        identifier: '60',
        label: 'Part 60',
        reserved: false,
        subtitle_id: null,
        chapter_id: 'I',
        subchapter_id: null,
        part_id: null,
        xml_bytes: 1234,
        content_key: null,
        word_count: 100,
        word_count_status: 'rolled_up',
        word_count_method: 'descendant_sum',
        word_count_reason: null,
        word_count_run_id: 7,
        last_seen_run_id: 7,
      },
    ]);
    expect(sql).toContain('content_key');
    expect(sql).not.toContain('content_key = excluded.content_key');
  });

  it('returns empty string for no rows', () => {
    expect(buildUpsert(AGENCY, [])).toBe('');
  });
});

describe('insert-then-prune', () => {
  it('always ANDs the run guard onto the caller-supplied scope', () => {
    const sql = buildPrune({ table: 'structure_node', where: 'title_number = 12' }, 42);
    expect(sql).toBe(
      'DELETE FROM structure_node WHERE (title_number = 12) AND last_seen_run_id < 42;',
    );
    expect(buildPruneCount({ table: 'structure_node', where: 'title_number = 12' }, 42)).toContain(
      'SELECT COUNT(*)',
    );
  });

  it('withholds prunes for units that did not commit', async () => {
    const dir = await tempDir();
    const writer = new SqlWriter({ outDir: dir, runId: 9 });

    writer.upsert(AGENCY, [
      {
        slug: 'a',
        name: 'A',
        short_name: null,
        display_name: 'A',
        sortable_name: 'A',
        parent_slug: null,
        depth: 0,
        last_seen_run_id: 9,
      },
    ]);
    writer.planPrune('title-1', { table: 'structure_node', where: 'title_number = 1' });
    writer.planPrune('title-2', { table: 'structure_node', where: 'title_number = 2' });
    writer.commitUnit('title-1');

    const bundle = await writer.finish('test');
    expect(bundle.withheldUnits).toEqual(['title-2']);
    expect(bundle.prunes).toHaveLength(1);

    const pruneSql = await readFile(bundle.pruneFile as string, 'utf8');
    expect(pruneSql).toContain('title_number = 1');
    // The whole point: a title that failed leaves stale rows rather than a hole.
    expect(pruneSql).not.toContain('title_number = 2');
  });

  it.skipIf(!DatabaseSync)(
    'upsert-all + scoped prune removes a node that left the structure',
    async () => {
      if (!DatabaseSync) return;
      // The invariant the whole insert-then-prune design rests on, exercised against the real
      // migration. It is here because the first implementation got it wrong: a bulk
      // "touch every row in the title" before the prune protected the live rows and also
      // resurrected the dead one, permanently.
      const migration = await readFile(
        new URL('../../../packages/db/migrations/0001_init.sql', import.meta.url),
        'utf8',
      );
      const db = new DatabaseSync(':memory:');
      try {
        db.exec('PRAGMA foreign_keys = ON;');
        db.exec(migration);
        db.exec(
          "INSERT INTO sync_run (id, kind, status, started_at) VALUES (7, 'backfill', 'running', '2026-07-26T00:00:00Z');",
        );
        db.exec(
          "INSERT INTO title (number, name, reserved, last_seen_run_id) VALUES (42, 'Public Health', 0, 7);",
        );
        // A node written by run 3 that no longer exists upstream.
        db.exec(
          'INSERT INTO structure_node (citation, title_number, node_type, label, word_count_status, word_count_reason, last_seen_run_id) ' +
            "VALUES ('title-42/chapter-I/part-99', 42, 'part', 'Removed', 'not_computed', 'stale', 3);",
        );

        const node = (citation: string) => ({
          citation,
          parent_citation: 'title-42/chapter-I',
          title_number: 42,
          node_type: 'part',
          identifier: '1',
          label: 'Part 1',
          reserved: false,
          subtitle_id: null,
          chapter_id: 'I',
          subchapter_id: null,
          part_id: null,
          xml_bytes: 10,
          content_key: null,
          word_count: 5,
          word_count_status: 'rolled_up',
          word_count_method: 'descendant_sum',
          word_count_reason: null,
          word_count_run_id: 7,
          last_seen_run_id: 7,
        });

        db.exec(buildUpsert(STRUCTURE_NODE, [node('title-42/chapter-I/part-1')]));
        db.exec(buildPrune({ table: 'structure_node', where: 'title_number = 42' }, 7));

        const rows = db
          .prepare('SELECT citation FROM structure_node ORDER BY citation;')
          .all() as Array<{
          citation: string;
        }>;
        expect(rows.map((r) => r.citation)).toEqual(['title-42/chapter-I/part-1']);
      } finally {
        db.close();
      }
    },
  );

  it('emits no prune file when nothing committed', async () => {
    const dir = await tempDir();
    const writer = new SqlWriter({ outDir: dir, runId: 1 });
    writer.planPrune('title-1', { table: 'structure_node', where: 'title_number = 1' });
    const bundle = await writer.finish('test');
    expect(bundle.pruneFile).toBeNull();
  });

  it('orders prunes children-first so a delete cannot trip a foreign key', async () => {
    const dir = await tempDir();
    const writer = new SqlWriter({ outDir: dir, runId: 3 });
    writer.planPrune('u', { table: 'agency', where: 'TRUE' });
    writer.planPrune('u', { table: 'agency_cfr_reference', where: 'TRUE' });
    writer.planPrune('u', { table: 'agency_rollup', where: 'TRUE' });
    writer.commitUnit('u');
    const bundle = await writer.finish('test');
    expect(bundle.prunes.map((p) => p.table)).toEqual([
      'agency_rollup',
      'agency_cfr_reference',
      'agency',
    ]);
  });
});

describe('SqlWriter chunking', () => {
  it('splits large row sets across statements', async () => {
    const dir = await tempDir();
    const writer = new SqlWriter({ outDir: dir, runId: 1, rowsPerStatement: 10 });
    const rows = Array.from({ length: 95 }, (_, i) => ({
      slug: `a${i}`,
      name: `A${i}`,
      short_name: null,
      display_name: `A${i}`,
      sortable_name: `A${i}`,
      parent_slug: null,
      depth: 0,
      last_seen_run_id: 1,
    }));
    writer.upsert(AGENCY, rows);
    expect(writer.statementCount).toBe(10); // ceil(95/10)
    expect(writer.rowCount).toBe(95);

    const bundle = await writer.finish('chunk');
    const sql = await readFile(bundle.dataFiles[0] as string, 'utf8');
    expect(sql.match(/INSERT INTO agency/g)).toHaveLength(10);
  });

  it.skipIf(!DatabaseSync)('generated SQL applies cleanly against the real schema', async () => {
    if (!DatabaseSync) return;
    const migration = await readFile(
      new URL('../../../packages/db/migrations/0001_init.sql', import.meta.url),
      'utf8',
    );
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(migration);
      db.exec(
        `INSERT INTO sync_run (kind, status, started_at) VALUES ('backfill', 'running', '2026-07-26T00:00:00Z');`,
      );
      db.exec(
        buildUpsert({ ...AGENCY }, [
          {
            slug: "o'brien-agency",
            name: "O'Brien's \u0000 Agency",
            short_name: null,
            display_name: 'OBA',
            sortable_name: 'OBrien',
            parent_slug: null,
            depth: 0,
            last_seen_run_id: 1,
          },
        ]),
      );
      const rows = db.prepare('SELECT slug, name FROM agency;').all() as Array<{
        slug: string;
        name: string;
      }>;
      expect(rows[0]?.slug).toBe("o'brien-agency");
      expect(rows[0]?.name).toBe("O'Brien's \uFFFD Agency");
    } finally {
      db.close();
    }
  });
});
