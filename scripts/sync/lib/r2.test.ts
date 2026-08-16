/**
 * The signature lifecycle is the part of the R2 client that only fails in production: SigV4
 * embeds the wall clock, R2 rejects anything more than 15 minutes stale, and a laptop that
 * sleeps with a PUT in flight wakes up holding an expired signature. These tests move the
 * clock the way that incident did and assert the retry loop signs fresh on every attempt.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { R2Config } from './config.js';
import type { Logger } from './log.js';
import { R2Client } from './r2.js';

const config: R2Config = {
  accountId: 'test-account',
  bucket: 'test-bucket',
  accessKeyId: 'AKIA_TEST',
  secretAccessKey: 'test-secret',
  endpoint: 'https://test-account.r2.cloudflarestorage.com',
};

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
  time: <T>(_label: string, fn: () => Promise<T>) => fn(),
};

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('R2Client.put signing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-07-30T10:00:00Z') });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('signs every attempt with the current clock, so a retry after the machine slept succeeds', async () => {
    const dates: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        dates.push(headersOf(init)['x-amz-date'] ?? '(missing)');
        if (dates.length === 1) {
          // The machine sleeps with the request in flight; by the time R2 answers, the
          // signed timestamp is 20 minutes old and the server rejects it.
          vi.setSystemTime(new Date('2026-07-30T10:20:00Z'));
          return new Response('<Error><Code>RequestTimeTooSkewed</Code></Error>', {
            status: 403,
          });
        }
        return new Response(null, { status: 200 });
      }),
    );

    const client = new R2Client(config, silentLogger);
    const put = client.put('parts/title-40/chapter-IX/part-1900', 'body', 'text/html');
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(put).resolves.toBe(4);

    // The regression this pins: signing once outside the retry loop resends the stale
    // 10:00:00 stamp on attempt 2, which can never succeed.
    expect(dates).toEqual(['20260730T100000Z', '20260730T102000Z']);
    expect(client.writes).toBe(1);
    expect(client.bytes).toBe(4);
  });

  it('gives up after three attempts, each freshly signed, and surfaces the response body', async () => {
    const authorizations: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        authorizations.push(headersOf(init).authorization ?? '(missing)');
        // The clock keeps moving between attempts, so each signature must differ.
        vi.setSystemTime(new Date(Date.now() + 20 * 60 * 1000));
        return new Response('<Error><Code>RequestTimeTooSkewed</Code></Error>', {
          status: 403,
        });
      }),
    );

    const client = new R2Client(config, silentLogger);
    const put = client.put('parts/title-1/part-1', 'body', 'text/html');
    const rejection = expect(put).rejects.toThrow(/RequestTimeTooSkewed/);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;

    expect(authorizations).toHaveLength(3);
    expect(new Set(authorizations).size).toBe(3);
    expect(client.writes).toBe(0);
  });
});

/**
 * Listing is how the snapshot's content directory gets rebuilt, so the two ways it can quietly
 * lose objects are what these cover: stopping at the first page (which would hydrate 1000 of
 * ~10,300 parts and look like a success), and handing back XML-escaped keys (CFR identifiers
 * contain `&`, and a key requested with `&amp;` in it resolves to nothing).
 */
describe('R2Client.list', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const page = (keys: string[], nextToken?: string): string =>
    `<?xml version="1.0"?><ListBucketResult>${keys
      .map((k) => `<Key>${k}</Key>`)
      .join('')}<IsTruncated>${nextToken ? 'true' : 'false'}</IsTruncated>${
      nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : ''
    }</ListBucketResult>`;

  it('follows continuation tokens until the listing is complete', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        urls.push(String(url));
        return urls.length === 1
          ? new Response(page(['parts/a', 'parts/b'], 'token-2'))
          : new Response(page(['parts/c']));
      }),
    );

    const keys = await new R2Client(config, silentLogger).list('parts/');

    expect(keys).toEqual(['parts/a', 'parts/b', 'parts/c']);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('continuation-token=token-2');
  });

  it('unescapes XML entities, so a key containing & is requested as it is stored', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(page(['parts/title-41/part-101-14 &amp; 101-15']))),
    );

    const keys = await new R2Client(config, silentLogger).list('parts/');

    expect(keys).toEqual(['parts/title-41/part-101-14 & 101-15']);
  });

  it('signs the bucket path without a trailing separator, and sorts the query canonically', async () => {
    let signedUrl = '';
    let authorization = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        signedUrl = String(url);
        authorization = headersOf(init).authorization ?? '';
        return new Response(page([]));
      }),
    );

    await new R2Client(config, silentLogger).list('parts/');

    expect(new URL(signedUrl).pathname).toBe('/test-bucket');
    expect(new URL(signedUrl).search).toBe('?list-type=2&max-keys=1000&prefix=parts%2F');
    expect(authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
  });
});

describe('R2Client.get', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<article>text</article>')),
    );
    const body = await new R2Client(config, silentLogger).get('parts/title-1/part-1');
    expect(body?.toString('utf8')).toBe('<article>text</article>');
  });

  it('returns null on 404 rather than throwing, because an absent part is an answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const body = await new R2Client(config, silentLogger).get('parts/title-1/part-nope');
    expect(body).toBeNull();
  });
});
