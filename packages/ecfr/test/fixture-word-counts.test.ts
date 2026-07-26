/**
 * Exact word counts against committed, unmodified eCFR XML.
 *
 * The other counter tests are synthetic: they check the tokenisation rule on strings written to
 * exercise it. This one checks the whole pipeline — parse, exclude, walk, count — against three
 * real documents fetched from eCFR and committed verbatim under fixtures/xml/. The numbers
 * below were produced by this code and then verified by hand against the source text.
 *
 * Two properties are asserted that a synthetic input cannot show:
 *
 *   1. A part's count equals the sum of its sections' counts, EXACTLY. That identity only holds
 *      if every piece of apparatus between them — the part HEAD, the AUTH line, the SOURCE line,
 *      each section's own HEAD — contributes zero. It is a single assertion that covers the
 *      entire boilerplate exclusion, and it fails loudly if any excluded tag is ever dropped
 *      from the list.
 *
 *   2. The boilerplate is a MATERIAL share of the document. Measured at 18.4% of 1 CFR
 *      Chapter I. Without this, an exclusion list that had silently stopped matching anything
 *      would still satisfy property 1 — because zero equals zero.
 *
 * If eCFR revises one of these parts the counts change and this file fails. That is correct:
 * the fixtures are pinned by issue date, and a changed count means somebody replaced a pinned
 * file. Regenerate deliberately with `node scripts/build-fixtures.ts` after deleting the file.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  childStructureNodes,
  countWords,
  EXCLUDED_FROM_COUNT,
  extractText,
  findNode,
  headText,
  isElement,
  isText,
  measureNode,
  measureXml,
  parseXml,
  type XmlElement,
  type XmlNode,
} from '../src/index.js';

const FIXTURES = new URL('../../../fixtures/xml/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

const PART_51 = read('title-1-part-51-2024-05-17.xml');
const PART_101 = read('title-3-part-101-2024-05-17.xml');
const TITLE_3 = read('title-3-full-2024-05-17.xml');

function words(measurement: ReturnType<typeof measureXml>): number {
  if (!measurement.known) {
    throw new Error(`expected a count, got ${measurement.status}: ${measurement.reason}`);
  }
  return measurement.words;
}

describe('1 CFR Part 51 — Incorporation by Reference', () => {
  const root = parseXml(PART_51);
  const part = findNode(root, { type: 'part', identifier: '51' }) as XmlElement;

  it('counts 1,231 words', () => {
    expect(words(measureNode(part))).toBe(1231);
  });

  it('counts each section', () => {
    // Six sections, numbered oddly (51.1, 51.3, 51.5 ...) because eCFR leaves gaps for future
    // insertions. Listed individually so a change is attributable to one section.
    const expected: Record<string, number> = {
      '51.1': 295,
      '51.3': 187,
      '51.5': 226,
      '51.7': 196,
      '51.9': 209,
      '51.11': 118,
    };
    for (const [identifier, count] of Object.entries(expected)) {
      expect(words(measureXml(PART_51, { type: 'section', identifier })), identifier).toBe(count);
    }
  });

  it("the part's count is EXACTLY the sum of its sections", () => {
    // The whole boilerplate exclusion in one assertion. The part carries a HEAD, an AUTH line
    // and a SOURCE line of its own, and each section carries a HEAD; if any of them were
    // counted, this identity would not hold.
    const sections = childStructureNodes(part);
    expect(sections).toHaveLength(6);

    const sum = sections.reduce((total, section) => total + words(measureNode(section)), 0);
    expect(sum).toBe(words(measureNode(part)));
    expect(sum).toBe(1231);
  });
});

describe('3 CFR Part 101 — Public Information Provisions', () => {
  const root = parseXml(PART_101);
  const part = findNode(root, { type: 'part', identifier: '101' }) as XmlElement;

  it('counts 164 words across seven sections', () => {
    expect(words(measureNode(part))).toBe(164);
    const sections = childStructureNodes(part);
    expect(sections).toHaveLength(7);
    expect(sections.reduce((sum, s) => sum + words(measureNode(s)), 0)).toBe(164);
  });

  it('excludes the authority line, the source line and the headings from the text', () => {
    const text = extractText(part);

    // AUTH: "Authority: 5 U.S.C. 552." Only the label is asserted on — the citation itself
    // also appears in the body of § 101.1, which is regulation and must survive.
    expect(text).not.toContain('Authority');
    expect(text).toContain('to the extent that 5 U.S.C. 552 is applicable');
    // SOURCE: "Source: 40 FR 8061, Feb. 25, 1975; ... unless otherwise noted."
    expect(text).not.toContain('unless otherwise noted');
    expect(text).not.toContain('40 FR 8061');
    // HEAD: the part title, and each section's own heading.
    expect(text).not.toContain('PUBLIC INFORMATION PROVISIONS');
    expect(text).not.toContain('Executive Office of the President.');

    // But the regulation itself is all there.
    expect(text).toContain('Until further regulations are promulgated');
  });

  it('the excluded apparatus is a material share of the document', () => {
    // Guards against an exclusion list that has silently stopped matching. Without this, an
    // EXCLUDED_FROM_COUNT that had been emptied would still pass every assertion above,
    // because "the part equals the sum of its sections" holds trivially when nothing is
    // excluded from either.
    const excluded = countExcludedWords(part);
    const counted = words(measureNode(part));

    expect(excluded).toBeGreaterThan(0);
    // Measured at 18.4% of 1 CFR Chapter I; this part is heading-dense and runs higher. The
    // bound is deliberately loose — the assertion is "this is not a rounding error", not a
    // pinned percentage.
    expect(excluded / (excluded + counted)).toBeGreaterThan(0.1);
  });
});

describe('all of 3 CFR', () => {
  const root = parseXml(TITLE_3);

  it('counts 3,961 words in the title', () => {
    expect(words(measureXml(TITLE_3, { type: 'title', identifier: '3' }))).toBe(3961);
  });

  it('the title equals the sum of its parts, reserved ones included as zero', () => {
    const expected: Record<string, number> = {
      '100': 35,
      '101': 164,
      '102': 3762,
      // A whole reserved part. Genuinely zero, and it must not spoil the roll-up.
      '103-199': 0,
    };

    let sum = 0;
    for (const [identifier, count] of Object.entries(expected)) {
      const measurement = measureXml(TITLE_3, { type: 'part', identifier });
      expect(words(measurement), `part ${identifier}`).toBe(count);
      sum += count;
    }
    expect(sum).toBe(3961);
  });

  it('reports the reserved part as reserved_empty, not as a measured zero', () => {
    // Two different claims that both render as "0". Only one of them is a bug when it is wrong.
    expect(measureXml(TITLE_3, { type: 'part', identifier: '103-199' })).toEqual({
      known: true,
      words: 0,
      status: 'reserved_empty',
      method: 'reserved',
    });
  });

  it('reports reserved section RANGES as reserved too', () => {
    // 3 CFR 102 contains seven of them — "§§ 102.104-102.109 [Reserved]". eCFR writes the
    // range as one section node with a hyphenated identifier, which is why identifiers are
    // never parsed as numbers.
    const reserved = measureXml(TITLE_3, { type: 'section', identifier: '102.104-102.109' });
    expect(reserved.status).toBe('reserved_empty');
    expect(reserved.words).toBe(0);
  });

  it('the AMDDATE header is the only text outside the title element', () => {
    // The document root counts three words more than the DIV1 does: "March 17, 2015", the
    // <AMDDATE> eCFR puts before the title. Recorded here because the difference would
    // otherwise look like a counting bug, and because it means AMDDATE is a candidate for
    // EXCLUDED_FROM_COUNT if the untargeted form of measureXml is ever used on a full title.
    const whole = words(measureXml(TITLE_3));
    const title = words(measureXml(TITLE_3, { type: 'title', identifier: '3' }));

    expect(whole - title).toBe(3);
    expect(headText(findNode(root, { type: 'title', identifier: '3' }) as XmlElement)).toBe(
      'Title 3—The President',
    );
  });
});

describe('the fixtures are real eCFR output, not simplified', () => {
  it('carry the structural features that make a regex impossible', () => {
    const root = parseXml(TITLE_3);
    const chapter = findNode(root, { type: 'chapter', identifier: 'I' }) as XmlElement;

    // Non-sequential levels: chapter I is a DIV3 and its children are DIV5 parts. Nothing at
    // DIV4 in between. A walk that assumed "children of a DIV3 are DIV4" would find nothing.
    expect(chapter.name).toBe('DIV3');
    expect(childStructureNodes(chapter).map((node) => node.name)).toEqual([
      'DIV5',
      'DIV5',
      'DIV5',
      'DIV5',
    ]);
  });

  it('contain the boilerplate tags the exclusion list names', () => {
    // If a future fixture refresh brought back a document with no AUTH or SOURCE, the
    // exclusion assertions above would pass without testing anything.
    const present = new Set<string>();
    const visit = (node: XmlNode): void => {
      if (!isElement(node)) return;
      if (EXCLUDED_FROM_COUNT.has(node.name)) present.add(node.name);
      for (const child of node.children) visit(child);
    };
    visit(parseXml(PART_101));

    expect(present).toContain('HEAD');
    expect(present).toContain('AUTH');
    expect(present).toContain('SOURCE');
  });
});

/**
 * Words inside excluded elements — the apparatus that does NOT get counted.
 *
 * Walks for the excluded tags and counts their whole subtree, which is what
 * `walkCountableText` skips.
 */
function countExcludedWords(element: XmlElement): number {
  let total = 0;
  const visit = (node: XmlNode): void => {
    if (!isElement(node)) return;
    if (EXCLUDED_FROM_COUNT.has(node.name)) {
      total += countWords(allText(node));
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(element);
  return total;
}

function allText(element: XmlElement): string {
  const parts: string[] = [];
  const visit = (node: XmlNode): void => {
    if (isText(node)) {
      parts.push(node.text);
      return;
    }
    if (isElement(node)) for (const child of node.children) visit(child);
  };
  visit(element);
  return parts.join(' ');
}
