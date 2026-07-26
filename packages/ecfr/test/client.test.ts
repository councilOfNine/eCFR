import { expect, test, vi } from 'vitest';
import {
  defaultRetryPolicy,
  ECFR_USER_AGENT,
  EcfrAbortError,
  EcfrClient,
  EcfrContractError,
  EcfrHttpError,
  EcfrNetworkError,
  EcfrTooLargeError,
  RateGovernor,
} from '../src/index.js';

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const AGENCIES = {
  agencies: [
    {
      name: 'A',
      display_name: 'A',
      sortable_name: 'A',
      slug: 'a',
      cfr_references: [{ title: 40, chapter: 'I' }],
      children: [],
    },
  ],
};

test('governor holds sustained rate at or under the configured ceiling', async () => {
  // Fake clock + fake timers: the bucket must be provably paced without waiting in real time.
  let now = 0;
  const pending: Array<{ at: number; cb: () => void }> = [];
  const gov = new RateGovernor({
    ratePerSecond: 8,
    concurrency: 4,
    now: () => now,
    schedule: (cb, ms) => {
      const e = { at: now + ms, cb };
      pending.push(e);
      return () => {
        const i = pending.indexOf(e);
        if (i >= 0) pending.splice(i, 1);
      };
    },
  });
  const starts: number[] = [];
  const runs = Array.from({ length: 40 }, () =>
    gov.run(async () => {
      starts.push(now);
    }),
  );
  // Advance the fake clock until every scheduled drain has fired.
  for (let step = 0; step < 500 && (pending.length > 0 || starts.length < 40); step++) {
    await Promise.resolve();
    await Promise.resolve();
    const due = pending.filter((e) => e.at <= now);
    if (due.length === 0 && pending.length > 0) {
      now = Math.min(...pending.map((e) => e.at));
      continue;
    }
    for (const e of due) {
      pending.splice(pending.indexOf(e), 1);
      e.cb();
    }
    await Promise.resolve();
  }
  await Promise.all(runs);
  expect(starts.length).toBe(40);
  expect(gov.burst).toBe(4); // default is min(rate, concurrency), not the full rate
  // 4 burst tokens go instantly; the remaining 36 are paced at 8/s => >= 4500 ms of clock.
  expect(starts[starts.length - 1]).toBeGreaterThanOrEqual(4500);
  // Token-bucket guarantee: at most burst + rate*T requests in any window of length T.
  for (let i = 0; i + 12 < starts.length; i++) {
    expect(starts[i + 12]! - starts[i]!).toBeGreaterThanOrEqual(1000);
  }
  // And no instantaneous spike beyond the bucket capacity.
  for (let i = 0; i + 4 < starts.length; i++) {
    expect(starts[i + 4]! - starts[i]!).toBeGreaterThan(0);
  }
});

test('sends gzip + a contactable User-Agent on every request', async () => {
  let seen: Headers | undefined;
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    fetch: async (_u, init) => {
      seen = new Headers(init?.headers);
      return json(AGENCIES);
    },
  });
  await c.fetchAgencies();
  expect(seen!.get('accept-encoding')).toBe('gzip');
  expect(seen!.get('user-agent')).toBe(ECFR_USER_AGENT);
  expect(ECFR_USER_AGENT).toContain('+https://');
  // The contact URL is the whole point of the header. It used to be
  // `https://github.com/OWNER/ecfr-atlas`, a literal placeholder that resolved to nothing, so
  // every production request advertised a contact route that did not exist.
  expect(ECFR_USER_AGENT).not.toContain('OWNER');
});

/**
 * `ECFR_CONTACT_URL` is read once at module load, so each case needs a fresh module registry
 * rather than a re-read. `vi.resetModules()` plus a dynamic import is the only way to observe
 * the branch at all.
 */
async function loadUserAgent(contactUrl: string | undefined): Promise<string> {
  const previous = process.env.ECFR_CONTACT_URL;
  if (contactUrl === undefined) delete process.env.ECFR_CONTACT_URL;
  else process.env.ECFR_CONTACT_URL = contactUrl;
  vi.resetModules();
  try {
    const mod = (await import('../src/client.js')) as { ECFR_USER_AGENT: string };
    return mod.ECFR_USER_AGENT;
  } finally {
    if (previous === undefined) delete process.env.ECFR_CONTACT_URL;
    else process.env.ECFR_CONTACT_URL = previous;
    vi.resetModules();
  }
}

test('ECFR_CONTACT_URL overrides the contact URL in the User-Agent', async () => {
  await expect(loadUserAgent('https://example.org/ecfr-atlas')).resolves.toBe(
    'ecfr-atlas/0.1 (+https://example.org/ecfr-atlas)',
  );
});

test('an unset ECFR_CONTACT_URL still yields a reachable contact URL', async () => {
  const ua = await loadUserAgent(undefined);
  expect(ua).toMatch(/^ecfr-atlas\/0\.1 \(\+https:\/\/\S+\)$/);
  expect(ua).not.toContain('OWNER');
});

test.each([
  // Whitespace and parentheses break the `(+url)` comment token.
  ['contains a space', 'https://example.org/a b'],
  ['contains a parenthesis', 'https://example.org/(x)'],
  // The one that matters: CRLF in an environment variable must never become a second header.
  ['contains CRLF', 'https://example.org/\r\nX-Injected: 1'],
  ['is not absolute', '/contact'],
  ['is not http(s)', 'mailto:ops@example.org'],
])('a contact URL that %s is rejected rather than sent', async (_label, value) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ua = await loadUserAgent(value);
    // Fell back to the default, and said so — silence here would leave an operator believing
    // they are attributable when they are not.
    expect(ua).toMatch(/^ecfr-atlas\/0\.1 \(\+https:\/\/\S+\)$/);
    expect(ua).not.toContain(value.trim());
    expect(warn).toHaveBeenCalledOnce();
  } finally {
    warn.mockRestore();
  }
});

test('a blank ECFR_CONTACT_URL is treated as unset, not as an error', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ua = await loadUserAgent('   ');
    expect(ua).toMatch(/^ecfr-atlas\/0\.1 \(\+https:\/\/\S+\)$/);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test('429 retries with full jitter and eventually succeeds', async () => {
  const delays: number[] = [];
  let calls = 0;
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    random: () => 1,
    sleep: async (ms) => {
      delays.push(ms);
    },
    fetch: async () => {
      calls++;
      return calls < 4 ? new Response('x'.repeat(162), { status: 429 }) : json(AGENCIES);
    },
  });
  const r = await c.fetchAgencies();
  expect(r.agencies.length).toBe(1);
  expect(calls).toBe(4);
  // 2s, 4s, 8s at full jitter = 1
  expect(delays).toEqual([2000, 4000, 8000]);
});

test('429 gives up after exactly 6 attempts and reports the 162-byte signature', async () => {
  let calls = 0;
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    sleep: async () => {},
    fetch: async () => {
      calls++;
      return new Response('x'.repeat(162), { status: 429 });
    },
  });
  const err = await c.fetchAgencies().catch((e) => e);
  expect(err).toBeInstanceOf(EcfrHttpError);
  expect(calls).toBe(defaultRetryPolicy().rate_limited.attempts);
  expect(err.status).toBe(429);
  expect(err.bodyBytes).toBe(162);
  expect(err.attempts).toBe(6);
});

test('504 uses the gateway budget, not the rate-limit budget', async () => {
  let calls = 0;
  const delays: number[] = [];
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    random: () => 1,
    sleep: async (ms) => {
      delays.push(ms);
    },
    fetch: async () => {
      calls++;
      return new Response('x'.repeat(246), { status: 504 });
    },
  });
  await c.fetchTitleXml(49, '2026-07-24').catch(() => {});
  expect(calls).toBe(4);
  expect(delays).toEqual([5000, 10000, 20000]);
});

test('404 fails immediately — no retries, no wasted tokens', async () => {
  let calls = 0;
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    sleep: async () => {},
    fetch: async () => {
      calls++;
      return new Response('nope', { status: 404 });
    },
  });
  const err = await c.fetchStructure(1, '2026-07-24').catch((e) => e);
  expect(calls).toBe(1);
  expect(err).toBeInstanceOf(EcfrHttpError);
  expect(err.notFound).toBe(true);
});

test('network errors retry', async () => {
  let calls = 0;
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    sleep: async () => {},
    fetch: async () => {
      calls++;
      if (calls < 3) throw new TypeError('fetch failed');
      return json(AGENCIES);
    },
  });
  await c.fetchAgencies();
  expect(calls).toBe(3);
});

test('a schema breach throws EcfrContractError, carries issues, and is NOT retried', async () => {
  let calls = 0;
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    sleep: async () => {},
    // `slug` removed: a field the pipeline actually reads.
    fetch: async () => {
      calls++;
      return json({ agencies: [{ name: 'A', display_name: 'A', sortable_name: 'A' }] });
    },
  });
  const err = await c.fetchAgencies().catch((e) => e);
  expect(err).toBeInstanceOf(EcfrContractError);
  expect(err.schemaName).toBe('agencies');
  expect(err.issues.length).toBeGreaterThan(0);
  expect(calls).toBe(1);
});

test('loose schemas let unknown upstream fields through', async () => {
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    fetch: async () =>
      json({ agencies: [{ ...AGENCIES.agencies[0], brand_new_field: 42 }], future: true }),
  });
  expect((await c.fetchAgencies()).agencies.length).toBe(1);
});

test('titles surfaces import_in_progress rather than burying it', async () => {
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    fetch: async () =>
      json({
        titles: [
          {
            number: 35,
            name: 'Reserved',
            latest_amended_on: null,
            latest_issue_date: null,
            up_to_date_as_of: null,
            reserved: true,
          },
        ],
        meta: { date: '2026-07-24', import_in_progress: true },
      }),
  });
  const r = await c.fetchTitles();
  expect(r.importInProgress).toBe(true);
  expect(r.date).toBe('2026-07-24');
  expect(r.titles[0]!.latest_amended_on).toBe(null);
});

test('filtered /versions at exactly 1000 rows with no total_pages raises truncation', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    date: '2026-07-01',
    amendment_date: '2015-03-02',
    issue_date: '2026-07-01',
    identifier: `1.${i}`,
    name: `s${i}`,
  }));
  const warnings: unknown[] = [];
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    onWarning: (w) => warnings.push(w),
    fetch: async () => json({ content_versions: rows }),
  });
  const r = await c.fetchVersions(21, { issueDateGte: '2026-01-01' });
  expect(r.truncation).not.toBe(null);
  expect(r.truncation!.rows).toBe(1000);
  expect(r.truncation!.filters).toEqual({ 'issue_date[gte]': '2026-01-01' });
  expect(warnings.length).toBe(1);
});

test('unfiltered 1000 rows with total_pages is not flagged', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    date: '2026-07-01',
    amendment_date: '2015-03-02',
    issue_date: '2026-07-01',
    identifier: `1.${i}`,
    name: `s${i}`,
  }));
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    fetch: async () => json({ content_versions: rows, meta: { total_pages: 3 } }),
  });
  expect((await c.fetchVersions(21)).truncation).toBe(null);
});

test('/versions forwards `page` and surfaces meta.page', async () => {
  // Without this the backfill can only ever read the first 1,000 of title 12's 18,752
  // amendments, and nothing downstream can tell a 5%-complete table from a whole one.
  const urls: string[] = [];
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    fetch: async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json({ content_versions: [], meta: { total_pages: '19', page: '7' } });
    },
  });
  const r = await c.fetchVersions(12, { page: 7 });
  expect(urls[0]).toBe('https://www.ecfr.gov/api/versioner/v1/versions/title-12.json?page=7');
  expect(r.page).toBe(7);
  expect(r.totalPages).toBe(19);
});

test('`page` is pagination, not a filter, so a full unfiltered page is not flagged', async () => {
  // A page-2 request for 1,000 rows must not read as a filtered response that might be
  // truncated — the truncation warning exists for issue_date[gte]/chapter/part, which suppress
  // meta.total_pages. Counting `page` as a filter would make every backfill page warn.
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    date: '2026-07-01',
    amendment_date: '2015-03-02',
    issue_date: '2026-07-01',
    identifier: `1.${i}`,
    name: `s${i}`,
  }));
  const warnings: unknown[] = [];
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    onWarning: (w) => warnings.push(w),
    fetch: async () => json({ content_versions: rows }),
  });
  const r = await c.fetchVersions(12, { page: 2 });
  expect(r.truncation).toBe(null);
  expect(warnings).toEqual([]);
});

test('/versions rejects a page number that is not a positive integer', async () => {
  const c = new EcfrClient({ governor: new RateGovernor({ ratePerSecond: 1000 }) });
  await expect(c.fetchVersions(12, { page: 0 })).rejects.toBeInstanceOf(RangeError);
  await expect(c.fetchVersions(12, { page: -1 })).rejects.toBeInstanceOf(RangeError);
  await expect(c.fetchVersions(12, { page: 1.5 })).rejects.toBeInstanceOf(RangeError);
});

test('the XML URL only ever carries slicing parameters', async () => {
  const c = new EcfrClient();
  expect(c.titleXmlUrl(40, '2026-07-24')).toBe(
    'https://www.ecfr.gov/api/versioner/v1/full/2026-07-24/title-40.xml',
  );
  expect(c.titleXmlUrl(40, '2026-07-24', { part: '60' })).toBe(
    'https://www.ecfr.gov/api/versioner/v1/full/2026-07-24/title-40.xml?part=60',
  );
  expect(c.titleXmlUrl(40, '2026-07-24', { section: '60.1' })).toBe(
    'https://www.ecfr.gov/api/versioner/v1/full/2026-07-24/title-40.xml?section=60.1',
  );
  // @ts-expect-error chapter validates but does not slice; it must not be expressible.
  c.titleXmlUrl(40, '2026-07-24', { chapter: 'I' });
});

test('bad title numbers and dates fail before a request is made', async () => {
  let calls = 0;
  const c = new EcfrClient({
    fetch: async () => {
      calls++;
      return json({});
    },
  });
  await expect(c.fetchStructure(99, '2026-07-24')).rejects.toBeInstanceOf(RangeError);
  await expect(c.fetchStructure(1, '2026-07-24T00:00:00Z')).rejects.toBeInstanceOf(RangeError);
  expect(calls).toBe(0);
});

test('maxBytes counts DECODED bytes, so a gzipped body cannot slip past', async () => {
  const big = 'y'.repeat(5000);
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    sleep: async () => {},
    // Content-Length lies about the decoded size, exactly as a gzipped response would.
    fetch: async () =>
      new Response(big, {
        status: 200,
        headers: { 'content-length': '900', 'content-encoding': 'gzip' },
      }),
  });
  const err = await c
    .fetchTitleXml(40, '2026-07-24', { part: '60' }, { maxBytes: 1000 })
    .catch((e) => e);
  expect(err).toBeInstanceOf(EcfrTooLargeError);
});

test('xml comes back whole when under the ceiling', async () => {
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    fetch: async () => new Response('<DIV1 N="1"/>'),
  });
  expect(await c.fetchTitleXml(1, '2026-07-24', { part: '1' }, { maxBytes: 1000 })).toBe(
    '<DIV1 N="1"/>',
  );
});

test('caller abort is never retried', async () => {
  const ac = new AbortController();
  let calls = 0;
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    sleep: async () => {},
    fetch: async (_u, init) => {
      calls++;
      ac.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError', signal: init?.signal });
    },
  });
  const err = await c.fetchAgencies({ signal: ac.signal }).catch((e) => e);
  expect(err).toBeInstanceOf(EcfrAbortError);
  expect(calls).toBe(1);
});

test('per-attempt timeout aborts and is retried as a network failure', async () => {
  let calls = 0;
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    sleep: async () => {},
    jsonTimeoutMs: 10,
    fetch: (_u, init) =>
      new Promise((_res, rej) => {
        calls++;
        init?.signal?.addEventListener('abort', () =>
          rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  });
  const err = await c.fetchAgencies().catch((e) => e);
  expect(err).toBeInstanceOf(EcfrNetworkError);
  expect(err.timedOut).toBe(true);
  expect(calls).toBe(4);
});

test('streaming hands back a live body', async () => {
  const c = new EcfrClient({
    governor: new RateGovernor({ ratePerSecond: 1000 }),
    fetch: async () => new Response('<DIV1/>', { headers: { 'content-length': '7' } }),
  });
  const s = await c.fetchTitleXmlStream(40, '2026-07-24', { part: '60' });
  expect(s.contentLength).toBe(7);
  expect(await new Response(s.stream).text()).toBe('<DIV1/>');
});
