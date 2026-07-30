import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Measurement } from '@ecfr-atlas/core';
import { counted, reservedEmpty, unavailable } from '@ecfr-atlas/core';
import type { StructureNode } from '@ecfr-atlas/core/ecfr-schemas';
import { findNode, measureNode, measureOwnText, parseXml } from '@ecfr-atlas/ecfr';
import { describe, expect, it } from 'vitest';

import {
  containersOf,
  flattenStructure,
  indexByCitation,
  leavesOf,
  rollUpTree,
} from './structure.js';

describe('flattenStructure', () => {
  it('builds full ancestry-path citations', () => {
    const nodes = flattenStructure(
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
              {
                type: 'subchapter',
                identifier: 'C',
                label: 'Subchapter C',
                children: [
                  {
                    type: 'part',
                    identifier: '60',
                    label: 'Part 60',
                    children: [{ type: 'section', identifier: '60.1', label: '§ 60.1' }],
                  },
                ],
              },
            ],
          },
        ],
      },
      40,
    );

    expect(nodes.map((n) => n.citation)).toEqual([
      'title-40',
      'title-40/chapter-I',
      'title-40/chapter-I/subchapter-C',
      'title-40/chapter-I/subchapter-C/part-60',
      'title-40/chapter-I/subchapter-C/part-60/section-60.1',
    ]);
  });

  it('denormalises ancestry onto descendants but not onto the node itself', () => {
    const nodes = flattenStructure(
      {
        type: 'title',
        identifier: '40',
        label: 'T',
        children: [
          {
            type: 'chapter',
            identifier: 'I',
            label: 'C',
            children: [{ type: 'part', identifier: '60', label: 'P' }],
          },
        ],
      },
      40,
    );
    const chapter = nodes.find((n) => n.nodeType === 'chapter');
    const part = nodes.find((n) => n.nodeType === 'part');
    // A chapter row does not restate its own identifier in chapter_id…
    expect(chapter?.chapterId).toBeNull();
    // …but its descendants do carry it, which is what makes the TOC query a range scan.
    expect(part?.chapterId).toBe('I');
    expect(part?.partId).toBeNull();
  });

  it('survives non-sequential levels (title 7 jumps DIV2 -> DIV5 thirty-five times)', () => {
    const nodes = flattenStructure(
      {
        type: 'title',
        identifier: '7',
        label: 'T',
        children: [{ type: 'part', identifier: '1', label: 'P' }],
      },
      7,
    );
    expect(nodes[1]?.citation).toBe('title-7/part-1');
    expect(nodes[1]?.chapterId).toBeNull();
  });

  it('gives positional segments to the 151 nodes with a null identifier', () => {
    const nodes = flattenStructure(
      {
        type: 'title',
        identifier: '1',
        label: 'T',
        children: [
          { type: 'subject_group', identifier: null, label: 'Group A' },
          { type: 'subject_group', identifier: null, label: 'Group B' },
        ],
      },
      1,
    );
    expect(nodes[1]?.citation).toBe('title-1/subject_group-@0');
    expect(nodes[2]?.citation).toBe('title-1/subject_group-@1');
    // Uniqueness is the whole point — citation is the natural key in structure_node.
    expect(new Set(nodes.map((n) => n.citation)).size).toBe(nodes.length);
  });
});

describe('rollUpTree', () => {
  const tree = flattenStructure(
    {
      type: 'title',
      identifier: '1',
      label: 'T',
      children: [
        {
          type: 'part',
          identifier: '1',
          label: 'P1',
          children: [
            { type: 'section', identifier: '1.1', label: 'S' },
            { type: 'section', identifier: '1.2', label: 'S' },
          ],
        },
        { type: 'part', identifier: '2', label: 'P2', reserved: true },
      ],
    },
    1,
  );

  it('sums measured leaves into their ancestors', () => {
    const leaves = new Map<string, Measurement>([
      ['title-1/part-1/section-1.1', counted(100)],
      ['title-1/part-1/section-1.2', counted(200)],
    ]);
    const resolved = rollUpTree(tree, leaves);
    expect(resolved.get('title-1/part-1')).toMatchObject({ known: true, words: 300 });
    // Reserved and childless: genuinely zero, not unknown.
    expect(resolved.get('title-1/part-2')).toEqual(reservedEmpty());
    expect(resolved.get('title-1')).toMatchObject({ known: true, words: 300 });
  });

  it('propagates a single unknown leaf all the way to the title', () => {
    const leaves = new Map<string, Measurement>([
      ['title-1/part-1/section-1.1', counted(100)],
      [
        'title-1/part-1/section-1.2',
        unavailable('unavailable_fetch_failed', 'eCFR returned 504 after the retry budget'),
      ],
    ]);
    const resolved = rollUpTree(tree, leaves);
    // NOT 100. An under-report is indistinguishable from a real number.
    expect(resolved.get('title-1/part-1')?.known).toBe(false);
    expect(resolved.get('title-1')?.known).toBe(false);
  });

  it('marks an unmeasured leaf unknown rather than zero', () => {
    const resolved = rollUpTree(tree, new Map());
    const leaf = resolved.get('title-1/part-1/section-1.1');
    expect(leaf?.known).toBe(false);
    expect(leaf).toMatchObject({ status: 'not_computed' });
  });
});

describe('rollUpTree own text', () => {
  const tree = flattenStructure(
    {
      type: 'title',
      identifier: '1',
      label: 'T',
      children: [
        {
          type: 'part',
          identifier: '1',
          label: 'P1',
          children: [
            { type: 'section', identifier: '1.1', label: 'S' },
            { type: 'section', identifier: '1.2', label: 'S' },
          ],
        },
      ],
    },
    1,
  );

  const leaves = new Map<string, Measurement>([
    ['title-1/part-1/section-1.1', counted(100)],
    ['title-1/part-1/section-1.2', counted(200)],
  ]);

  it('adds a container OWN text to the sum of its children', () => {
    // 29 CFR 1910 really does carry 146 words directly under the part. Composing the part from
    // its sections alone drops them, and an under-report reads as a plausible number.
    const own = new Map<string, Measurement>([['title-1/part-1', counted(146)]]);
    expect(rollUpTree(tree, leaves, own).get('title-1/part-1')).toMatchObject({
      known: true,
      words: 446,
    });
  });

  it('is unchanged when the container owns nothing, which is the common case', () => {
    const own = new Map<string, Measurement>([['title-1/part-1', counted(0)]]);
    expect(rollUpTree(tree, leaves, own).get('title-1/part-1')).toMatchObject({ words: 300 });
    expect(rollUpTree(tree, leaves).get('title-1/part-1')).toMatchObject({ words: 300 });
  });

  it('measures a part with no sections at all rather than calling it unknown', () => {
    // Before own text existed this fell through to `no descendants to roll up` — safe, but a
    // mass of spurious unknowns for parts whose text simply sits directly under them.
    const bare = flattenStructure(
      {
        type: 'title',
        identifier: '9',
        label: 'T',
        children: [{ type: 'part', identifier: '2', label: 'P' }],
      },
      9,
    );
    const own = new Map<string, Measurement>([['title-9/part-2', counted(87)]]);
    expect(rollUpTree(bare, new Map(), own).get('title-9/part-2')).toMatchObject({
      known: true,
      words: 87,
    });
    // …and with nothing measured it is still honestly unknown, never 0.
    expect(rollUpTree(bare, new Map()).get('title-9/part-2')?.known).toBe(false);
  });

  it('propagates an unknown own-text measurement instead of ignoring it', () => {
    const own = new Map<string, Measurement>([
      ['title-1/part-1', unavailable('unavailable_too_large', 'over the per-node ceiling')],
    ]);
    expect(rollUpTree(tree, leaves, own).get('title-1/part-1')?.known).toBe(false);
  });

  it('measures own text for parts and below, never for the levels above', () => {
    // A backfill sees the whole title and a delta only sees `?part=` slices. Measuring above
    // the part would make the two paths disagree; the CFR carries only HEAD/AUTH/SOURCE up
    // there, all excluded from the count, so nothing is lost by the bound.
    expect(containersOf(tree).map((n) => n.citation)).toEqual(['title-1/part-1']);
  });
});

describe('leaf composition against a real fixture', () => {
  /**
   * The identity the roll-up now holds BY CONSTRUCTION:
   *
   *     measureNode(part) === measureOwnText(part) + Σ measureNode(section)
   *
   * 3 CFR Part 101 is a real captured part with a HEAD, an AUTH and a SOURCE above its
   * sections — exactly the apparatus that would break the identity if it were counted, and
   * exactly the shape that makes "leaves are enough" look true until one day it is not.
   */
  const xml = readFileSync(
    fileURLToPath(
      new URL('../../../fixtures/xml/title-3-part-101-2024-05-17.xml', import.meta.url),
    ),
    'utf8',
  );
  const structure = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../fixtures/raw/structure-3.json', import.meta.url)),
      'utf8',
    ),
  ) as StructureNode;

  it('sum(leaves) + own == whole, and rollUpTree reproduces it exactly', () => {
    const doc = parseXml(xml);
    const nodes = flattenStructure(structure, 3);
    const part = nodes.find((n) => n.nodeType === 'part' && n.identifier === '101');
    expect(part, '3 CFR Part 101 is in the captured structure').toBeDefined();

    const partElement = findNode(doc, { type: 'part', identifier: '101' });
    expect(partElement).not.toBeNull();
    const whole = measureNode(partElement);
    const own = measureOwnText(partElement);
    expect(whole.known && own.known).toBe(true);

    const leafNodes = leavesOf(nodes).filter((n) =>
      n.citation.startsWith(`${part?.citation ?? ''}/`),
    );
    expect(leafNodes.length).toBeGreaterThan(0);

    const leafMeasurements = new Map<string, Measurement>();
    let leafTotal = 0;
    for (const leaf of leafNodes) {
      // `leavesOf` selects exactly LEAF_TYPES, so the narrowing is sound; `FlatNode.nodeType`
      // is a plain string because the structure JSON can name a level we do not model.
      const element = findNode(doc, {
        type: leaf.nodeType as 'section' | 'appendix',
        identifier: leaf.identifier ?? '',
      });
      const measurement = measureNode(element);
      expect(measurement.known, leaf.citation).toBe(true);
      leafMeasurements.set(leaf.citation, measurement);
      leafTotal += measurement.known ? measurement.words : 0;
    }

    const ownWords = own.known ? own.words : Number.NaN;
    const wholeWords = whole.known ? whole.words : Number.NaN;
    expect(leafTotal + ownWords).toBe(wholeWords);

    // And the pipeline's own composition agrees with the parser's, which is the point: the
    // number the site publishes for a part equals the number a direct measurement gives.
    const resolved = rollUpTree(nodes, leafMeasurements, new Map([[part?.citation ?? '', own]]));
    expect(resolved.get(part?.citation ?? '')).toMatchObject({ known: true, words: wholeWords });
  });
});

describe('helpers', () => {
  it('selects only text-bearing leaf types', () => {
    const nodes = flattenStructure(
      {
        type: 'title',
        identifier: '1',
        label: 'T',
        children: [
          {
            type: 'part',
            identifier: '1',
            label: 'P',
            children: [
              { type: 'section', identifier: '1.1', label: 'S' },
              { type: 'appendix', identifier: 'A', label: 'A' },
              { type: 'subject_group', identifier: 'g', label: 'G' },
            ],
          },
        ],
      },
      1,
    );
    expect(
      leavesOf(nodes)
        .map((n) => n.nodeType)
        .sort(),
    ).toEqual(['appendix', 'section']);
    expect(indexByCitation(nodes).get('title-1/part-1')?.label).toBe('P');
  });
});

describe('rollUpTree structurally empty leaves', () => {
  it('measures a zero-byte leaf as structurally_empty instead of vetoing every ancestor', () => {
    // Real shape: 18 CFR 101's uniform-system-of-accounts headings are hed1 nodes with no
    // identifier and a declared size of zero. As not_computed they nulled the corpus total.
    const nodes = flattenStructure(
      {
        type: 'title',
        identifier: '18',
        label: 'Title 18',
        size: 150,
        children: [
          {
            type: 'part',
            identifier: '101',
            label: 'Part 101',
            size: 150,
            children: [
              { type: 'hed1', label: 'Income Accounts', size: 0 },
              { type: 'section', identifier: '101.1', label: '§ 101.1', size: 150 },
            ],
          },
        ],
      },
      18,
    );
    const hed1 = nodes.find((n) => n.nodeType === 'hed1');
    expect(hed1).toBeDefined();
    const leaves = new Map([['title-18/part-101/section-101.1', counted(150)]]);

    const resolved = rollUpTree(nodes, leaves);

    expect(resolved.get(hed1?.citation ?? '')).toMatchObject({
      known: true,
      words: 0,
      status: 'structurally_empty',
      method: 'declared_empty',
    });
    expect(resolved.get('title-18/part-101')).toMatchObject({ known: true, words: 150 });
    expect(resolved.get('title-18')).toMatchObject({ known: true, words: 150 });
  });

  it('a positive-size leaf with no measured XML still propagates unknown', () => {
    const nodes = flattenStructure(
      {
        type: 'title',
        identifier: '1',
        label: 'T',
        size: 90,
        children: [{ type: 'section', identifier: '1.1', label: 'S', size: 90 }],
      },
      1,
    );
    const resolved = rollUpTree(nodes, new Map());
    expect(resolved.get('title-1/section-1.1')).toMatchObject({
      known: false,
      status: 'not_computed',
    });
    expect(resolved.get('title-1')).toMatchObject({ known: false });
  });

  it('an undeclared size is not a declared zero', () => {
    const nodes = flattenStructure(
      {
        type: 'title',
        identifier: '1',
        label: 'T',
        children: [{ type: 'hed1', label: 'Heading' }],
      },
      1,
    );
    const hed1 = nodes.find((n) => n.nodeType === 'hed1');
    const resolved = rollUpTree(nodes, new Map());
    expect(resolved.get(hed1?.citation ?? '')).toMatchObject({
      known: false,
      status: 'not_computed',
    });
  });

  it('the reserved flag wins over the size fingerprint', () => {
    const nodes = flattenStructure(
      {
        type: 'title',
        identifier: '1',
        label: 'T',
        size: 0,
        children: [{ type: 'part', identifier: '9', label: 'P', reserved: true, size: 0 }],
      },
      1,
    );
    const resolved = rollUpTree(nodes, new Map());
    expect(resolved.get('title-1/part-9')).toMatchObject({
      known: true,
      words: 0,
      status: 'reserved_empty',
    });
  });
});
