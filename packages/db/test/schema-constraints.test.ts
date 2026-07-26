/**
 * The CHECK constraints are the last line of defence, so they get tested like one.
 *
 * Every other guard in this codebase is a convention a future contributor can route around:
 * the `Measurement` union can be cast away, `toRow` can be bypassed, a raw `INSERT` can be
 * hand-written in a migration or a one-off script. The constraints in 0001_init.sql cannot.
 * They are the reason "we measured 104,642" and "we don't know" are distinguishable at rest,
 * which is the single defect that caused this rewrite.
 *
 * These three cases were verified by hand against real SQLite before the schema was committed.
 * This file is where that verification stops being a thing somebody once did and becomes a
 * thing CI does.
 */

import { env } from 'cloudflare:test';
import {
  counted,
  KNOWN_STATUSES,
  type Measurement,
  notComputed,
  reservedEmpty,
  rolledUp,
  toRow,
  UNKNOWN_STATUSES,
  unavailable,
  WORD_COUNT_STATUSES,
} from '@ecfr-atlas/core';
import { describe, expect, it } from 'vitest';

const db = (env as unknown as { DB: D1Database }).DB;

const RUN_ID = 1;

async function seedTitle(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO title (number, name, reserved, last_seen_run_id) VALUES (1, 'General Provisions', 0, ?)`,
    )
    .bind(RUN_ID)
    .run();
}

interface NodeOverrides {
  citation?: string;
  word_count?: number | null;
  word_count_status?: string;
  word_count_method?: string | null;
  word_count_reason?: string | null;
}

/**
 * Insert a structure_node with the measurement columns set explicitly.
 *
 * Deliberately NOT routed through `toRow()`. The whole question these tests ask is "what
 * happens when something bypasses the type-level guard?", so the insert has to be able to
 * express a state the type system forbids.
 */
function insertNode(overrides: NodeOverrides = {}): Promise<D1Result> {
  const row = {
    citation: 'title-1/chapter-I/part-1',
    word_count: null as number | null,
    word_count_status: 'not_computed',
    word_count_method: null as string | null,
    word_count_reason: 'no sync run has reached this node',
    ...overrides,
  };
  return db
    .prepare(
      `INSERT INTO structure_node
         (citation, title_number, node_type, word_count, word_count_status,
          word_count_method, word_count_reason, last_seen_run_id)
       VALUES (?, 1, 'part', ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.citation,
      row.word_count,
      row.word_count_status,
      row.word_count_method,
      row.word_count_reason,
      RUN_ID,
    )
    .run();
}

describe('structure_node measurement constraints', () => {
  it('(a) rejects a number carrying an unknown status', async () => {
    await seedTitle();

    // This is the predecessor's bug expressed as a row: a count with no claim that anything
    // was measured. `substring(0, estimatedWords * 6)` produced exactly this shape.
    await expect(
      insertNode({
        word_count: 104_642,
        word_count_status: 'unavailable_parse_failed',
        word_count_reason: 'chapter subtree not found',
      }),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('(a2) rejects a number under every one of the four unknown statuses', async () => {
    await seedTitle();

    for (const status of UNKNOWN_STATUSES) {
      await expect(
        insertNode({
          citation: `title-1/chapter-I/part-${status}`,
          word_count: 1,
          word_count_status: status,
          word_count_reason: 'a reason',
        }),
      ).rejects.toThrow(/CHECK constraint failed/i);
    }
  });

  it('(b) rejects a known status with a NULL count', async () => {
    await seedTitle();

    for (const status of KNOWN_STATUSES) {
      await expect(
        insertNode({
          citation: `title-1/chapter-I/part-${status}`,
          word_count: null,
          word_count_status: status,
          word_count_method: 'xml_parse',
          word_count_reason: null,
        }),
      ).rejects.toThrow(/CHECK constraint failed/i);
    }
  });

  it('(c) rejects an unknown with no reason', async () => {
    await seedTitle();

    await expect(
      insertNode({
        word_count: null,
        word_count_status: 'unavailable_fetch_failed',
        word_count_reason: null,
      }),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('rejects a known count that also carries a reason', async () => {
    await seedTitle();

    // The symmetric half of (c). A row saying both "we measured 12" and "here is why we
    // could not measure it" is incoherent, and the constraint is an equality, not an
    // implication, precisely so neither direction is expressible.
    await expect(
      insertNode({
        word_count: 12,
        word_count_status: 'counted',
        word_count_method: 'xml_parse',
        word_count_reason: 'chapter subtree not found',
      }),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('rejects a negative count', async () => {
    await seedTitle();

    await expect(
      insertNode({
        word_count: -1,
        word_count_status: 'counted',
        word_count_method: 'xml_parse',
        word_count_reason: null,
      }),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('rejects a status the Measurement type does not define', async () => {
    await seedTitle();

    await expect(
      insertNode({
        word_count: 100,
        word_count_status: 'estimated',
        word_count_method: 'xml_parse',
        word_count_reason: null,
      }),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('rejects a method the CountMethod type does not define', async () => {
    await seedTitle();

    await expect(
      insertNode({
        word_count: 100,
        word_count_status: 'counted',
        word_count_method: 'proportional_estimate',
        word_count_reason: null,
      }),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });
});

describe('toRow() output is always storable', () => {
  /**
   * The complement of the rejection tests. A constraint that rejects everything would pass all
   * of the above, so the round trip has to be shown to work for every constructor the core
   * package offers — that is what proves the constraint is calibrated to the type and not
   * merely strict.
   */
  const cases: [string, Measurement][] = [
    ['counted', counted(1234)],
    ['rolled_up', rolledUp(5678)],
    ['reserved_empty', reservedEmpty()],
    ['not_computed', notComputed()],
    ['unavailable_fetch_failed', unavailable('unavailable_fetch_failed', 'eCFR returned 429')],
    ['unavailable_parse_failed', unavailable('unavailable_parse_failed', 'no DIV5 N="60"')],
    ['unavailable_too_large', unavailable('unavailable_too_large', '69,598,633 bytes')],
  ];

  it.each(cases)('stores a %s measurement', async (label, measurement) => {
    await seedTitle();
    const row = toRow(measurement);

    await insertNode({
      citation: `title-1/chapter-I/part-${label}`,
      word_count: row.word_count,
      word_count_status: row.word_count_status,
      word_count_method: row.word_count_method,
      word_count_reason: row.word_count_reason,
    });

    const stored = await db
      .prepare(
        `SELECT word_count, word_count_status, word_count_method, word_count_reason
         FROM structure_node WHERE citation = ?`,
      )
      .bind(`title-1/chapter-I/part-${label}`)
      .first();

    expect(stored).toEqual(row);
  });

  it('covers every declared status, so a new one cannot be added untested', () => {
    // WORD_COUNT_STATUSES is the vocabulary the CHECK constraint duplicates. If someone adds a
    // variant and writes the migration but not the test, this fails rather than leaving the
    // new status silently unexercised.
    const exercised = new Set(cases.map(([label]) => label));
    // `stale` is the one status no constructor produces — it is written by the recount
    // scheduler when it invalidates a previously counted node, not by a measurement.
    exercised.add('stale');
    expect([...WORD_COUNT_STATUSES].sort()).toEqual([...exercised].sort());
  });

  it("accepts 'stale' with a count, since it is a previously measured number", async () => {
    await seedTitle();
    await insertNode({
      word_count: 4242,
      word_count_status: 'stale',
      word_count_method: 'xml_parse',
      word_count_reason: null,
    });
    const stored = await db
      .prepare(`SELECT word_count FROM structure_node WHERE citation = ?`)
      .bind('title-1/chapter-I/part-1')
      .first<{ word_count: number }>();
    expect(stored?.word_count).toBe(4242);
  });
});

describe('the other constraints that encode a measured fact', () => {
  it('scope_overlap cannot hold a scope claimed by one agency', async () => {
    // `agency_count > 1` is what stops the shared-jurisdiction page listing 470 scopes that
    // are not shared. 17 of 487 are; the rest have no business in this table.
    await expect(
      db
        .prepare(
          `INSERT INTO scope_overlap (ref_key, title_number, agency_count, agency_slugs, last_seen_run_id)
           VALUES ('title-42/chapter-I', 42, 1, '["ihs"]', 1)`,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('agency_rollup cannot claim more counted refs than it has', async () => {
    await db
      .prepare(
        `INSERT INTO agency (slug, name, display_name, sortable_name, last_seen_run_id)
         VALUES ('test-agency', 'Test', 'Test', 'Test', 1)`,
      )
      .run();

    await expect(
      db
        .prepare(
          `INSERT INTO agency_rollup (agency_slug, refs_total, refs_counted, coverage_pct, last_seen_run_id)
           VALUES ('test-agency', 3, 4, 1.0, 1)`,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('coverage_pct is a fraction, not a percentage', async () => {
    await db
      .prepare(
        `INSERT INTO agency (slug, name, display_name, sortable_name, last_seen_run_id)
         VALUES ('test-agency', 'Test', 'Test', 'Test', 1)`,
      )
      .run();

    // 100 instead of 1.0 is the classic version of this mistake and it renders as "10000%".
    await expect(
      db
        .prepare(
          `INSERT INTO agency_rollup (agency_slug, refs_total, refs_counted, coverage_pct, last_seen_run_id)
           VALUES ('test-agency', 4, 4, 100, 1)`,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('narrowest_level must be a real hierarchy level', async () => {
    await seedTitle();
    await db
      .prepare(
        `INSERT INTO agency (slug, name, display_name, sortable_name, last_seen_run_id)
         VALUES ('test-agency', 'Test', 'Test', 'Test', 1)`,
      )
      .run();

    await expect(
      db
        .prepare(
          `INSERT INTO agency_cfr_reference
             (agency_slug, ref_key, title_number, narrowest_level, last_seen_run_id)
           VALUES ('test-agency', 'title-1/chapter-I', 1, 'section', 1)`,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('one agency cannot hold two rows for the same scope', async () => {
    await seedTitle();
    await db
      .prepare(
        `INSERT INTO agency (slug, name, display_name, sortable_name, last_seen_run_id)
         VALUES ('flrb', 'FLRB', 'FLRB', 'FLRB', 1)`,
      )
      .run();

    const insert = (refKey: string) =>
      db
        .prepare(
          `INSERT INTO agency_cfr_reference
             (agency_slug, ref_key, title_number, narrowest_level, last_seen_run_id)
           VALUES ('flrb', ?, 1, 'chapter', 1)`,
        )
        .bind(refKey)
        .run();

    await insert('title-1/chapter-XIV');

    // The predecessor's unique index COALESCE'd the subchapter, so `{chapter:'XIV'}` and
    // `{chapter:'XIV', subchapter:''}` produced two rows for one scope and the agency was
    // credited twice. The fix is upstream — refKey() normalises both to the same string — and
    // this UNIQUE is what makes a regression a write failure rather than a wrong number.
    await expect(insert('title-1/chapter-XIV')).rejects.toThrow(/UNIQUE constraint failed/i);
  });
});
