/**
 * The corpus aggregates must be driven from the POPULATION table, not from the aggregate's own
 * table.
 *
 * This is the project's founding bug in the position where it does the most damage: the public
 * API's headline corpus figure. `agency_rollup` has no row for an agency until a sync computes
 * one, and `structure_node` has no title node for a title that was never synced. Aggregating
 * over those tables alone means the absent contributor is invisible to BOTH the sum and the
 * `IS NULL` counter, so the figure publishes short while reporting itself complete — which is
 * exactly the failure mode this codebase exists to make impossible.
 *
 * The shared seed cannot catch it on its own: it also contains agencies with NULL rollups, and
 * those would make the total unknown even with the broken query. Each case below therefore
 * isolates the missing ROW as the only source of unknown-ness, so a regression cannot hide
 * behind an unrelated NULL.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCorpusCounts } from '../src/db/meta.js';
import { createTestDb, type TestDb } from './helpers/d1.js';

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
  db.raw.exec(
    `INSERT INTO sync_run (id, kind, status, started_at)
     VALUES (1, 'backfill', 'succeeded', '2026-07-20T02:00:00Z')`,
  );
});

afterEach(() => {
  db.close();
});

function addAgency(slug: string, words: number | null, withRollupRow: boolean): void {
  db.raw
    .prepare(
      `INSERT INTO agency (slug, name, display_name, sortable_name, depth, last_seen_run_id)
       VALUES (?, ?, ?, ?, 0, 1)`,
    )
    .run(slug, slug, slug, slug);
  if (!withRollupRow) return;
  db.raw
    .prepare(
      `INSERT INTO agency_rollup
         (agency_slug, attributed_word_count, deduplicated_word_count, last_seen_run_id)
       VALUES (?, ?, ?, 1)`,
    )
    .run(slug, words, words);
}

function addTitle(number: number, words: number | null, withNode: boolean): void {
  db.raw
    .prepare(`INSERT INTO title (number, name, last_seen_run_id) VALUES (?, ?, 1)`)
    .run(number, `title ${number}`);
  if (!withNode) return;
  db.raw
    .prepare(
      `INSERT INTO structure_node
         (citation, title_number, node_type, identifier,
          word_count, word_count_status, word_count_method, last_seen_run_id)
       VALUES (?, ?, 'title', ?, ?, ?, ?, 1)`,
    )
    .run(
      `title-${number}`,
      number,
      String(number),
      words,
      words === null ? 'not_computed' : 'rolled_up',
      words === null ? null : 'descendant_sum',
    );
}

describe('getCorpusCounts', () => {
  it('refuses the attributed total when an agency has NO agency_rollup row', async () => {
    // Every rollup row present is fully measured, so the ONLY defect is the missing row. The
    // pre-fix query returned {attributed: 300, attributed_unknown: 0} here and published 300
    // as a measured fact.
    addAgency('a', 100, true);
    addAgency('b', 200, true);
    addAgency('ghost', null, false);

    const counts = await getCorpusCounts(db.d1);

    expect(counts.agencies).toBe(3);
    expect(counts.attributed_unknown).toBe(1);
    expect(counts.attributed_words).toBeNull();
    expect(counts.attributed_words).not.toBe(300);
    expect(counts.deduplicated_unknown).toBe(1);
    expect(counts.deduplicated_words).toBeNull();
  });

  it('states the attributed total when every agency has a measured rollup', async () => {
    // The other half of the calibration: a guard that also refuses complete data is useless.
    addAgency('a', 100, true);
    addAgency('b', 200, true);

    const counts = await getCorpusCounts(db.d1);

    expect(counts.attributed_unknown).toBe(0);
    expect(counts.attributed_words).toBe(300);
    expect(counts.deduplicated_words).toBe(300);
  });

  it('refuses the corpus total when a title has NO structure_node row', async () => {
    // `corpus_titles_unknown` is reported to readers as "N of {corpus.titles} titles", and
    // `corpus.titles` counts the `title` table. Aggregating the sum over `structure_node`
    // instead left the numerator and the denominator measuring different populations, so an
    // unsynced title vanished from both the sum and the counter.
    addTitle(1, 10, true);
    addTitle(2, 20, true);
    addTitle(3, null, false);

    const counts = await getCorpusCounts(db.d1);

    expect(counts.titles).toBe(3);
    expect(counts.corpus_titles_unknown).toBe(1);
    expect(counts.corpus_words).toBeNull();
    expect(counts.corpus_words).not.toBe(30);
  });

  it('states the corpus total when every title has a measured node', async () => {
    addTitle(1, 10, true);
    addTitle(2, 20, true);

    const counts = await getCorpusCounts(db.d1);

    expect(counts.corpus_titles_unknown).toBe(0);
    expect(counts.corpus_words).toBe(30);
  });
});
