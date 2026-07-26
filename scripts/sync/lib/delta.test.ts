import { describe, expect, it } from 'vitest';
import type { TitleWatermark } from './delta.js';
import {
  diffStructureSizes,
  ImportInProgressError,
  planRefetch,
  planTitleDelta,
  summariseVersions,
  versionsWindowStart,
} from './delta.js';
import type { FlatNode } from './structure.js';
import { flattenStructure } from './structure.js';

function title(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    name: `Title ${number}`,
    latest_amended_on: '2026-07-24',
    latest_issue_date: '2026-07-24',
    up_to_date_as_of: '2026-07-25',
    reserved: false,
    ...overrides,
  };
}

function watermark(titleNumber: number, amendedOn: string | null): TitleWatermark {
  return {
    titleNumber,
    latestAmendedOn: amendedOn,
    latestIssueDate: amendedOn,
    lastSyncedAt: '2026-07-24T03:00:00Z',
  };
}

describe('(a) title-level change detection', () => {
  it('aborts the entire run when eCFR is mid-import', () => {
    expect(() =>
      planTitleDelta({ titles: [title(1)], meta: { import_in_progress: true } }, []),
    ).toThrow(ImportInProgressError);
  });

  it('marks a title dirty only when latest_amended_on moved', () => {
    const plan = planTitleDelta(
      { titles: [title(1), title(2, { latest_amended_on: '2026-07-25' })] },
      [watermark(1, '2026-07-24'), watermark(2, '2026-07-24')],
    );
    expect(plan.dirty.map((d) => d.number)).toEqual([2]);
    expect(plan.unchanged).toEqual([1]);
    expect(plan.dirty[0]?.reason).toBe('amended');
  });

  it('IGNORES up_to_date_as_of, which advances daily for all 49 titles', () => {
    // Keying on up_to_date_as_of would mark the whole corpus dirty every night and silently
    // turn the delta back into a 331-second backfill.
    const plan = planTitleDelta({ titles: [title(1, { up_to_date_as_of: '2026-08-01' })] }, [
      watermark(1, '2026-07-24'),
    ]);
    expect(plan.dirty).toHaveLength(0);
  });

  it('treats a title with no watermark as never synced', () => {
    const plan = planTitleDelta({ titles: [title(7)] }, []);
    expect(plan.dirty[0]?.reason).toBe('never_synced');
  });

  it('skips title 35, whose three date fields are all null', () => {
    const plan = planTitleDelta(
      {
        titles: [
          title(35, {
            reserved: true,
            latest_amended_on: null,
            latest_issue_date: null,
            up_to_date_as_of: null,
          }),
        ],
      },
      [],
    );
    expect(plan.reserved).toEqual([35]);
    expect(plan.dirty).toHaveLength(0);
  });

  it('skips a non-reserved title whose amended date is null rather than throwing', () => {
    const plan = planTitleDelta({ titles: [title(9, { latest_amended_on: null })] }, []);
    expect(plan.reserved).toEqual([9]);
  });
});

describe('(b) version summarising', () => {
  const version = (overrides: Record<string, unknown> = {}) => ({
    date: '2026-07-25',
    amendment_date: '2019-03-01',
    issue_date: '2026-07-25',
    identifier: '60.1',
    name: '§ 60.1 Applicability',
    part: '60',
    subpart: null,
    title: '40',
    type: 'section',
    removed: false,
    substantive: true,
    ...overrides,
  });

  it('separates substantive from non-substantive and flags removals', () => {
    const summary = summariseVersions([
      version(),
      version({ identifier: '60.2', substantive: false }),
      version({ identifier: '60.3', removed: true }),
    ]);
    expect(summary.all).toHaveLength(3);
    expect(summary.substantive).toHaveLength(2);
    expect(summary.removed).toHaveLength(1);
    expect([...summary.parts]).toEqual(['60']);
  });

  it('flags an exactly-full page as possibly truncated', () => {
    // eCFR omits meta.total_pages on FILTERED responses, so 1,000 rows is indistinguishable
    // from "1,000 rows and more you cannot see".
    const rows = Array.from({ length: 1000 }, (_, i) => version({ identifier: `60.${i}` }));
    expect(summariseVersions(rows).possiblyTruncated).toBe(true);
    expect(summariseVersions(rows.slice(0, 999)).possiblyTruncated).toBe(false);
  });

  it('windows on issue_date, never amendment_date', () => {
    // 40.4% of amendment_dates predate eCFR's 2017-01-01 full-text horizon.
    expect(versionsWindowStart(watermark(1, '2026-07-24'))).toBe('2026-07-24');
    expect(versionsWindowStart(undefined)).toBeUndefined();
  });
});

describe('(c) structure size fingerprinting', () => {
  function fixture(sizes: Record<string, number | null>): FlatNode[] {
    return flattenStructure(
      {
        type: 'title',
        identifier: '40',
        label: 'Title 40',
        size: 999,
        children: [
          {
            type: 'chapter',
            identifier: 'I',
            label: 'Chapter I',
            size: 999,
            children: Object.entries(sizes).map(([identifier, size]) => ({
              type: 'part',
              identifier,
              label: `Part ${identifier}`,
              size,
            })),
          },
        ],
      },
      40,
    );
  }

  it('skips parts whose additive byte size is identical', () => {
    const nodes = fixture({ '60': 1000, '61': 2000, '62': 3000 });
    const stored = new Map([
      ['title-40/chapter-I/part-60', 1000],
      ['title-40/chapter-I/part-61', 2500],
      ['title-40/chapter-I/part-62', 3000],
    ]);
    const diff = diffStructureSizes(nodes, stored);
    expect(diff.unchanged).toBe(2);
    expect(diff.changed.map((n) => n.identifier)).toEqual(['61']);
    expect(diff.added).toHaveLength(0);
  });

  it('treats a part with no stored row as new', () => {
    const diff = diffStructureSizes(fixture({ '60': 1000 }), new Map());
    expect(diff.added.map((n) => n.identifier)).toEqual(['60']);
  });

  it('treats an unknown size as changed — we cannot prove it did not move', () => {
    const nodes = fixture({ '60': null });
    const diff = diffStructureSizes(nodes, new Map([['title-40/chapter-I/part-60', 1000]]));
    expect(diff.sizeUnknown).toBe(1);
    expect(diff.changed).toHaveLength(1);
  });

  it('reports citations that vanished from the structure', () => {
    const diff = diffStructureSizes(
      fixture({ '60': 1000 }),
      new Map([
        ['title-40/chapter-I/part-60', 1000],
        ['title-40/chapter-I/part-99', 500],
      ]),
    );
    expect(diff.removedCitations).toEqual(['title-40/chapter-I/part-99']);
  });
});

describe('(d) refetch planning', () => {
  const parts = flattenStructure(
    {
      type: 'title',
      identifier: '40',
      label: 'Title 40',
      children: [
        {
          type: 'chapter',
          identifier: 'I',
          label: 'Chapter I',
          children: [
            { type: 'part', identifier: '60', label: 'Part 60', size: 100 },
            { type: 'part', identifier: '61', label: 'Part 61', size: 200 },
            { type: 'part', identifier: '62', label: 'Part 62', size: 300 },
          ],
        },
      ],
    },
    40,
  ).filter((n) => n.nodeType === 'part');

  const emptyVersions = summariseVersions([]);

  it('unions size-changed parts with version-named parts', () => {
    const diff = {
      changed: [parts[0] as FlatNode],
      added: [],
      removedCitations: [],
      unchanged: 2,
      sizeUnknown: 0,
    };
    const versions = summariseVersions([
      {
        date: '2026-07-25',
        amendment_date: '2026-07-20',
        issue_date: '2026-07-25',
        identifier: '62.1',
        name: '§ 62.1',
        part: '62',
        subpart: null,
        title: '40',
        type: 'section',
        removed: false,
        substantive: true,
      },
    ]);

    const targets = planRefetch(40, diff, versions, parts);
    expect(targets.map((t) => t.part).sort()).toEqual(['60', '62']);
    expect(targets.find((t) => t.part === '60')?.reason).toBe('size_changed');
    expect(targets.find((t) => t.part === '62')?.reason).toBe('version_named');
  });

  it('refetches the whole title when the versions window may be truncated', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      date: '2026-07-25',
      amendment_date: '2026-07-20',
      issue_date: '2026-07-25',
      identifier: `60.${i}`,
      name: 'x',
      part: '60',
      subpart: null,
      title: '40',
      type: 'section',
      removed: false,
      substantive: true,
    }));
    const targets = planRefetch(
      40,
      { changed: [], added: [], removedCitations: [], unchanged: 3, sizeUnknown: 0 },
      summariseVersions(rows),
      parts,
    );
    expect(targets).toHaveLength(3);
    expect(targets[0]?.reason).toBe('versions_truncated');
  });

  it('deduplicates a part flagged by both signals', () => {
    const versions = summariseVersions([
      {
        date: '2026-07-25',
        amendment_date: '2026-07-20',
        issue_date: '2026-07-25',
        identifier: '60.1',
        name: 'x',
        part: '60',
        subpart: null,
        title: '40',
        type: 'section',
        removed: false,
        substantive: true,
      },
    ]);
    const targets = planRefetch(
      40,
      {
        changed: [parts[0] as FlatNode],
        added: [],
        removedCitations: [],
        unchanged: 2,
        sizeUnknown: 0,
      },
      versions,
      parts,
    );
    expect(targets).toHaveLength(1);
  });

  it('plans nothing when nothing moved', () => {
    const targets = planRefetch(
      40,
      { changed: [], added: [], removedCitations: [], unchanged: 3, sizeUnknown: 0 },
      emptyVersions,
      parts,
    );
    expect(targets).toHaveLength(0);
  });
});
