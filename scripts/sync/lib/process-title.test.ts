/**
 * Regression pin for the cross-part contamination that shipped in the first full-corpus
 * render: every part has a subpart A, a bare identifier search from the title root returns
 * the first one in document order, and part 431's "A--Z" slice page came out carrying part
 * 1's and part 2's text under a part-431 banner. Measurements were never wrong — section
 * identifiers embed their part number — which is exactly why nothing upstream of the
 * rendered HTML could have caught it.
 */

import { describe, expect, it } from 'vitest';

import { loadEcfr } from './ecfr-adapter.js';
import { processTitleXml } from './process-title.js';
import type { RenderUnit } from './render.js';
import { containersOf, flattenStructure, indexByCitation, leavesOf } from './structure.js';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
  time: <T>(_label: string, fn: () => Promise<T>) => fn(),
  // biome-ignore lint/suspicious/noExplicitAny: minimal structural stand-in for tests
} as any;

/** Two parts, both with a subpart A, with unmistakably different body text. */
const XML = `<DIV1 TYPE="TITLE" N="10">
  <DIV3 TYPE="CHAPTER" N="I">
    <DIV5 TYPE="PART" N="1">
      <HEAD>PART 1—FIRST</HEAD>
      <DIV6 TYPE="SUBPART" N="A">
        <HEAD>Subpart A—General</HEAD>
        <DIV8 TYPE="SECTION" N="1.1">
          <HEAD>§ 1.1 First.</HEAD>
          <P>alpha text belonging to part one only</P>
        </DIV8>
      </DIV6>
    </DIV5>
    <DIV5 TYPE="PART" N="2">
      <HEAD>PART 2—SECOND</HEAD>
      <DIV6 TYPE="SUBPART" N="A">
        <HEAD>Subpart A—General</HEAD>
        <DIV8 TYPE="SECTION" N="2.1">
          <HEAD>§ 2.1 Second.</HEAD>
          <P>bravo text belonging to part two only</P>
        </DIV8>
      </DIV6>
    </DIV5>
  </DIV3>
</DIV1>`;

const structure = {
  type: 'title',
  identifier: '10',
  label: 'Title 10',
  children: [
    {
      type: 'chapter',
      identifier: 'I',
      label: 'Chapter I',
      children: [
        {
          type: 'part',
          identifier: '1',
          label: 'Part 1',
          children: [
            {
              type: 'subpart',
              identifier: 'A',
              label: 'Subpart A',
              children: [{ type: 'section', identifier: '1.1', label: '§ 1.1' }],
            },
          ],
        },
        {
          type: 'part',
          identifier: '2',
          label: 'Part 2',
          children: [
            {
              type: 'subpart',
              identifier: 'A',
              label: 'Subpart A',
              children: [{ type: 'section', identifier: '2.1', label: '§ 2.1' }],
            },
          ],
        },
      ],
    },
  ],
};

describe('processTitleXml part scoping', () => {
  it("a split unit renders its own part's subpart, not the first same-named subpart in the title", async () => {
    const ecfr = await loadEcfr();
    const flat = flattenStructure(structure, 10);

    // Part 2 split at its direct children, exactly how the planner slices oversized parts.
    const unit: RenderUnit = {
      route: '/title/10/part/2/A',
      titleNumber: 10,
      partCitation: 'title-10/chapter-I/part-2',
      citations: ['title-10/chapter-I/part-2/subpart-A'],
      contentKey: 'parts/title-10/chapter-I/part-2/A',
      label: 'Part 2 — A',
      estimatedBytes: 1,
      splitOf: 'title-10/chapter-I/part-2',
    };

    const rendered: string[] = [];
    const measured = new Map<string, unknown>();
    await processTitleXml(
      ecfr,
      {
        titleNumber: 10,
        sourceDate: '2026-07-28',
        xml: XML,
        leaves: leavesOf(flat),
        containers: containersOf(flat),
        units: [unit],
        byCitation: indexByCitation(flat),
        onLeaf: (citation, m) => void measured.set(citation, m),
        onOwnText: () => {},
        onUnit: async (_u, html) => void rendered.push(html),
      },
      silentLogger,
    );

    expect(rendered).toHaveLength(1);
    const html = rendered[0] ?? '';
    expect(html).toContain('bravo text belonging to part two only');
    // The regression: the global search resolved part 2's subpart A to part 1's.
    expect(html).not.toContain('alpha text belonging to part one only');

    // Both sections still measure, each from its own part.
    expect(measured.get('title-10/chapter-I/part-1/subpart-A/section-1.1')).toMatchObject({
      known: true,
    });
    expect(measured.get('title-10/chapter-I/part-2/subpart-A/section-2.1')).toMatchObject({
      known: true,
    });
  });
});
