import type { ContentVersion } from '@ecfr-atlas/core/ecfr-schemas';
import { describe, expect, it, vi } from 'vitest';

import type { EcfrClientLike, VersionsResult } from './ecfr-adapter.js';
import { createLogger } from './log.js';
import { fetchAllVersions, VersionsPagingUnsupportedError } from './versions.js';

const log = createLogger('test');

function version(n: number): ContentVersion {
  return {
    date: '2026-07-01',
    amendment_date: '2026-07-01',
    issue_date: '2026-07-01',
    identifier: `1026.${n}`,
    name: `§ 1026.${n}`,
    part: '1026',
    subpart: null,
    title: '12',
    type: 'section',
    removed: false,
    substantive: true,
  };
}

/** A client whose `page` filter works: 1,000 distinct rows per page, 19 pages. */
function pagingClient(totalPages: number, perPage = 1000): EcfrClientLike {
  const fetchVersions = vi.fn(
    async (_title: number, filters?: { page?: number }): Promise<VersionsResult> => {
      const page = filters?.page ?? 1;
      const start = (page - 1) * perPage;
      return {
        versions: Array.from({ length: perPage }, (_, i) => version(start + i)),
        totalPages,
        page,
        truncation: null,
      };
    },
  );
  return { fetchVersions } as unknown as EcfrClientLike;
}

describe('fetchAllVersions', () => {
  it('pages through the whole history rather than stopping at page 1', async () => {
    // Title 12 really is 18,752 rows over 19 pages. Stopping at the first page would leave the
    // amendment table 95% empty while every chart still rendered.
    const client = pagingClient(19);
    const history = await fetchAllVersions(client, 12, log);
    expect(history.pagesFetched).toBe(19);
    expect(history.versions).toHaveLength(19_000);
    expect(history.totalPages).toBe(19);
  });

  it('takes a single unfiltered page at its word when it is short', async () => {
    const client = {
      fetchVersions: async (): Promise<VersionsResult> => ({
        versions: [version(1), version(2)],
        totalPages: 1,
        page: null,
        truncation: null,
      }),
    } as unknown as EcfrClientLike;
    const history = await fetchAllVersions(client, 1, log);
    expect(history.versions).toHaveLength(2);
    expect(history.pagesFetched).toBe(1);
  });

  it('REFUSES when the client ignores `page` instead of writing a partial history', async () => {
    // The dangerous failure: every request returns page 1, the loop "succeeds", and the table
    // holds 1,000 of 18,752 rows with nothing downstream able to tell. `meta.page` is null here
    // so this exercises the INFERENTIAL check — the page contributed no rows page 1 had not.
    const client = {
      fetchVersions: async (): Promise<VersionsResult> => ({
        versions: Array.from({ length: 1000 }, (_, i) => version(i)),
        totalPages: 19,
        page: null,
        truncation: null,
      }),
    } as unknown as EcfrClientLike;

    await expect(fetchAllVersions(client, 12, log)).rejects.toBeInstanceOf(
      VersionsPagingUnsupportedError,
    );
  });

  it('REFUSES on `meta.page` disagreeing with the page requested, before looking at the rows', async () => {
    // The exact check. This client returns DISTINCT rows for every request, so the inferential
    // "no new rows" test would never fire — but it labels every response page 1, which is upstream
    // saying outright that it ignored the parameter. Catching this is the difference between a
    // refusal and an amendment table that is silently one page deep.
    let call = 0;
    const client = {
      fetchVersions: async (): Promise<VersionsResult> => {
        const offset = call * 1000;
        call += 1;
        return {
          versions: Array.from({ length: 1000 }, (_, i) => version(offset + i)),
          totalPages: 19,
          page: 1,
          truncation: null,
        };
      },
    } as unknown as EcfrClientLike;

    await expect(fetchAllVersions(client, 12, log)).rejects.toThrow(/meta\.page=1/);
  });

  it('refuses a full page that reports no page count, rather than assuming it is the only one', async () => {
    const client = {
      fetchVersions: async (): Promise<VersionsResult> => ({
        versions: Array.from({ length: 1000 }, (_, i) => version(i)),
        totalPages: null,
        page: null,
        truncation: null,
      }),
    } as unknown as EcfrClientLike;
    await expect(fetchAllVersions(client, 12, log)).rejects.toThrow(/meta\.total_pages/);
  });

  it('drops rows that repeat the amendment primary key, and says how many', async () => {
    // eCFR's ordering is not strictly stable across requests, so a row can appear on two
    // pages. The upsert would collapse it anyway; counting it here means the logged row count
    // is a fact about the table rather than about the wire.
    let page = 0;
    const client = {
      fetchVersions: async (): Promise<VersionsResult> => {
        page += 1;
        return {
          versions: page === 1 ? [version(1), version(2)] : [version(2), version(3)],
          totalPages: 2,
          page,
          truncation: null,
        };
      },
    } as unknown as EcfrClientLike;

    const history = await fetchAllVersions(client, 3, log);
    expect(history.versions.map((v) => v.identifier)).toEqual(['1026.1', '1026.2', '1026.3']);
    expect(history.duplicatesDropped).toBe(1);
  });
});
