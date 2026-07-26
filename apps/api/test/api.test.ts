/**
 * End-to-end route tests against the real migrations.
 *
 * These run the actual Hono app with the actual SQL against a node:sqlite database created
 * from packages/db/migrations. What they are checking, above everything else, is that no
 * response ever presents "we could not measure this" as a number — and that the quota and key
 * machinery is enforced rather than merely present.
 */

import type { WordCount } from '@ecfr-atlas/core/api-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { rateLimitHeaders } from '../src/auth/quota.js';
import { TIERS } from '../src/constants/config.js';
import app from '../src/index.js';
import { DATA_EXPOSED_HEADERS } from '../src/middleware/headers.js';
import { createHarness, seed, type TestHarness } from './helpers/env.js';

let harness: TestHarness;

beforeEach(() => {
  harness?.close();
  harness = createHarness();
  seed(harness.db);
});

async function get(path: string, init: RequestInit = {}): Promise<Response> {
  return app.fetch(
    new Request(`https://api.test${path}`, {
      ...init,
      headers: { 'cf-connecting-ip': '203.0.113.7', ...(init.headers ?? {}) },
    }),
    harness.env,
    harness.ctx,
  );
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Every assertion about a word count goes through this, so the rule is stated once. */
function expectUnknown(count: WordCount, reasonPattern?: RegExp): void {
  expect(count.words).toBeNull();
  expect(count.words).not.toBe(0);
  expect(count.reason).toBeTruthy();
  if (reasonPattern) expect(count.reason).toMatch(reasonPattern);
}

describe('service endpoints', () => {
  it('serves the OpenAPI spec with every route documented', async () => {
    const response = await get('/openapi.json');
    expect(response.status).toBe(200);

    const spec = await json<{
      openapi: string;
      paths: Record<string, unknown>;
      components?: { securitySchemes?: Record<string, unknown> };
      security?: unknown[];
    }>(response);

    expect(spec.openapi).toBe('3.1.0');
    for (const path of [
      '/v1/meta',
      '/v1/agencies',
      '/v1/agencies/{slug}',
      '/v1/titles',
      '/v1/titles/{n}/structure',
      '/v1/parts/{citation}',
      '/v1/search',
      '/v1/overlap',
      '/v1/amendments',
      '/v1/word-counts',
      '/v1/diff',
      '/v1/account/register',
      '/v1/account/verify',
      '/v1/account/keys',
      '/v1/account/keys/{id}',
    ]) {
      expect(Object.keys(spec.paths), path).toContain(path);
    }

    expect(spec.components?.securitySchemes).toHaveProperty('ApiKeyAuth');
    // The empty requirement is what tells a docs renderer that anonymous access works.
    expect(spec.security).toContainEqual({});
  });

  it('renders docs with a CSP that does not allow arbitrary script', async () => {
    const response = await get('/docs');
    expect(response.status).toBe(200);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('answers /health without touching the database', async () => {
    harness.db.raw.exec('DROP TABLE app_meta');
    const response = await get('/health');
    expect(response.status).toBe(200);
  });

  it('returns the standard error envelope for an unknown route', async () => {
    const response = await get('/v1/nope');
    expect(response.status).toBe(404);
    const body = await json<{ error: { code: string; request_id: string } }>(response);
    expect(body.error.code).toBe('not_found');
    expect(body.error.request_id).toBeTruthy();
    expect(response.headers.get('x-request-id')).toBe(body.error.request_id);
  });
});

describe('GET /v1/meta', () => {
  it('reports the published run, source date and corpus counters', async () => {
    const response = await get('/v1/meta');
    expect(response.status).toBe(200);

    const body = await json<{
      published_run_id: number;
      source_date: string;
      corpus: {
        agencies: number;
        titles: number;
        titles_reserved: number;
        total_words: WordCount;
        unknown_by_status: Record<string, number>;
      };
      last_run: { id: number; status: string } | null;
      tiers: { tier: string; daily_quota: number }[];
    }>(response);

    expect(body.published_run_id).toBe(1);
    expect(body.source_date).toBe('2026-07-17');
    expect(body.corpus.agencies).toBe(4);
    expect(body.corpus.titles).toBe(3);
    expect(body.corpus.titles_reserved).toBe(1);
    expect(body.last_run?.status).toBe('succeeded');
    expect(body.tiers.map((t) => t.tier)).toEqual(['anonymous', 'registered', 'elevated']);

    // Title 42 is unmeasured, so the corpus total is NOT a number. A partial sum here would
    // be the original bug in its purest form.
    expectUnknown(body.corpus.total_words, /1 of 3 titles/);
    expect(body.corpus.unknown_by_status.unavailable_fetch_failed).toBe(2);
  });

  it('stamps eCFR provenance on the response headers', async () => {
    const response = await get('/v1/meta');
    expect(response.headers.get('x-ecfr-source-date')).toBe('2026-07-17');
    expect(response.headers.get('x-ecfr-published-run')).toBe('1');
    expect(response.headers.get('x-ecfr-source')).toBe('https://www.ecfr.gov');
  });

  /**
   * Setting a header and letting a browser READ it are two different things, and the gap is
   * silent: an unexposed header is present on the wire, so it looks right in curl and in the
   * Network tab, and only a cross-origin fetch() sees nothing. `X-Ecfr-Source` shipped that
   * way — stamped on every data response for citation, unreadable by the callers who most
   * need to cite it.
   *
   * So this drives a real response and checks the exposure list against what the middleware
   * actually set, rather than against a second hand-maintained list of what it ought to set.
   * A new header must either be exposed or be declared browser-directive below.
   */
  it('exposes every header it sets that is not already readable', async () => {
    const response = await get('/v1/meta', { headers: { origin: 'https://example.test' } });

    // Readable cross-origin without exposure (the CORS-safelisted response headers), plus
    // hop-by-hop/CORS plumbing, plus the headers that instruct the browser rather than inform
    // the caller — nothing in here is data a consumer would read.
    const alreadyReadableOrNotData = new Set([
      'cache-control',
      'content-language',
      'content-length',
      'content-type',
      'expires',
      'last-modified',
      'pragma',
      'date',
      'vary',
      'transfer-encoding',
      'connection',
      'access-control-allow-origin',
      'access-control-allow-methods',
      'access-control-allow-headers',
      'access-control-expose-headers',
      'access-control-max-age',
      'x-content-type-options',
      'x-frame-options',
      'referrer-policy',
      'cross-origin-opener-policy',
      'cross-origin-resource-policy',
      'permissions-policy',
      'strict-transport-security',
      'content-security-policy',
    ]);

    const exposed = new Set(DATA_EXPOSED_HEADERS.map((h) => h.toLowerCase()));
    const unreadable = [...response.headers.keys()].filter(
      (name) => !alreadyReadableOrNotData.has(name) && !exposed.has(name),
    );

    expect(unreadable, 'set on the response but invisible to cross-origin JavaScript').toEqual([]);

    // And the advertised list is the one the middleware actually sent, not a stale constant.
    const advertised = (response.headers.get('access-control-expose-headers') ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    expect(new Set(advertised)).toEqual(exposed);
  });

  /**
   * The 429 path builds its headers by hand, so it is the one place a RateLimit header can be
   * introduced without going through the middleware this suite exercises.
   */
  it('exposes every RateLimit header the quota helper produces', () => {
    const exposed = new Set(DATA_EXPOSED_HEADERS.map((h) => h.toLowerCase()));
    const produced = Object.keys(
      rateLimitHeaders({ tier: 'anonymous', limit: 100, remaining: 0, reset: 1_800_000_000 }),
    );
    expect(produced.length).toBeGreaterThan(0);
    for (const name of produced) {
      expect(exposed, `${name} is returned by rateLimitHeaders() but not exposed`).toContain(
        name.toLowerCase(),
      );
    }
  });
});

describe('GET /v1/agencies', () => {
  it('publishes both totals with coverage, and never a bare number', async () => {
    const response = await get('/v1/agencies?sort=name');
    expect(response.status).toBe(200);

    const body = await json<{
      data: {
        slug: string;
        attributed: WordCount;
        deduplicated: WordCount;
        coverage: { refs_total: number; refs_counted: number; pct: number };
      }[];
      page: { total: number };
    }>(response);

    expect(body.page.total).toBe(4);
    for (const row of body.data) {
      for (const key of ['attributed', 'deduplicated'] as const) {
        expect(row[key], `${row.slug}.${key}`).toHaveProperty('status');
        expect(row[key], `${row.slug}.${key}`).toHaveProperty('reason');
        expect(typeof row[key].words === 'number' || row[key].words === null).toBe(true);
      }
    }

    const epa = body.data.find((r) => r.slug === 'environmental-protection-agency');
    expect(epa?.deduplicated.words).toBe(300);
    expect(epa?.deduplicated.status).toBe('rolled_up');
    expect(epa?.coverage.pct).toBe(1);
  });

  it('reports an agency with NULL rollup counts as unknown, with the uncounted scopes named', async () => {
    const body = await json<{ data: { slug: string; attributed: WordCount }[] }>(
      await get('/v1/agencies?q=indian'),
    );
    const ihs = body.data.find((r) => r.slug === 'indian-health-service');
    expect(ihs).toBeDefined();
    expectUnknown(ihs?.attributed as WordCount, /1 of 1 claimed scopes/);
  });

  it('reports an agency with NO rollup row at all as unknown, not as zero', async () => {
    const body = await json<{ data: { slug: string; deduplicated: WordCount }[] }>(
      await get('/v1/agencies?q=ghost'),
    );
    const ghost = body.data.find((r) => r.slug === 'ghost-agency');
    expect(ghost).toBeDefined();
    expectUnknown(ghost?.deduplicated as WordCount);
  });

  it('filters by title using the reference table', async () => {
    const body = await json<{ data: { slug: string }[] }>(await get('/v1/agencies?title=42'));
    expect(body.data.map((r) => r.slug).sort()).toEqual([
      'indian-health-service',
      'public-health-service',
    ]);
  });

  it('treats a LIKE metacharacter in the query as literal text', async () => {
    const body = await json<{ page: { total: number } }>(await get('/v1/agencies?q=%25'));
    expect(body.page.total).toBe(0);
  });

  it('clamps the page size to the tier ceiling rather than rejecting', async () => {
    const body = await json<{ page: { limit: number } }>(await get('/v1/agencies?limit=500'));
    expect(body.page.limit).toBe(TIERS.anonymous.maxPageSize);
  });

  it('rejects an out-of-range page size with the standard error envelope', async () => {
    const response = await get('/v1/agencies?limit=99999');
    expect(response.status).toBe(400);
    const body = await json<{ error: { code: string; details: { issues: unknown[] } } }>(response);
    expect(body.error.code).toBe('bad_request');
    expect(body.error.details.issues.length).toBeGreaterThan(0);
  });
});

describe('GET /v1/agencies/{slug}', () => {
  it('surfaces shared jurisdiction with co-claimant names', async () => {
    const response = await get('/v1/agencies/indian-health-service');
    expect(response.status).toBe(200);

    const body = await json<{
      scopes: {
        ref_key: string;
        display: string;
        narrowest_level: string;
        word_count: WordCount;
      }[];
      shared_jurisdiction: {
        ref_key: string;
        display: string;
        agencies: { slug: string; name: string }[];
      }[];
    }>(response);

    expect(body.scopes).toHaveLength(1);
    expect(body.scopes[0]?.display).toBe('42 CFR Chapter I');
    expect(body.scopes[0]?.narrowest_level).toBe('chapter');

    expect(body.shared_jurisdiction).toHaveLength(1);
    expect(body.shared_jurisdiction[0]?.agencies.map((a) => a.slug).sort()).toEqual([
      'indian-health-service',
      'public-health-service',
    ]);
    expect(
      body.shared_jurisdiction[0]?.agencies.find((a) => a.slug === 'public-health-service')?.name,
    ).toBe('Public Health Service');
  });

  it('reports an unresolvable scope as unmeasurable rather than as zero', async () => {
    const body = await json<{ scopes: { ref_key: string; word_count: WordCount }[] }>(
      await get('/v1/agencies/ghost-agency'),
    );
    const scope = body.scopes[0];
    expect(scope?.ref_key).toBe('title-40/chapter-XX');
    expectUnknown(scope?.word_count as WordCount, /does not resolve to a node/);
  });

  it('404s with a pointer to search', async () => {
    const response = await get('/v1/agencies/no-such-agency');
    expect(response.status).toBe(404);
    expect((await json<{ error: { message: string } }>(response)).error.message).toMatch(
      /v1\/search/,
    );
  });
});

describe('GET /v1/titles', () => {
  it('returns null dates for the reserved title without throwing', async () => {
    const body = await json<{
      data: {
        number: number;
        reserved: boolean;
        latest_amended_on: string | null;
        word_count: WordCount;
      }[];
    }>(await get('/v1/titles'));

    const reserved = body.data.find((t) => t.number === 35);
    expect(reserved?.reserved).toBe(true);
    expect(reserved?.latest_amended_on).toBeNull();

    const title42 = body.data.find((t) => t.number === 42);
    expectUnknown(title42?.word_count as WordCount, /429/);
  });
});

describe('GET /v1/titles/{n}/structure', () => {
  it('builds the tree and excludes sections by default', async () => {
    const body = await json<{
      nodes: { citation: string; children: { citation: string; children: unknown[] }[] }[];
      node_count: number;
      truncated: boolean;
    }>(await get('/v1/titles/40/structure'));

    expect(body.truncated).toBe(false);
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0]?.citation).toBe('title-40');
    expect(body.nodes[0]?.children[0]?.citation).toBe('title-40/chapter-I');
    // The part is present; the section beneath it is not.
    expect(JSON.stringify(body.nodes)).not.toContain('section-60.1');
  });

  it('includes sections on request', async () => {
    const body = await json<{ node_count: number }>(
      await get('/v1/titles/40/structure?include_sections=true'),
    );
    expect(body.node_count).toBe(4);
  });

  it('scopes to a subtree and rejects a parent from another title', async () => {
    const scoped = await json<{ nodes: { citation: string }[] }>(
      await get('/v1/titles/40/structure?parent=title-40%2Fchapter-I'),
    );
    expect(scoped.nodes[0]?.citation).toBe('title-40/chapter-I');

    const wrong = await get('/v1/titles/42/structure?parent=title-40%2Fchapter-I');
    expect(wrong.status).toBe(404);
  });
});

describe('GET /v1/parts/{citation}', () => {
  it('resolves the compact citation and attributes agencies by containment', async () => {
    const response = await get('/v1/parts/40-60');
    expect(response.status).toBe(200);

    const body = await json<{
      citation: string;
      display: string;
      word_count: WordCount;
      sections_count: number;
      agencies: { slug: string }[];
      content: { key: string | null; url: string | null };
    }>(response);

    expect(body.citation).toBe('title-40/chapter-I/part-60');
    expect(body.display).toBe('40 CFR Part 60');
    expect(body.word_count.words).toBe(300);
    expect(body.sections_count).toBe(1);
    // EPA's reference is chapter-level; the part is beneath it, so containment must find it.
    expect(body.agencies.map((a) => a.slug)).toEqual(['environmental-protection-agency']);
    expect(body.content.key).toBe('parts/40-60.html');
    expect(body.content.url).toBe('https://content.ecfr-atlas.test/parts/40-60.html');
  });

  it('rejects a malformed citation before querying', async () => {
    expect((await get('/v1/parts/not-a-citation')).status).toBe(400);
    expect((await get('/v1/parts/40-99')).status).toBe(404);
  });
});

describe('GET /v1/search', () => {
  it('resolves a citation exactly and says how it read it', async () => {
    const body = await json<{
      interpreted_as: { title: number; part: string | null };
      data: { kind: string; id: string; display: string }[];
    }>(await get('/v1/search?q=40%20CFR%20Part%2060'));

    expect(body.interpreted_as?.title).toBe(40);
    expect(body.interpreted_as?.part).toBe('60');
    expect(body.data[0]?.kind).toBe('part');
    expect(body.data[0]?.id).toBe('title-40/chapter-I/part-60');
  });

  it('falls back to a name search', async () => {
    const body = await json<{ interpreted_as: unknown; data: { kind: string; id: string }[] }>(
      await get('/v1/search?q=Environmental'),
    );
    expect(body.interpreted_as).toBeNull();
    expect(body.data.some((h) => h.id === 'environmental-protection-agency')).toBe(true);
  });
});

interface OverlapRow {
  ref_key: string;
  display: string;
  agency_count: number;
  agencies: { slug: string; display_name: string; share: WordCount }[];
  word_count: WordCount;
}

describe('GET /v1/overlap', () => {
  it('lists the shared scope and refuses to invent a share of an unknown', async () => {
    const body = await json<{ data: OverlapRow[] }>(await get('/v1/overlap'));

    expect(body.data).toHaveLength(1);
    const row = body.data[0];
    expect(row?.display).toBe('42 CFR Chapter I');
    expect(row?.agency_count).toBe(2);
    expect(row?.agencies.map((a) => a.display_name).sort()).toEqual([
      'Indian Health Service',
      'Public Health Service',
    ]);
    expectUnknown(row?.word_count as WordCount);

    // A share of an unknown is an unknown, not zero — and it arrives as a full measurement
    // envelope with a reason, like every other count in this API, rather than a bare float.
    expect(row?.agencies).toHaveLength(2);
    for (const agency of row?.agencies ?? []) {
      expectUnknown(agency.share);
      expect(agency.share.reason).toMatch(/share of an unknown is an unknown/);
    }
  });

  it('publishes shares that sum to exactly the scope, remainder and all', async () => {
    // The predecessor's arithmetic did not reconcile: it published `words / agencyCount` as a
    // bare float while the stored deduplicated totals used floor-plus-remainder. Anyone who
    // summed the published shares got a number that disagreed with the published totals.
    //
    // 301 words over 2 claimants is 151 + 150 — deliberately odd, so an even-division bug
    // cannot pass.
    harness.db.raw
      .prepare(`UPDATE scope_overlap SET word_count = 301 WHERE ref_key = 'title-42/chapter-I'`)
      .run();

    const body = await json<{ data: OverlapRow[] }>(await get('/v1/overlap'));
    const row = body.data[0] as OverlapRow;

    expect(row.word_count.words).toBe(301);
    const shares = row.agencies.map((a) => a.share);
    for (const share of shares) {
      // Arithmetic over a measured value, never a fresh observation.
      expect(share.status).toBe('rolled_up');
      expect(share.method).toBe('descendant_sum');
      expect(Number.isInteger(share.words)).toBe(true);
    }
    expect(shares.map((s) => s.words)).toEqual([151, 150]);
    expect(shares.reduce((sum, s) => sum + (s.words ?? 0), 0)).toBe(301);

    // The remainder word goes to the first claimant in canonical order, which is the order
    // `agency_slugs` is stored in — not to whoever happens to sort first by slug here.
    expect(row.agencies[0]?.slug).toBe('indian-health-service');
  });

  it('attributes nothing when the claimant list and the count disagree', async () => {
    // Shares are positional, so a corrupt `agency_slugs` makes the mapping from share to
    // agency unknowable. Publishing a confidently-attributed wrong number is the failure this
    // codebase exists to prevent; every share becomes unknown, with the discrepancy named.
    harness.db.raw
      .prepare(
        `UPDATE scope_overlap SET word_count = 300, agency_count = 3
          WHERE ref_key = 'title-42/chapter-I'`,
      )
      .run();

    const body = await json<{ data: OverlapRow[] }>(await get('/v1/overlap'));
    const row = body.data[0] as OverlapRow;

    expect(row.word_count.words).toBe(300);
    for (const agency of row.agencies) {
      expectUnknown(agency.share);
      expect(agency.share.reason).toMatch(/3 claimants but names 2/);
    }
  });
});

describe('GET /v1/amendments', () => {
  it('filters on issue_date and offers a diff link only when one can work', async () => {
    const body = await json<{
      data: { issue_date: string; amendment_date: string; diff_url: string | null }[];
      page: { total: number };
    }>(await get('/v1/amendments?title=40&section=60.1'));

    expect(body.page.total).toBe(2);
    // Newest first.
    expect(body.data[0]?.issue_date).toBe('2026-07-17');
    // The row's amendment_date predates the full-text horizon; the issue_date does not, and
    // the diff link is built from the issue dates.
    expect(body.data[1]?.amendment_date).toBe('2016-03-02');
    expect(body.data[0]?.diff_url).toContain('from=2026-03-02');
    expect(body.data[0]?.diff_url).toContain('to=2026-07-17');
  });

  it('rejects an inverted date range', async () => {
    const response = await get(
      '/v1/amendments?issue_date_from=2026-07-17&issue_date_to=2026-01-01',
    );
    expect(response.status).toBe(400);
  });

  it('respects the issue-date window', async () => {
    const body = await json<{ page: { total: number } }>(
      await get('/v1/amendments?issue_date_from=2026-07-01'),
    );
    expect(body.page.total).toBe(1);
  });
});

describe('GET /v1/word-counts', () => {
  it('publishes both totals per row plus honest corpus totals', async () => {
    const body = await json<{
      data: {
        id: string;
        attributed: WordCount;
        deduplicated: WordCount;
        coverage: { pct: number };
      }[];
      totals: { corpus: WordCount; attributed: WordCount; deduplicated: WordCount };
    }>(await get('/v1/word-counts'));

    // Title 42 is unmeasured, and two of the four agencies have NULL rollups.
    expectUnknown(body.totals.corpus);
    expectUnknown(body.totals.attributed);
    expectUnknown(body.totals.deduplicated);

    for (const row of body.data) {
      expect(row.attributed).toHaveProperty('status');
      expect(row.deduplicated).toHaveProperty('status');
    }
  });

  it('groups by title on request', async () => {
    const body = await json<{ data: { group: string; id: string; attributed: WordCount }[] }>(
      await get('/v1/word-counts?group=title'),
    );
    expect(body.data.every((r) => r.group === 'title')).toBe(true);
    const title42 = body.data.find((r) => r.id === '42');
    expectUnknown(title42?.attributed as WordCount);
  });
});

describe('GET /v1/diff', () => {
  it('rejects a section identifier outside the allowlist', async () => {
    const response = await get(
      '/v1/diff?title=40&section=..%2F..%2Fetc&from=2026-03-02&to=2026-07-17',
    );
    expect(response.status).toBe(400);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe('bad_request');
  });

  it('rejects a `from` before the full-text horizon rather than reporting "added"', async () => {
    const response = await get('/v1/diff?title=40&section=60.1&from=2016-01-01&to=2026-07-17');
    expect(response.status).toBe(400);
    expect((await json<{ error: { message: string } }>(response)).error.message).toMatch(
      /full-text horizon/,
    );
  });

  it('rejects an inverted window', async () => {
    const response = await get('/v1/diff?title=40&section=60.1&from=2026-07-17&to=2026-03-02');
    expect(response.status).toBe(400);
  });

  /**
   * A date eCFR never issued is a 404, not a round trip.
   *
   * Shape validation left every one of the ~3,500 well-formed dates since the 2017-01-01
   * horizon as a guaranteed cache miss — two upstream fetches and a permanent R2 object each,
   * squared over date pairs, reachable by anyone with a free key.
   */
  it('404s a well-formed date that eCFR never issued, writing nothing', async () => {
    // 2026-05-11 is a real Monday after the horizon and is not an issue_date in the seed.
    const response = await get('/v1/diff?title=40&section=60.1&from=2026-05-11&to=2026-07-17');
    expect(response.status).toBe(404);

    const body = await json<{
      error: { code: string; details: { unknown_dates: { field: string; value: string }[] } };
    }>(response);
    expect(body.error.code).toBe('not_found');
    expect(body.error.details.unknown_dates).toEqual([{ field: 'from', value: '2026-05-11' }]);

    // Nothing read from the bucket, nothing written to it: the gate is before both.
    expect(harness.bucket.getCount).toBe(0);
    expect(harness.bucket.putCount).toBe(0);
  });

  it('accepts the issue dates the amendments route actually advertises', async () => {
    // Guards the guard. A validator that rejected everything would make the test above pass.
    const response = await get('/v1/diff?title=40&section=60.1&from=2026-03-02&to=2026-07-17');
    // 403, not 404: the dates are real, and the anonymous tier simply may not compute a miss.
    expect(response.status).toBe(403);
  });

  it('refuses to spend an upstream fetch for an anonymous caller on a cache miss', async () => {
    const response = await get('/v1/diff?title=40&section=60.1&from=2026-03-02&to=2026-07-17');
    expect(response.status).toBe(403);
    const body = await json<{ error: { message: string } }>(response);
    expect(body.error.message).toMatch(/register/i);
    // Nothing was fetched and nothing was written.
    expect(harness.bucket.putCount).toBe(0);
  });

  it('serves a memoised diff to an anonymous caller without any upstream call', async () => {
    const key = 'diff/v1/title-40/section-60.1/2026-03-02..2026-07-17.json';
    harness.bucket.objects.set(
      key,
      JSON.stringify({
        v: 1,
        kind: 'diff',
        body: {
          title: 40,
          section: '60.1',
          issue_date: '2026-07-17',
          compared_to: '2026-03-02',
          status: 'modified',
          added: 1,
          removed: 1,
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [
                { type: 'remove', text: 'old text', oldLine: 1, newLine: null },
                { type: 'add', text: 'new text', oldLine: null, newLine: 1 },
              ],
            },
          ],
          note: null,
          old_available: true,
          new_available: true,
          old_line_count: 1,
          new_line_count: 1,
          computed_at: '2026-07-20T00:00:00.000Z',
          old_ecfr_url: 'https://www.ecfr.gov/on/2026-03-02/title-40/section-60.1',
          new_ecfr_url: 'https://www.ecfr.gov/on/2026-07-17/title-40/section-60.1',
        },
      }),
    );

    const response = await get('/v1/diff?title=40&section=60.1&from=2026-03-02&to=2026-07-17');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-diff-cache')).toBe('hit');

    const body = await json<{
      status: string;
      cached: boolean;
      hunks: { old_start: number; lines: { old_line: number | null }[] }[];
    }>(response);

    expect(body.status).toBe('modified');
    expect(body.cached).toBe(true);
    // camelCase in the engine, snake_case on the wire.
    expect(body.hunks[0]?.old_start).toBe(1);
    expect(body.hunks[0]?.lines[0]?.old_line).toBe(1);
  });
});

describe('metering', () => {
  it('returns RateLimit headers on every response', async () => {
    const response = await get('/v1/meta');
    expect(response.headers.get('ratelimit-limit')).toBe(String(TIERS.anonymous.dailyQuota));
    expect(Number(response.headers.get('ratelimit-remaining'))).toBe(
      TIERS.anonymous.dailyQuota - 1,
    );
    expect(Number(response.headers.get('ratelimit-reset'))).toBeGreaterThan(0);
    expect(response.headers.get('ratelimit-policy')).toContain('name="burst"');
    expect(response.headers.get('x-api-tier')).toBe('anonymous');
  });

  it('counts each anonymous request exactly once against the daily quota', async () => {
    await get('/v1/meta');
    await get('/v1/titles');
    const third = await get('/v1/meta');
    expect(Number(third.headers.get('ratelimit-remaining'))).toBe(TIERS.anonymous.dailyQuota - 3);

    const rows = harness.db.raw.prepare('SELECT count FROM api_usage_anon_day').all() as {
      count: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
  });

  it('429s with an explanation once the daily quota is spent', async () => {
    // Pre-charge the counter to the limit; the next request is number limit+1.
    const day = new Date().toISOString().slice(0, 10);
    const first = await get('/v1/meta');
    const anonKey = (
      harness.db.raw.prepare('SELECT anon_key FROM api_usage_anon_day').get() as {
        anon_key: string;
      }
    ).anon_key;
    expect(first.status).toBe(200);

    harness.db.raw
      .prepare('UPDATE api_usage_anon_day SET count = ? WHERE anon_key = ? AND day = ?')
      .run(TIERS.anonymous.dailyQuota, anonKey, day);

    const response = await get('/v1/meta');
    expect(response.status).toBe(429);
    const body = await json<{
      error: { code: string; details: { limiter: string; how_to_raise: string } };
    }>(response);
    expect(body.error.code).toBe('quota_exceeded');
    expect(body.error.details.limiter).toBe('daily_quota');
    expect(body.error.details.how_to_raise).toMatch(/register/);
    expect(response.headers.get('retry-after')).toBeTruthy();
  });

  it('429s on burst without writing a quota row for the rejected request', async () => {
    harness.close();
    harness = createHarness({ anonBurst: 1 });
    seed(harness.db);

    expect((await get('/v1/meta')).status).toBe(200);
    const second = await get('/v1/meta');
    expect(second.status).toBe(429);

    const body = await json<{ error: { code: string; details: { limiter: string } } }>(second);
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.details.limiter).toBe('burst');

    // Burst is checked before the counter, so the rejected request costs no D1 write.
    const rows = harness.db.raw.prepare('SELECT count FROM api_usage_anon_day').all() as {
      count: number;
    }[];
    expect(rows[0]?.count).toBe(1);
  });

  it('401s on a malformed or unknown key instead of silently downgrading to anonymous', async () => {
    const malformed = await get('/v1/meta', { headers: { authorization: 'Bearer nonsense' } });
    expect(malformed.status).toBe(401);

    const unknown = await get('/v1/meta', {
      headers: {
        authorization: `Bearer ecfr_${crypto.randomUUID()}_${'a'.repeat(43)}`,
      },
    });
    expect(unknown.status).toBe(401);
  });
});

describe('account lifecycle', () => {
  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return get(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('registers, verifies, mints, lists and revokes', async () => {
    const registered = await post('/v1/account/register', {
      email: 'Analyst@Agency.GOV',
      organization: 'Some Agency',
    });
    expect(registered.status).toBe(202);
    const registerBody = await json<{ status: string; dev_token: string | null }>(registered);
    expect(registerBody.status).toBe('verification_sent');
    // Non-production environment, so the token comes back for local testing.
    expect(registerBody.dev_token).toBeTruthy();

    // The address is normalised, and only its hash is stored for the token.
    const account = harness.db.raw
      .prepare('SELECT email, status, verify_token_hash FROM api_account')
      .get() as { email: string; status: string; verify_token_hash: string };
    expect(account.email).toBe('analyst@agency.gov');
    expect(account.status).toBe('pending');
    expect(account.verify_token_hash).not.toBe(registerBody.dev_token);

    const verified = await post('/v1/account/verify', { token: registerBody.dev_token });
    expect(verified.status).toBe(200);
    const key = await json<{ id: string; secret: string; suffix: string; tier: string }>(verified);
    expect(key.secret.startsWith('ecfr_')).toBe(true);
    expect(key.tier).toBe('registered');

    // The plaintext is not in the database in any form.
    const stored = harness.db.raw.prepare('SELECT key_hash, key_suffix FROM api_key').get() as {
      key_hash: string;
      key_suffix: string;
    };
    expect(stored.key_hash).not.toContain(key.secret);
    expect(stored.key_suffix).toBe(key.suffix);

    // The token is single-use.
    expect((await post('/v1/account/verify', { token: registerBody.dev_token })).status).toBe(400);

    const auth = { authorization: `Bearer ${key.secret}` };

    // The key now authenticates, at the registered tier's limits.
    const meta = await get('/v1/meta', { headers: auth });
    expect(meta.status).toBe(200);
    expect(meta.headers.get('x-api-tier')).toBe('registered');
    expect(meta.headers.get('ratelimit-limit')).toBe(String(TIERS.registered.dailyQuota));

    const list = await get('/v1/account/keys', { headers: auth });
    expect(list.status).toBe(200);
    const listBody = await json<{ data: { id: string; suffix: string }[] }>(list);
    expect(listBody.data).toHaveLength(1);
    expect(JSON.stringify(listBody)).not.toContain(key.secret);
    expect(list.headers.get('cache-control')).toContain('no-store');

    const second = await post('/v1/account/keys', { label: 'ci' }, auth);
    expect(second.status).toBe(201);
    const secondKey = await json<{ id: string; secret: string }>(second);
    expect(secondKey.secret).not.toBe(key.secret);

    const revoked = await get(`/v1/account/keys/${secondKey.id}`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(revoked.status).toBe(200);

    // A revoked key stops working, and is reported as revoked rather than as unknown.
    const afterRevoke = await get('/v1/meta', {
      headers: { authorization: `Bearer ${secondKey.secret}` },
    });
    expect(afterRevoke.status).toBe(401);
    expect((await json<{ error: { message: string } }>(afterRevoke)).error.message).toMatch(
      /revoked/i,
    );

    // Revoking twice is a 404, and so is revoking someone else's key — the same response, so
    // the endpoint cannot be used to probe for other accounts' key ids.
    expect(
      (await get(`/v1/account/keys/${secondKey.id}`, { method: 'DELETE', headers: auth })).status,
    ).toBe(404);
  });

  it('gives the same answer whether or not the address already has an account', async () => {
    const first = await post('/v1/account/register', { email: 'dup@example.test' });
    const second = await post('/v1/account/register', { email: 'dup@example.test' });
    expect(first.status).toBe(second.status);

    const a = await json<{ status: string; message: string }>(first);
    const b = await json<{ status: string; message: string }>(second);
    expect(a.status).toBe(b.status);
    expect(a.message).toBe(b.message);

    // One account, one live token — re-registering replaces rather than accumulating.
    const count = harness.db.raw.prepare('SELECT COUNT(*) AS n FROM api_account').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it('rejects a bad email before touching the database', async () => {
    const response = await post('/v1/account/register', { email: 'not-an-email' });
    expect(response.status).toBe(400);
    const count = harness.db.raw.prepare('SELECT COUNT(*) AS n FROM api_account').get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });

  /**
   * Regression: `authenticate` was once registered on both `v1` and the mounted account
   * sub-app. Hono merges a routed sub-app's wildcard middleware into the parent router rather
   * than replacing it, so every account request charged two quota units and did two D1 writes.
   */
  it('charges exactly one quota unit per account request', async () => {
    // biome-ignore lint/nursery/noFloatingPromises: false positive — the call IS awaited; Biome's nursery inference misreads the awaited helper
    await post('/v1/account/register', { email: 'once@example.test' });
    const rows = harness.db.raw.prepare('SELECT count FROM api_usage_anon_day').all() as {
      count: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(1);
  });

  it('applies the narrow CORS policy to account routes and the open one to data routes', async () => {
    const data = await get('/v1/titles', { headers: { origin: 'https://somewhere.example' } });
    expect(data.headers.get('access-control-allow-origin')).toBe('*');

    const managed = await post(
      '/v1/account/register',
      { email: 'cors@example.test' },
      {
        origin: 'https://somewhere.example',
      },
    );
    expect(managed.headers.get('access-control-allow-origin')).toBe('https://ecfr-atlas.test');
  });

  it('requires a key to manage keys', async () => {
    expect((await get('/v1/account/keys')).status).toBe(401);
    expect(
      (await get(`/v1/account/keys/${crypto.randomUUID()}`, { method: 'DELETE' })).status,
    ).toBe(401);
  });
});

describe('operator tier grant', () => {
  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return get(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  async function activeAccount(email: string): Promise<string> {
    const registered = await post('/v1/account/register', { email });
    const { dev_token } = await json<{ dev_token: string }>(registered);
    const verified = await post('/v1/account/verify', { token: dev_token });
    return (await json<{ secret: string }>(verified)).secret;
  }

  it('is invisible when ADMIN_TOKEN is not configured', async () => {
    expect(harness.env.ADMIN_TOKEN).toBeUndefined();
    const response = await post('/v1/account/tier', {
      email: 'x@example.test',
      tier: 'elevated',
    });
    expect(response.status).toBe(404);
  });

  it('rejects a wrong token with the same 404, revealing nothing', async () => {
    harness.env.ADMIN_TOKEN = 'the-real-token';
    const response = await post(
      '/v1/account/tier',
      { email: 'x@example.test', tier: 'elevated' },
      { 'x-admin-token': 'not-the-token' },
    );
    expect(response.status).toBe(404);
  });

  it('moves an account to the elevated tier and its keys follow', async () => {
    harness.env.ADMIN_TOKEN = 'the-real-token';
    const secret = await activeAccount('elevate@example.test');

    const before = await get('/v1/meta', { headers: { authorization: `Bearer ${secret}` } });
    expect(before.headers.get('x-api-tier')).toBe('registered');

    const granted = await post(
      '/v1/account/tier',
      { email: 'elevate@example.test', tier: 'elevated' },
      { 'x-admin-token': 'the-real-token' },
    );
    expect(granted.status).toBe(200);
    expect((await json<{ keys_updated: number }>(granted)).keys_updated).toBe(1);

    const after = await get('/v1/meta', { headers: { authorization: `Bearer ${secret}` } });
    expect(after.headers.get('x-api-tier')).toBe('elevated');
    expect(after.headers.get('ratelimit-limit')).toBe(String(TIERS.elevated.dailyQuota));
  });

  it('is hidden from the public reference', async () => {
    const spec = await json<{ paths: Record<string, unknown> }>(await get('/openapi.json'));
    expect(Object.keys(spec.paths)).not.toContain('/v1/account/tier');
  });
});
