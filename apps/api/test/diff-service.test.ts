/**
 * The diff resolution path, with the network faked at the `fetch` boundary.
 *
 * The single most important assertion in this file is that a failed old-side fetch renders as
 * `unavailable`. The predecessor rendered it as "section added", which is a confident,
 * plausible, and completely false statement about a section that had existed for decades.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DIFF_MAX_LINES } from '../src/constants/config.js';
import { getDiff } from '../src/diff/service.js';
import { extractSectionLines } from '../src/diff/xml-text.js';
import { FakeR2 } from './helpers/env.js';

function sectionXml(lines: readonly string[], sectionId = '60.1'): string {
  const paragraphs = lines.map((l) => `<P>${l}</P>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><ECFR><DIV1 N="40" TYPE="TITLE"><DIV5 N="60" TYPE="PART"><DIV8 N="${sectionId}" TYPE="SECTION"><HEAD>&#167; ${sectionId} Applicability.</HEAD>${paragraphs}</DIV8></DIV5></DIV1></ECFR>`;
}

const REQUEST = { title: 40, section: '60.1', from: '2026-03-02', to: '2026-07-17' } as const;
const KEY = 'diff/v1/title-40/section-60.1/2026-03-02..2026-07-17.json';

let bucket: FakeR2;

beforeEach(() => {
  bucket = new FakeR2();
});

/** A fetch stub keyed on the issue date embedded in the URL. */
function stubFetch(responses: Record<string, Response | (() => Response)>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [date, response] of Object.entries(responses)) {
      if (url.includes(`/full/${date}/`)) {
        return typeof response === 'function' ? response() : response.clone();
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const deps = (fetchImpl: typeof fetch) => ({
  bucket: bucket as unknown as R2Bucket,
  mayCompute: true,
  userAgent: 'ecfr-atlas-test/0.1 (+https://example.test)',
  fetchImpl,
  // No real waiting: the retry policy is being exercised, not the clock.
  sleep: async () => undefined,
});

describe('getDiff', () => {
  it('computes a modified diff and memoises it permanently', async () => {
    const fetchImpl = stubFetch({
      '2026-03-02': new Response(sectionXml(['first paragraph', 'second paragraph']), {
        status: 200,
      }),
      '2026-07-17': new Response(sectionXml(['first paragraph', 'second paragraph, amended']), {
        status: 200,
      }),
    });

    const result = await getDiff(REQUEST, deps(fetchImpl));
    expect(result.outcome).toBe('served');
    if (result.outcome !== 'served') return;

    expect(result.body.status).toBe('modified');
    expect(result.body.cached).toBe(false);
    expect(result.body.added).toBe(1);
    expect(result.body.removed).toBe(1);
    expect(result.body.old_available).toBe(true);
    expect(result.body.new_available).toBe(true);
    expect(result.body.hunks.length).toBeGreaterThan(0);
    expect(bucket.objects.has(KEY)).toBe(true);

    // Second call is served from the memo without touching the network at all.
    const again = await getDiff(REQUEST, deps(stubFetch({})));
    expect(again.outcome).toBe('served');
    if (again.outcome !== 'served') return;
    expect(again.body.cached).toBe(true);
    expect(again.body.status).toBe('modified');
    expect(again.body.added).toBe(1);
  });

  it('reports identical sections as unchanged', async () => {
    const xml = sectionXml(['unchanged paragraph']);
    const result = await getDiff(
      REQUEST,
      deps(stubFetch({ '2026-03-02': new Response(xml), '2026-07-17': new Response(xml) })),
    );
    expect(result.outcome).toBe('served');
    if (result.outcome !== 'served') return;
    expect(result.body.status).toBe('unchanged');
    expect(result.body.added).toBe(0);
    expect(result.body.removed).toBe(0);
  });

  /** The defining test for this module. */
  it('renders a 429 on the OLD side as unavailable, never as "added"', async () => {
    const result = await getDiff(
      REQUEST,
      deps(
        stubFetch({
          // 162-byte body, no Retry-After — the bare-nginx 429 the corpus measurements found.
          '2026-03-02': () => new Response('x'.repeat(162), { status: 429 }),
          '2026-07-17': new Response(sectionXml(['current text'])),
        }),
      ),
    );

    expect(result.outcome).toBe('served');
    if (result.outcome !== 'served') return;

    expect(result.body.status).toBe('unavailable');
    expect(result.body.status).not.toBe('added');
    expect(result.body.added).toBeNull();
    expect(result.body.removed).toBeNull();
    expect(result.body.hunks).toEqual([]);
    expect(result.body.old_available).toBe(false);
    expect(result.body.note).toMatch(/NOT a statement that the section changed/);
  });

  it('retries a 504 and succeeds when the coin flip lands', async () => {
    let attempts = 0;
    const result = await getDiff(
      REQUEST,
      deps(
        stubFetch({
          '2026-03-02': () => {
            attempts++;
            // eCFR's origin timeout is a coin flip: isolated title-49 fetches failed 2 of 4.
            return attempts === 1
              ? new Response('y'.repeat(246), { status: 504 })
              : new Response(sectionXml(['old text']));
          },
          '2026-07-17': new Response(sectionXml(['new text'])),
        }),
      ),
    );

    expect(attempts).toBe(2);
    expect(result.outcome).toBe('served');
    if (result.outcome !== 'served') return;
    expect(result.body.status).toBe('modified');
  });

  it('negative-caches a failure briefly rather than permanently', async () => {
    const failing = stubFetch({
      '2026-03-02': () => new Response('', { status: 429 }),
      '2026-07-17': () => new Response('', { status: 429 }),
    });

    const first = await getDiff(REQUEST, {
      ...deps(failing),
      now: () => new Date('2026-07-20T10:00:00Z'),
    });
    expect(first.outcome).toBe('served');
    if (first.outcome !== 'served') return;
    expect(first.body.status).toBe('unavailable');

    const stored = JSON.parse(bucket.objects.get(KEY) as string) as { kind: string };
    expect(stored.kind).toBe('negative');

    // Still inside the TTL: served from the negative memo, no fetch.
    const cached = await getDiff(REQUEST, {
      ...deps(stubFetch({})),
      now: () => new Date('2026-07-20T10:05:00Z'),
    });
    expect(cached.outcome).toBe('served');
    if (cached.outcome !== 'served') return;
    expect(cached.body.status).toBe('unavailable');
    // The rehydrated body still identifies the request it belongs to.
    expect(cached.body.title).toBe(40);
    expect(cached.body.section).toBe('60.1');

    // After the TTL, a recompute happens and the memo is replaced with the real answer.
    const recovered = await getDiff(REQUEST, {
      ...deps(
        stubFetch({
          '2026-03-02': new Response(sectionXml(['old'])),
          '2026-07-17': new Response(sectionXml(['new'])),
        }),
      ),
      now: () => new Date('2026-07-20T12:00:00Z'),
    });
    expect(recovered.outcome).toBe('served');
    if (recovered.outcome !== 'served') return;
    expect(recovered.body.status).toBe('modified');
    expect((JSON.parse(bucket.objects.get(KEY) as string) as { kind: string }).kind).toBe('diff');
  });

  it('reports an HTTP 404 old side as an addition — the one signal that means absence', async () => {
    const result = await getDiff(
      REQUEST,
      deps(
        stubFetch({
          '2026-03-02': new Response('', { status: 404 }),
          '2026-07-17': new Response(sectionXml(['brand new section'])),
        }),
      ),
    );
    expect(result.outcome).toBe('served');
    if (result.outcome !== 'served') return;
    expect(result.body.status).toBe('added');
    expect(result.body.old_line_count).toBe(0);
    expect(result.body.added).toBeGreaterThan(0);
  });

  it('reports a 404 new side as a removal', async () => {
    const result = await getDiff(
      REQUEST,
      deps(
        stubFetch({
          '2026-03-02': new Response(sectionXml(['text that was removed'])),
          '2026-07-17': new Response('', { status: 404 }),
        }),
      ),
    );
    expect(result.outcome).toBe('served');
    if (result.outcome !== 'served') return;
    expect(result.body.status).toBe('removed');
    expect(result.body.removed).toBeGreaterThan(0);
  });

  it('reports both sides absent as unavailable, not as unchanged', async () => {
    const result = await getDiff(
      REQUEST,
      deps(
        stubFetch({
          '2026-03-02': new Response('', { status: 404 }),
          '2026-07-17': new Response('', { status: 404 }),
        }),
      ),
    );
    expect(result.outcome).toBe('served');
    if (result.outcome !== 'served') return;
    expect(result.body.status).toBe('unavailable');
    expect(result.body.note).toMatch(/no text for/);
  });

  /**
   * A document that came back 200 but does not contain the section we asked for is a failure,
   * not an absence. Guessing which would be exactly the kind of inference this project bans.
   */
  it('treats a wrong-document response as a failure rather than an absence', async () => {
    const result = await getDiff(
      REQUEST,
      deps(
        stubFetch({
          '2026-03-02': new Response(sectionXml(['some other section'], '99.99')),
          '2026-07-17': new Response(sectionXml(['current text'])),
        }),
      ),
    );
    expect(result.outcome).toBe('served');
    if (result.outcome !== 'served') return;
    expect(result.body.status).toBe('unavailable');
    expect(result.body.note).toMatch(/does not contain section/);
  });

  it('returns a structured too_large response above the line cap', async () => {
    const huge = Array.from({ length: DIFF_MAX_LINES + 10 }, (_, i) => `paragraph ${i}`);
    const result = await getDiff(
      REQUEST,
      deps(
        stubFetch({
          '2026-03-02': new Response(sectionXml(huge)),
          '2026-07-17': new Response(sectionXml([...huge, 'one more'])),
        }),
      ),
    );

    expect(result.outcome).toBe('served');
    if (result.outcome !== 'served') return;
    expect(result.body.status).toBe('too_large');
    expect(result.body.hunks).toEqual([]);
    expect(result.body.added).toBeNull();
    // Both sides are still linked so the caller can diff locally.
    expect(result.body.old_ecfr_url).toContain('2026-03-02');
    expect(result.body.new_ecfr_url).toContain('2026-07-17');
    expect(result.body.old_line_count).toBeGreaterThan(DIFF_MAX_LINES);
  });

  it('refuses to compute for a tier that may not, without any fetch', async () => {
    const fetchImpl = stubFetch({});
    const result = await getDiff(REQUEST, { ...deps(fetchImpl), mayCompute: false });
    expect(result.outcome).toBe('compute_not_allowed');
    expect(bucket.putCount).toBe(0);
  });

  it('sends the descriptive User-Agent and asks for gzip', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(sectionXml(['text']));
    }) as unknown as typeof fetch;

    await getDiff(REQUEST, deps(fetchImpl));

    expect(seen).toHaveLength(2);
    for (const init of seen) {
      const headers = init.headers as Record<string, string>;
      expect(headers['User-Agent']).toMatch(/ecfr-atlas/);
      expect(headers['User-Agent']).toMatch(/https?:\/\//);
      expect(headers['Accept-Encoding']).toBe('gzip');
    }
  });

  it('survives a corrupt memo by recomputing rather than 500ing', async () => {
    bucket.objects.set(KEY, 'not json at all');
    const result = await getDiff(
      REQUEST,
      deps(
        stubFetch({
          '2026-03-02': new Response(sectionXml(['old'])),
          '2026-07-17': new Response(sectionXml(['new'])),
        }),
      ),
    );
    expect(result.outcome).toBe('served');
    if (result.outcome !== 'served') return;
    expect(result.body.status).toBe('modified');
  });
});

describe('extractSectionLines', () => {
  const xml = `<?xml version="1.0"?><ECFR><DIV1 N="40" TYPE="TITLE"><HEAD>Title 40</HEAD>
    <DIV5 N="60" TYPE="PART"><HEAD>PART 60&#8212;STANDARDS</HEAD>
      <AUTH><HED>Authority:</HED><PSPACE>42 U.S.C. 7401.</PSPACE></AUTH>
      <DIV8 N="60.1" TYPE="SECTION">
        <HEAD>&#167; 60.1 Applicability.</HEAD>
        <P>Applies to owners <I>and</I> operators &amp; others.</P>
        <DIV>An untyped DIV, of which title 40 has 19,134 inside sections.</DIV>
      </DIV8>
      <DIV8 N="60.2" TYPE="SECTION"><HEAD>&#167; 60.2</HEAD><P>Different section.</P></DIV8>
    </DIV5></DIV1></ECFR>`;

  it('returns only the requested section', () => {
    const result = extractSectionLines(xml, '60.1');
    expect(result.sectionFound).toBe(true);
    expect(result.lines.join('\n')).not.toContain('Different section');
    expect(result.lines).toContain('§ 60.1 Applicability.');
  });

  it('resolves entities and keeps inline markup on one line', () => {
    const result = extractSectionLines(xml, '60.1');
    expect(result.lines).toContain('Applies to owners and operators & others.');
  });

  it('reads untyped DIV elements, which no regex could', () => {
    const result = extractSectionLines(xml, '60.1');
    expect(result.lines.some((l) => l.includes('19,134'))).toBe(true);
  });

  it('reports a missing section rather than falling back to the whole document', () => {
    const result = extractSectionLines(xml, '99.99');
    expect(result.sectionFound).toBe(false);
    expect(result.lines).toEqual([]);
    // The document did have text, so the caller can tell "wrong document" from "absent".
    expect(result.documentHasText).toBe(true);
  });

  it('distinguishes an empty slice from a wrong document', () => {
    const empty = extractSectionLines('<?xml version="1.0"?><ECFR></ECFR>', '60.1');
    expect(empty.sectionFound).toBe(false);
    expect(empty.documentHasText).toBe(false);
  });

  it('collapses whitespace so reindentation is not read as a change', () => {
    const spaced = `<ECFR><DIV8 N="1.1" TYPE="SECTION"><P>a\n\n     b\tc</P></DIV8></ECFR>`;
    expect(extractSectionLines(spaced, '1.1').lines).toEqual(['a b c']);
  });
});
