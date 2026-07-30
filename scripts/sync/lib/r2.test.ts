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
