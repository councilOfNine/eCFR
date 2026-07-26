import type { StructureNode } from '@ecfr-atlas/core/ecfr-schemas';
import { describe, expect, it } from 'vitest';
import {
  assertFileBudget,
  buildManifest,
  FILE_BUDGET_LIMIT,
  FileBudgetError,
  MAX_ASSET_BYTES,
  planRender,
  SPLIT_THRESHOLD_BYTES,
  wrapFragment,
} from './render.js';
import { flattenStructure } from './structure.js';

function title(children: StructureNode[], number = 26): ReturnType<typeof flattenStructure> {
  return flattenStructure(
    {
      type: 'title',
      identifier: String(number),
      label: `Title ${number}`,
      children: [{ type: 'chapter', identifier: 'I', label: 'Chapter I', children }],
    },
    number,
  );
}

describe('planRender', () => {
  it('emits one unit per part when the part is small', () => {
    const plan = planRender(
      title([
        { type: 'part', identifier: '60', label: 'Part 60', size: 50_000 },
        { type: 'part', identifier: '61', label: 'Part 61', size: 900_000 },
      ]),
    );
    expect(plan.units).toHaveLength(2);
    expect(plan.units[0]?.route).toBe('/title-26/chapter-I/part-60');
    expect(plan.units[0]?.splitOf).toBeNull();
    expect(plan.splits).toHaveLength(0);
  });

  it('splits a part over 1 MB by its subparts', () => {
    const plan = planRender(
      title([
        {
          type: 'part',
          identifier: '60',
          label: 'Part 60',
          size: SPLIT_THRESHOLD_BYTES + 1,
          children: [
            { type: 'subpart', identifier: 'A', label: 'Subpart A', size: 600_000 },
            { type: 'subpart', identifier: 'B', label: 'Subpart B', size: 400_001 },
          ],
        },
      ]),
    );
    expect(plan.splits).toHaveLength(1);
    expect(plan.units.map((u) => u.route)).toEqual(['/title-26/chapter-I/part-60/A--B']);
    expect(plan.units[0]?.splitOf).toBe('title-26/chapter-I/part-60');
  });

  it('splits 26 CFR Part 1 even though it has no subparts', () => {
    // The real one is 69,598,633 bytes with sections as direct children — no subparts to
    // split by, and one file would blow the 25 MiB per-asset cap.
    const sections: StructureNode[] = Array.from({ length: 40 }, (_, i) => ({
      type: 'section',
      identifier: `1.${i + 1}`,
      label: `§ 1.${i + 1}`,
      size: 1_750_000,
    }));
    const plan = planRender(
      title([
        { type: 'part', identifier: '1', label: 'Part 1', size: 70_000_000, children: sections },
      ]),
    );

    expect(plan.splits[0]?.pieces).toBeGreaterThan(1);
    expect(plan.units.length).toBeGreaterThan(1);
    for (const unit of plan.units) {
      expect(unit.estimatedBytes).toBeLessThanOrEqual(MAX_ASSET_BYTES);
    }
    // Routes stay citable: a range of section identifiers, in document order.
    expect(plan.units[0]?.route).toMatch(/^\/title-26\/chapter-I\/part-1\/1\.1--1\.\d+$/);
  });

  it('never reorders siblings when packing', () => {
    const sections: StructureNode[] = Array.from({ length: 6 }, (_, i) => ({
      type: 'section',
      identifier: `1.${i + 1}`,
      label: `§ 1.${i + 1}`,
      size: 3_000_000,
    }));
    const plan = planRender(
      title([
        { type: 'part', identifier: '1', label: 'Part 1', size: 18_000_000, children: sections },
      ]),
    );
    const emitted = plan.units.flatMap((u) => u.citations);
    const expected = sections.map((s) => `title-26/chapter-I/part-1/section-${s.identifier}`);
    expect(emitted).toEqual(expected);
  });

  it('reports a leaf that cannot be split below the asset cap', () => {
    const plan = planRender(
      title([
        {
          type: 'part',
          identifier: '9',
          label: 'Part 9',
          size: 30 * 1024 * 1024,
          children: [
            { type: 'section', identifier: '9.1', label: '§ 9.1', size: 30 * 1024 * 1024 },
          ],
        },
      ]),
    );
    expect(plan.oversized).toHaveLength(1);
    expect(plan.oversized[0]?.citation).toBe('title-26/chapter-I/part-9/section-9.1');
  });

  it('emits a content key with no extension, which is what every consumer expects', () => {
    // One string, three consumers: the R2 object key, `structure_node.content_key` (which the
    // API appends to a public base), and the file the Astro build opens as
    // `content/${key}.html`. It used to end in `.html`, so the snapshot loader looked for
    // `…/part-60.html.html` and every part page in every deploy failed to resolve its body.
    const plan = planRender(
      title([{ type: 'part', identifier: '60', label: 'Part 60', size: 10 }]),
    );
    expect(plan.units[0]?.contentKey).toBe('parts/title-26/chapter-I/part-60');
    expect(plan.units[0]?.contentKey.startsWith('/')).toBe(false);
    expect(plan.units[0]?.contentKey.endsWith('.html')).toBe(false);
  });

  it('keys each slice of a split part separately', () => {
    const plan = planRender(
      title([
        {
          type: 'part',
          identifier: '60',
          label: 'Part 60',
          size: SPLIT_THRESHOLD_BYTES + 1,
          children: [
            { type: 'subpart', identifier: 'A', label: 'Subpart A', size: 900_000 },
            { type: 'subpart', identifier: 'B', label: 'Subpart B', size: 3_500_000 },
          ],
        },
      ]),
    );
    expect(plan.units.map((u) => u.contentKey)).toEqual([
      'parts/title-26/chapter-I/part-60/A',
      'parts/title-26/chapter-I/part-60/B',
    ]);
    // Distinct keys are what stops two slices overwriting each other in the bucket.
    expect(new Set(plan.units.map((u) => u.contentKey)).size).toBe(plan.units.length);
  });

  it('strips slashes from identifiers so a route level cannot be invented', () => {
    const plan = planRender(
      title([{ type: 'part', identifier: '60/A', label: 'Part 60/A', size: 100 }]),
    );
    expect(plan.units[0]?.route).toBe('/title-26/chapter-I/part-60-A');
  });
});

describe('file budget', () => {
  it('accepts the planned site', () => {
    // Dashboard + 316 agencies + 49 titles + 473 chapters + 9,664 parts + subpart splits.
    const { total, warn } = assertFileBudget({
      staticPages: 8,
      agencies: 316,
      titles: 49,
      chapters: 473,
      partPages: 10_300,
    });
    expect(total).toBe(11_146);
    expect(warn).toBe(false);
  });

  it('warns inside the band before the ceiling', () => {
    expect(
      assertFileBudget({
        staticPages: 8,
        agencies: 316,
        titles: 49,
        chapters: 473,
        partPages: 16_000,
      }).warn,
    ).toBe(true);
  });

  it('FAILS above 18,000 rather than at deploy time', () => {
    expect(() =>
      assertFileBudget({
        staticPages: 8,
        agencies: 316,
        titles: 49,
        chapters: 473,
        partPages: 18_000,
      }),
    ).toThrow(FileBudgetError);

    try {
      assertFileBudget({
        staticPages: 8,
        agencies: 316,
        titles: 49,
        chapters: 473,
        partPages: 18_000,
      });
    } catch (error) {
      // The message has to name the breakdown; "too many files" is useless in CI.
      const message = (error as Error).message;
      expect(message).toContain('18,846');
      expect(message).toContain('473 chapters');
      expect(message).toContain('18,000 part pages');
      expect(message).toContain(FILE_BUDGET_LIMIT.toLocaleString('en-US'));
    }
  });

  it('buildManifest refuses to produce a manifest that would not deploy', () => {
    expect(() =>
      buildManifest(
        1,
        '2026-07-25',
        { units: [], splits: [], oversized: [] },
        {
          staticPages: 0,
          agencies: 0,
          titles: 0,
          chapters: 0,
          partPages: 20_000,
        },
      ),
    ).toThrow(FileBudgetError);
  });

  it('manifest records the run, source date and budget', () => {
    const manifest = buildManifest(
      42,
      '2026-07-25',
      { units: [], splits: [], oversized: [] },
      {
        staticPages: 8,
        agencies: 316,
        titles: 49,
        chapters: 473,
        partPages: 100,
      },
    );
    expect(manifest.runId).toBe(42);
    expect(manifest.sourceDate).toBe('2026-07-25');
    expect(manifest.budget.platformCap).toBe(20_000);
    expect(manifest.totalFiles).toBe(946);
  });
});

describe('wrapFragment', () => {
  it('always carries a link back to the official eCFR text', () => {
    const html = wrapFragment({
      citation: 'title-40/chapter-I/part-60',
      displayCitation: '40 CFR Part 60',
      sourceUrl: 'https://www.ecfr.gov/current/title-40/chapter-I/part-60',
      sourceDate: '2026-07-25',
      bodyHtml: '<p>text</p>',
    });
    expect(html).toContain('https://www.ecfr.gov/current/title-40/chapter-I/part-60');
    expect(html).toContain('2026-07-25');
    expect(html).toContain('<p>text</p>');
  });

  it('escapes attribute content', () => {
    const html = wrapFragment({
      citation: '"><script>alert(1)</script>',
      displayCitation: '40 CFR',
      sourceUrl: 'https://example.test/?a=1&b=2',
      sourceDate: null,
      bodyHtml: '',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&amp;b=2');
  });
});
