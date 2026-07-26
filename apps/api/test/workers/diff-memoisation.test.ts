/**
 * /v1/diff is the one route allowed to reach ecfr.gov, and this is the test that keeps the
 * exception narrow.
 *
 * The rule is not "diff may fetch". It is "diff may fetch ONCE per (title, section, from, to),
 * ever". A resolved diff is a pure function of those four values, so the memo is permanent —
 * the first viewer pays and nobody else does. Without that, a link to a popular comparison
 * turns this Worker into an amplifier pointed at an origin that rate-limits with a token
 * bucket and 504s on large titles about half the time.
 *
 * apps/api/test/diff-service.test.ts already covers the service's branches against an
 * in-memory bucket. This file exists for the part that cannot be faked: a REAL R2 binding, the
 * REAL Worker, and the real route wiring around them. A memo that is written but never read
 * back — wrong key, wrong prefix, a serialisation that does not round-trip — passes every
 * unit test and fails in production on the second request.
 */

import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DIFF_R2_PREFIX } from '../../src/constants/config.js';

interface TestEnv {
  DB: D1Database;
  CONTENT: R2Bucket;
  __SEED: string[];
}

const testEnv = env as unknown as TestEnv;
const BASE = 'https://api.test';

/**
 * A real section on both sides, differing by one paragraph.
 *
 * Deliberately shaped like eCFR's output — a typed DIV8 with a HEAD and P children — because
 * the extractor locates the section by structure and would find nothing in a bare string.
 */
function sectionXml(body: string, section = '1.1'): string {
  const part = section.split('.')[0] ?? '1';
  return (
    '<?xml version="1.0"?>\n' +
    `<DIV5 N="${part}" TYPE="PART"><HEAD>PART ${part}</HEAD>` +
    `<DIV8 N="${section}" TYPE="SECTION"><HEAD>&#xA7; ${section} Definitions.</HEAD>` +
    body +
    '</DIV8></DIV5>'
  );
}

const OLD_SIDE = sectionXml('<P>The Director shall publish the notice.</P>');
const NEW_SIDE = sectionXml(
  '<P>The Director shall publish the notice.</P><P>The notice must state the effective date.</P>',
);

/**
 * Real eCFR issue dates, taken from the committed fixture's `amendment` rows.
 *
 * They cannot be arbitrary any more: /v1/diff validates both dates against `amendment`
 * (issue_date) before it spends an upstream fetch, so a made-up date is a 404. Using dates
 * that are actually in the fixture is also more honest — these are the dates a caller
 * following /v1/amendments would arrive with.
 */
const ISSUE_FROM = '2022-05-04';
const ISSUE_TO = '2023-04-10';
/** A third real issue date, for "a different pair is a different memo". */
const ISSUE_MID = '2023-02-08';
/**
 * Well-formed, after the full-text horizon, a real calendar day, and inside the ISSUE_FROM..
 * ISSUE_TO window so it cannot be rejected as an inverted range — and eCFR issued nothing on
 * it, so it is not in `amendment`. This is the amplification vector: before the D1 check,
 * every one of these was two upstream fetches and a permanent R2 object.
 */
const NEVER_ISSUED = '2022-08-16';
/** A second unissued date, for the "both sides wrong" case. */
const ALSO_NEVER_ISSUED = '2022-08-15';

// ─── upstream, counted ───────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

let upstreamCalls: string[] = [];
/** Set per test: what eCFR "returns" for each issue date. */
let upstream = new Map<string, string>();
/** Per-test override, e.g. to make one side 429. Reset in afterEach. */
let respond: ((url: string) => Response | null) | null = null;

beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);

    if (!parsed.hostname.endsWith('ecfr.gov')) return realFetch(input as RequestInfo, init);

    upstreamCalls.push(url);

    const override = respond?.(url);
    if (override) return Promise.resolve(override);

    // /api/versioner/v1/full/{date}/title-{n}.xml?section=...
    const date = parsed.pathname.split('/')[5] ?? '';
    const body = upstream.get(date);
    if (body === undefined) {
      return Promise.resolve(new Response('not found', { status: 404 }));
    }
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/xml', 'Content-Length': String(body.length) },
      }),
    );
  }) as typeof fetch;
});

beforeEach(async () => {
  upstreamCalls = [];
  upstream = new Map([
    [ISSUE_FROM, OLD_SIDE],
    [ISSUE_TO, NEW_SIDE],
  ]);

  await testEnv.DB.batch(testEnv.__SEED.map((sql) => testEnv.DB.prepare(sql)));

  // R2 is not truncated by the D1 teardown, and a memo left by the previous test would make a
  // "first call computes" assertion pass for the wrong reason.
  const listed = await testEnv.CONTENT.list({ prefix: DIFF_R2_PREFIX });
  await Promise.all(listed.objects.map((object) => testEnv.CONTENT.delete(object.key)));
});

afterEach(() => {
  upstreamCalls = [];
  respond = null;
});

// ─── principals ──────────────────────────────────────────────────────────────

/**
 * A verified account with a registered key.
 *
 * Written straight to D1 rather than driven through /v1/account/register: this file is about
 * the diff memo, and the account lifecycle has its own test. `key_hash` is sha256 of the
 * plaintext, which is the only form the database ever holds.
 */
async function mintRegisteredKey(): Promise<string> {
  const accountId = crypto.randomUUID();
  const keyId = crypto.randomUUID();
  const plaintext = `ecfr_${keyId}_${'k'.repeat(43)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintext));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO api_account (id, email, status, created_at, verified_at)
       VALUES (?, ?, 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).bind(accountId, `${keyId}@example.test`),
    testEnv.DB.prepare(
      `INSERT INTO api_key (id, account_id, key_hash, key_suffix, tier, created_at)
       VALUES (?, ?, ?, 'kkkk', 'registered', '2026-01-01T00:00:00Z')`,
    ).bind(keyId, accountId, hash),
  ]);

  return plaintext;
}

function diffUrl(from: string = ISSUE_FROM, to: string = ISSUE_TO): string {
  const url = new URL('/v1/diff', BASE);
  url.searchParams.set('title', '1');
  url.searchParams.set('section', '1.1');
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  return url.toString();
}

interface DiffResponseBody {
  status: string;
  cached: boolean;
  added: number | null;
  removed: number | null;
  hunks: { lines: { type: string; text: string }[] }[];
  note: string | null;
}

async function getDiff(key: string | null, url = diffUrl()): Promise<Response> {
  return SELF.fetch(url, {
    headers: {
      'CF-Connecting-IP': '203.0.113.42',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
  });
}

// ─── the tests ───────────────────────────────────────────────────────────────

describe('/v1/diff memoises to R2 and does not refetch', () => {
  it('computes once, then serves every later call from the memo', async () => {
    const key = await mintRegisteredKey();

    const first = await getDiff(key);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as DiffResponseBody;

    expect(firstBody.status).toBe('modified');
    expect(firstBody.cached).toBe(false);
    expect(firstBody.added).toBe(1);
    expect(firstBody.removed).toBe(0);
    expect(first.headers.get('X-Diff-Cache')).toBe('miss');

    // Two fetches: one per side, issued in parallel. Serialising them would not help — the
    // upstream limiter is a token bucket, not a concurrency gate.
    expect(upstreamCalls).toHaveLength(2);

    const callsAfterFirst = upstreamCalls.length;
    const second = await getDiff(key);
    const secondBody = (await second.json()) as DiffResponseBody;

    expect(secondBody.cached).toBe(true);
    expect(second.headers.get('X-Diff-Cache')).toBe('hit');
    expect(upstreamCalls.length, 'the second call refetched; the memo is not being read back').toBe(
      callsAfterFirst,
    );

    // Same answer, not merely a 200. A memo that round-trips to a different diff is worse
    // than no memo.
    expect(secondBody.status).toBe(firstBody.status);
    expect(secondBody.added).toBe(firstBody.added);
    expect(secondBody.removed).toBe(firstBody.removed);
    expect(secondBody.hunks).toEqual(firstBody.hunks);
  });

  it('writes the memo under the versioned prefix, keyed on all four inputs', async () => {
    const key = await mintRegisteredKey();
    await getDiff(key);

    const listed = await testEnv.CONTENT.list({ prefix: DIFF_R2_PREFIX });
    expect(listed.objects).toHaveLength(1);

    const objectKey = listed.objects[0]?.key ?? '';
    // Every component that changes the answer must be in the key, or two different
    // comparisons collide and one of them is served the other's diff.
    expect(objectKey).toContain('title-1');
    expect(objectKey).toContain('1.1');
    expect(objectKey).toContain(ISSUE_FROM);
    expect(objectKey).toContain(ISSUE_TO);
    // Versioned by prefix so a change to the hunking logic can invalidate everything by
    // bumping one constant rather than enumerating a bucket.
    expect(objectKey.startsWith(`${DIFF_R2_PREFIX}/`)).toBe(true);
  });

  it('a different date pair is a different memo, not a cache hit', async () => {
    const key = await mintRegisteredKey();
    upstream.set(ISSUE_MID, sectionXml('<P>Rewritten entirely.</P>'));

    await getDiff(key);
    expect(upstreamCalls).toHaveLength(2);

    const other = await getDiff(key, diffUrl(ISSUE_FROM, ISSUE_MID));
    const body = (await other.json()) as DiffResponseBody;

    expect(body.cached).toBe(false);
    expect(upstreamCalls.length).toBeGreaterThan(2);

    const listed = await testEnv.CONTENT.list({ prefix: DIFF_R2_PREFIX });
    expect(listed.objects).toHaveLength(2);
  });

  it('serves an anonymous caller from the memo without letting them create one', async () => {
    // The carve-out has a door on it. An uncached diff costs two upstream fetches of up to
    // 5 MB each; anonymous callers may read the memo but may not spend that budget.
    const anonymousMiss = await getDiff(null);
    expect(anonymousMiss.status).toBe(403);
    expect(upstreamCalls, 'an anonymous cache miss reached eCFR').toEqual([]);

    const key = await mintRegisteredKey();
    await getDiff(key);
    expect(upstreamCalls).toHaveLength(2);

    const anonymousHit = await getDiff(null);
    expect(anonymousHit.status).toBe(200);
    expect(((await anonymousHit.json()) as DiffResponseBody).cached).toBe(true);
    expect(upstreamCalls).toHaveLength(2);
  });

  it('never renders an unfetchable old side as an addition', async () => {
    // The failure this endpoint was rewritten to make impossible. A 429 on the old side is
    // "we could not tell", and reporting it as "section added" is a false statement about a
    // section that may have existed since 1978.
    const key = await mintRegisteredKey();
    // 162-byte body, no Retry-After: eCFR's 429 comes from bare nginx. The service retries and
    // then gives up, which is the path under test.
    respond = (url) => (url.includes(ISSUE_FROM) ? new Response('', { status: 429 }) : null);

    const response = await getDiff(key);
    const body = (await response.json()) as DiffResponseBody;

    expect(body.status).toBe('unavailable');
    expect(body.status).not.toBe('added');
    expect(body.hunks).toEqual([]);
    expect(body.added).toBeNull();
    expect(body.removed).toBeNull();
    expect(body.note).toMatch(/NOT a statement that the section changed/i);
  });

  it('rejects a section identifier outside the allowlist without any fetch', async () => {
    // The predecessor interpolated `?sections=` into `new RegExp` after escaping only `.` —
    // an unauthenticated ReDoS. The replacement is an allowlist, and a rejected value must
    // cost a string comparison, not an upstream request.
    const key = await mintRegisteredKey();
    const url = new URL(diffUrl());
    url.searchParams.set('section', `1.1${'('.repeat(60)}`);

    const response = await getDiff(key, url.toString());
    expect(response.status).toBe(400);
    expect(upstreamCalls).toEqual([]);
  });

  it('rejects a date before the full-text horizon without any fetch', async () => {
    // 40.4% of amendment_dates predate 2017-01-01. A caller who passes one gets an empty old
    // side, and an empty old side rendered as "added" is the same lie in a different hat.
    const key = await mintRegisteredKey();
    const response = await getDiff(key, diffUrl('2015-03-17', ISSUE_TO));

    expect(response.status).toBe(400);
    expect(upstreamCalls).toEqual([]);
    expect(JSON.stringify(await response.json())).toMatch(/2017-01-01/);
  });
});

/**
 * THE AMPLIFICATION GATE.
 *
 * `assertIssueDate` only ever checked shape, calendar validity and the 2017-01-01 horizon. That
 * left roughly 3,500 well-formed dates that eCFR never issued, each of which was a guaranteed
 * cache miss — two upstream fetches of up to 5 MB against an origin that rate-limits with a
 * token bucket, plus a permanent R2 object — available to anyone holding a free key. Squaring
 * that over date pairs is a lot of somebody else's bandwidth and a permanently growing bucket.
 */
describe('/v1/diff refuses dates eCFR never issued', () => {
  it('404s an unissued `from` before spending a fetch or writing a memo', async () => {
    const key = await mintRegisteredKey();
    const response = await getDiff(key, diffUrl(NEVER_ISSUED, ISSUE_TO));

    expect(response.status).toBe(404);
    expect(upstreamCalls, 'an unissued date still reached eCFR').toEqual([]);
    expect((await testEnv.CONTENT.list({ prefix: DIFF_R2_PREFIX })).objects).toEqual([]);
  });

  it('404s an unissued `to` and names which side is at fault', async () => {
    const key = await mintRegisteredKey();
    const response = await getDiff(key, diffUrl(ISSUE_FROM, NEVER_ISSUED));

    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { code: string; details: { unknown_dates: { field: string; value: string }[] } };
    };
    expect(body.error.code).toBe('not_found');
    // "one of your two dates is wrong" is a maddening error to receive.
    expect(body.error.details.unknown_dates).toEqual([{ field: 'to', value: NEVER_ISSUED }]);
    expect(upstreamCalls).toEqual([]);
  });

  it('reports both sides when neither was ever issued', async () => {
    const key = await mintRegisteredKey();
    const response = await getDiff(key, diffUrl(ALSO_NEVER_ISSUED, NEVER_ISSUED));

    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { details: { unknown_dates: { field: string }[] } };
    };
    expect(body.error.details.unknown_dates.map((u) => u.field)).toEqual(['from', 'to']);
    expect(upstreamCalls).toEqual([]);
  });

  it('closes the door for anonymous callers too, before the tier check', async () => {
    // The 403 for "anonymous may not compute" is the second gate. An unissued date must not
    // even reach it — otherwise the error tells an unauthenticated prober which dates are
    // real, one request at a time.
    const response = await getDiff(null, diffUrl(NEVER_ISSUED, ISSUE_TO));
    expect(response.status).toBe(404);
    expect(upstreamCalls).toEqual([]);
  });

  it('still serves the real issue dates it was given', async () => {
    // Guards the guard: a validator that rejected everything would make every test above pass.
    const key = await mintRegisteredKey();
    const response = await getDiff(key, diffUrl(ISSUE_FROM, ISSUE_TO));
    expect(response.status).toBe(200);
    expect(upstreamCalls).toHaveLength(2);
  });

  it('compares two real issue dates even where the section did not change between them', async () => {
    // The check is on the DATE, not on that section's amendment history. 1 CFR 11.1 has one
    // amendment row, on 2022-12-29, and comparing it across a window that does not contain
    // that row is a perfectly reasonable question with the answer "unchanged".
    const key = await mintRegisteredKey();
    const unchanged = sectionXml('<P>Nothing moved here.</P>', '11.1');
    upstream.set(ISSUE_FROM, unchanged);
    upstream.set(ISSUE_TO, unchanged);

    const url = new URL(diffUrl());
    url.searchParams.set('section', '11.1');
    const response = await getDiff(key, url.toString());

    expect(response.status).toBe(200);
    expect(((await response.json()) as DiffResponseBody).status).toBe('unchanged');
  });
});
