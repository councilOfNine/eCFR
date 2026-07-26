/**
 * Test bindings and a small, deliberately unrealistic corpus.
 *
 * The seed data is chosen to exercise the honesty rules rather than to look like the real
 * CFR: one agency with a complete rollup, one with a NULL rollup (must render as "unknown",
 * never as zero), one shared scope with two claimants, and one CFR reference that resolves to
 * nothing (must render as "cannot measure", never as zero).
 */

import type { Env, RateLimitBinding } from '../../src/env.js';
import { createTestDb, type TestDb } from './d1.js';

/** In-memory R2, implementing only what the diff memo uses. */
export class FakeR2 {
  readonly objects = new Map<string, string>();
  putCount = 0;
  getCount = 0;

  // Backed by a Map, so nothing here has anything to await; the promises exist because that is
  // the R2 surface the Worker codes against.
  get(key: string): Promise<R2ObjectBody | null> {
    this.getCount++;
    const value = this.objects.get(key);
    if (value === undefined) return Promise.resolve(null);
    return Promise.resolve({
      json: <T>(): Promise<T> => Promise.resolve(JSON.parse(value) as T),
      text: (): Promise<string> => Promise.resolve(value),
    } as unknown as R2ObjectBody);
  }

  put(key: string, value: string): Promise<R2Object> {
    this.putCount++;
    this.objects.set(key, value);
    return Promise.resolve({ key } as unknown as R2Object);
  }
}

/** A rate-limit binding that allows `allowance` calls per key, then refuses. */
export class FakeRateLimit implements RateLimitBinding {
  private readonly seen = new Map<string, number>();
  constructor(private readonly allowance = 1_000_000) {}

  limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const used = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, used);
    return Promise.resolve({ success: used <= this.allowance });
  }
}

export interface TestHarness {
  env: Env;
  db: TestDb;
  bucket: FakeR2;
  burstAnon: FakeRateLimit;
  ctx: ExecutionContext;
  close(): void;
}

export function createHarness(options: { anonBurst?: number } = {}): TestHarness {
  const db = createTestDb();
  const bucket = new FakeR2();
  const burstAnon = new FakeRateLimit(options.anonBurst ?? 1_000_000);

  const env: Env = {
    DB: db.d1,
    CONTENT: bucket as unknown as R2Bucket,
    BURST_ANON: burstAnon,
    BURST_REGISTERED: new FakeRateLimit(),
    BURST_ELEVATED: new FakeRateLimit(),
    ENVIRONMENT: 'test',
    SITE_ORIGIN: 'https://ecfr-atlas.test',
    PUBLIC_CONTENT_BASE_URL: 'https://content.ecfr-atlas.test',
    ECFR_USER_AGENT: 'ecfr-atlas-test/0.1 (+https://example.test)',
    DOCS_URL: 'https://api.ecfr-atlas.test/docs',
    // Long enough to clear the MIN_ANON_SALT_LENGTH floor in src/auth/quota.ts, so the tests
    // exercise the same code path production does rather than the failure branch.
    ANON_SALT: 'test-salt-not-a-secret-but-long-enough',
  };

  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      void promise.catch(() => undefined);
    },
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;

  return { env, db, bucket, burstAnon, ctx, close: () => db.close() };
}

/**
 * Seed a corpus small enough to reason about and shaped to break naive code.
 *
 * Deliberate features:
 *   - `ghost-agency` has NO agency_rollup row at all -> both totals must be unknown.
 *   - `partial-agency` has a rollup with NULL word counts and coverage 0.5 -> unknown, with a
 *     reason naming the uncounted scopes.
 *   - `title-40/chapter-I` is claimed by two agencies -> a scope_overlap row exists.
 *   - `ghost-agency`'s reference resolves to no node -> "cannot measure", not zero.
 *   - Title 35 is reserved with all three dates NULL, as in the real data.
 */
export function seed(db: TestDb): void {
  const run = (sql: string, ...params: unknown[]): void => {
    db.raw.prepare(sql).run(...(params as never[]));
  };

  run(
    `INSERT INTO sync_run (id, kind, status, started_at, finished_at, source_date,
                           titles_touched, nodes_upserted, nodes_pruned, fetch_failures, parse_failures)
     VALUES (1, 'backfill', 'succeeded', '2026-07-20T02:00:00Z', '2026-07-20T02:41:00Z', '2026-07-17', 49, 275271, 0, 0, 0)`,
  );
  run(
    `UPDATE app_meta SET published_run_id = 1, published_at = '2026-07-20T02:45:00Z', source_date = '2026-07-17'`,
  );

  run(
    `INSERT INTO title (number, name, latest_amended_on, latest_issue_date, up_to_date_as_of, reserved, last_seen_run_id)
     VALUES (40, 'Protection of Environment', '2026-07-15', '2026-07-17', '2026-07-17', 0, 1)`,
  );
  run(
    `INSERT INTO title (number, name, latest_amended_on, latest_issue_date, up_to_date_as_of, reserved, last_seen_run_id)
     VALUES (42, 'Public Health', '2026-07-14', '2026-07-17', '2026-07-17', 0, 1)`,
  );
  // Title 35 is reserved and all three date fields are null upstream. Anything that formats a
  // date without null-guarding breaks here and nowhere else.
  run(
    `INSERT INTO title (number, name, latest_amended_on, latest_issue_date, up_to_date_as_of, reserved, last_seen_run_id)
     VALUES (35, 'Reserved', NULL, NULL, NULL, 1, 1)`,
  );

  const node = (
    citation: string,
    parent: string | null,
    title: number,
    type: string,
    identifier: string | null,
    label: string,
    words: number | null,
    status: string,
    method: string | null,
    reason: string | null,
    extra: { chapter?: string; part?: string; contentKey?: string } = {},
  ): void => {
    run(
      `INSERT INTO structure_node
         (citation, parent_citation, title_number, node_type, identifier, label, reserved,
          chapter_id, part_id, xml_bytes, content_key,
          word_count, word_count_status, word_count_method, word_count_reason, last_seen_run_id)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 1000, ?, ?, ?, ?, ?, 1)`,
      citation,
      parent,
      title,
      type,
      identifier,
      label,
      extra.chapter ?? null,
      extra.part ?? null,
      extra.contentKey ?? null,
      words,
      status,
      method,
      reason,
    );
  };

  node(
    'title-40',
    null,
    40,
    'title',
    '40',
    'Protection of Environment',
    500,
    'rolled_up',
    'descendant_sum',
    null,
  );
  node(
    'title-40/chapter-I',
    'title-40',
    40,
    'chapter',
    'I',
    'Environmental Protection Agency',
    300,
    'rolled_up',
    'descendant_sum',
    null,
    { chapter: 'I' },
  );
  node(
    'title-40/chapter-I/part-60',
    'title-40/chapter-I',
    40,
    'part',
    '60',
    'Standards of Performance',
    300,
    'counted',
    'xml_parse',
    null,
    { chapter: 'I', part: '60', contentKey: 'parts/40-60.html' },
  );
  node(
    'title-40/chapter-I/part-60/section-60.1',
    'title-40/chapter-I/part-60',
    40,
    'section',
    '60.1',
    'Applicability',
    120,
    'counted',
    'xml_parse',
    null,
    { chapter: 'I', part: '60' },
  );
  // An unmeasured node: the /data-quality ledger and every rollup above it must reflect this.
  node(
    'title-42',
    null,
    42,
    'title',
    '42',
    'Public Health',
    null,
    'unavailable_fetch_failed',
    null,
    'eCFR returned 429 after the retry budget',
  );
  node(
    'title-42/chapter-I',
    'title-42',
    42,
    'chapter',
    'I',
    'Indian Health Service / PHS',
    null,
    'unavailable_fetch_failed',
    null,
    'parent title was not fetched',
    { chapter: 'I' },
  );

  const agency = (
    slug: string,
    name: string,
    display: string,
    sortable: string,
    parent: string | null,
    depth: number,
  ): void => {
    run(
      `INSERT INTO agency (slug, name, short_name, display_name, sortable_name, parent_slug, depth, last_seen_run_id)
       VALUES (?, ?, NULL, ?, ?, ?, ?, 1)`,
      slug,
      name,
      display,
      sortable,
      parent,
      depth,
    );
  };

  agency(
    'environmental-protection-agency',
    'Environmental Protection Agency',
    'Environmental Protection Agency',
    'environmental protection agency',
    null,
    0,
  );
  agency(
    'indian-health-service',
    'Indian Health Service',
    'Indian Health Service',
    'indian health service',
    null,
    0,
  );
  agency(
    'public-health-service',
    'Public Health Service',
    'Public Health Service',
    'public health service',
    null,
    0,
  );
  agency('ghost-agency', 'Ghost Agency', 'Ghost Agency', 'ghost agency', null, 0);

  const ref = (
    slug: string,
    refKey: string,
    title: number,
    level: string,
    chapter: string | null,
    part: string | null,
    nodeCitation: string | null,
  ): void => {
    run(
      `INSERT INTO agency_cfr_reference
         (agency_slug, ref_key, title_number, narrowest_level, chapter_id, part_id, node_citation, last_seen_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      slug,
      refKey,
      title,
      level,
      chapter,
      part,
      nodeCitation,
    );
  };

  ref(
    'environmental-protection-agency',
    'title-40/chapter-I',
    40,
    'chapter',
    'I',
    null,
    'title-40/chapter-I',
  );
  ref(
    'indian-health-service',
    'title-42/chapter-I',
    42,
    'chapter',
    'I',
    null,
    'title-42/chapter-I',
  );
  ref(
    'public-health-service',
    'title-42/chapter-I',
    42,
    'chapter',
    'I',
    null,
    'title-42/chapter-I',
  );
  // Points at a scope that is not in the current structure — eCFR keeps these.
  ref('ghost-agency', 'title-40/chapter-XX', 40, 'chapter', 'XX', null, null);

  run(
    `INSERT INTO scope_overlap (ref_key, title_number, agency_count, agency_slugs, word_count, last_seen_run_id)
     VALUES ('title-42/chapter-I', 42, 2, '["indian-health-service","public-health-service"]', NULL, 1)`,
  );

  run(
    `INSERT INTO agency_rollup
       (agency_slug, attributed_word_count, deduplicated_word_count, subtree_attributed, subtree_deduplicated,
        refs_total, refs_counted, shared_refs, children_count, coverage_pct, last_seen_run_id)
     VALUES ('environmental-protection-agency', 300, 300, 300, 300, 1, 1, 0, 0, 1.0, 1)`,
  );
  // NULL counts with partial coverage: the API must say "unknown", with a reason, not 0.
  run(
    `INSERT INTO agency_rollup
       (agency_slug, attributed_word_count, deduplicated_word_count, subtree_attributed, subtree_deduplicated,
        refs_total, refs_counted, shared_refs, children_count, coverage_pct, last_seen_run_id)
     VALUES ('indian-health-service', NULL, NULL, NULL, NULL, 1, 0, 1, 0, 0.0, 1)`,
  );
  run(
    `INSERT INTO agency_rollup
       (agency_slug, attributed_word_count, deduplicated_word_count, subtree_attributed, subtree_deduplicated,
        refs_total, refs_counted, shared_refs, children_count, coverage_pct, last_seen_run_id)
     VALUES ('public-health-service', NULL, NULL, NULL, NULL, 1, 0, 1, 0, 0.0, 1)`,
  );
  // ghost-agency intentionally has NO rollup row at all.

  run(
    `INSERT INTO agency_snapshot (agency_slug, snapshot_date, run_id, attributed_word_count, deduplicated_word_count, coverage_pct)
     VALUES ('environmental-protection-agency', '2026-07-17', 1, 300, 300, 1.0)`,
  );

  run(
    `INSERT INTO amendment (title_number, section_identifier, amendment_date, issue_date, part, subpart, name, removed, substantive, last_seen_run_id)
     VALUES (40, '60.1', '2026-05-01', '2026-07-17', '60', NULL, 'Applicability', 0, 1, 1)`,
  );
  // amendment_date != issue_date, as in 49.7% of the real rows.
  run(
    `INSERT INTO amendment (title_number, section_identifier, amendment_date, issue_date, part, subpart, name, removed, substantive, last_seen_run_id)
     VALUES (40, '60.1', '2016-03-02', '2026-03-02', '60', NULL, 'Applicability', 0, 1, 1)`,
  );
}
