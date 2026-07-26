/**
 * Parser tests.
 *
 * The fixture is shaped from the real corpus rather than from the XML a well-behaved publisher
 * would emit. Every awkward feature in it was observed live and is load-bearing:
 *
 *   - DIV1 -> DIV3 -> DIV5 with no DIV2 or DIV4. Title 7 skips levels 35 times.
 *   - a bare `<DIV>` wrapper inside a section. Title 40 has 19,134 of them.
 *   - lowercase `<img/>` and `<br/>`. Title 40 part 60 alone has 1,336 and 774; the
 *     predecessor's tag stripper had no `/i` flag and passed them straight through.
 *   - HTML table markup (TABLE/THEAD/TR/TD), which is what the versioner API actually emits.
 *   - a DIV9 appendix, worth 30% of 40 CFR 60's words.
 */

import { describe, expect, test } from 'vitest';

import {
  childStructureNodes,
  extractText,
  findAllNodes,
  findNode,
  findNodeInXml,
  headText,
  identifierOf,
  isReservedNode,
  nodeTypeOf,
  parseXml,
  toHtml,
} from '../src/index.js';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<ECFR>
<DIV1 N="1" TYPE="TITLE"><HEAD>Title 1—General Provisions</HEAD>
<DIV3 N="I" TYPE="CHAPTER"><HEAD>CHAPTER I—ADMINISTRATIVE COMMITTEE</HEAD>
<AUTH><HED>Authority:</HED><PSPACE>44 U.S.C. 1506; sec. 6, E.O. 10530.</PSPACE></AUTH>
<SOURCE><HED>Source:</HED><PSPACE>37 FR 23604, Nov. 4, 1972, unless otherwise noted.</PSPACE></SOURCE>
<DIV5 N="1" TYPE="PART"><HEAD>PART 1—DEFINITIONS</HEAD>
<P>Part-level prose that belongs to no section.</P>
<DIV8 N="1.1" TYPE="SECTION"><HEAD>§ 1.1 Definitions.</HEAD>
<XREF ID="1" REFID="2">Link to an amendment published at 91 FR 43564, July 16, 2026.</XREF>
<P>As used in this chapter, the term <E T="03">Administrator</E> means the cost-benefit officer.</P>
<P>The following applies&#8212;including subparagraphs (a)(2)(iii) and/or others.</P>
<DIV><P>Nested bare DIV content here.</P></DIV>
<img src="/graphics/ec01.gif"/><br/>
<TABLE class="gpo_table"><CAPTION><P>Table 1</P></CAPTION><THEAD><TR><TH>Column heading alpha</TH></TR></THEAD>
<TBODY><TR><TD>Cell body beta</TD></TR></TBODY></TABLE>
<CITA>[37 FR 23604, Nov. 4, 1972]</CITA>
</DIV8>
<DIV8 N="1.2" TYPE="SECTION"><HEAD>§ 1.2 [Reserved]</HEAD></DIV8>
<DIV9 N="Appendix A to Part 1" TYPE="APPENDIX"><HEAD>Appendix A to Part 1—Forms</HEAD>
<P>Appendix prose with exactly six words here.</P></DIV9>
</DIV5>
<DIV5 N="2" TYPE="PART"><HEAD>PART 2 [RESERVED]</HEAD></DIV5>
</DIV3>
</DIV1>
</ECFR>`;

const root = parseXml(XML);
const chapter = findNode(root, { type: 'chapter', identifier: 'I' });
const part1 = findNode(root, { type: 'part', identifier: '1' });
const section = findNode(root, { type: 'section', identifier: '1.1' });

describe('structure identification', () => {
  test('finds a chapter across a skipped DIV2', () => {
    expect(chapter).not.toBeNull();
    expect(nodeTypeOf(chapter!)).toBe('chapter');
    expect(identifierOf(chapter!)).toBe('I');
  });

  test('finds a part nested under a chapter with no intervening subchapter', () => {
    expect(nodeTypeOf(part1!)).toBe('part');
  });

  test('DIV9 appendices are structure nodes', () => {
    const appendix = findNode(root, { type: 'appendix' });
    expect(appendix).not.toBeNull();
    expect(identifierOf(appendix!)).toBe('APPENDIX A TO PART 1');
  });

  test('a bare DIV is content, never structure', () => {
    // Whatever attributes it carries, only a numbered DIV is a structure node.
    expect(childStructureNodes(section!)).toHaveLength(0);
  });

  test('section lookup tolerates a leading section symbol', () => {
    expect(findNode(root, { type: 'section', identifier: '§ 1.1' })).toBe(section);
  });

  test('identifier matching is case-insensitive', () => {
    expect(findNode(root, { type: 'chapter', identifier: 'i' })).toBe(chapter);
  });

  test('childStructureNodes crosses non-structure wrappers but stops at the next boundary', () => {
    expect(childStructureNodes(chapter!).map(identifierOf)).toEqual(['1', '2']);
    expect(childStructureNodes(part1!).map(identifierOf)).toEqual([
      '1.1',
      '1.2',
      'APPENDIX A TO PART 1',
    ]);
  });

  test('findAllNodes is document-ordered and complete', () => {
    expect(findAllNodes(root, { type: 'section' })).toHaveLength(2);
    expect(findAllNodes(root, { type: 'part' })).toHaveLength(2);
  });

  test('a missing node is null, never a nearby node', () => {
    expect(findNode(root, { type: 'part', identifier: '999' })).toBeNull();
    expect(findNodeInXml(XML, { type: 'part', identifier: '999' })).toBeNull();
  });
});

describe('reserved detection', () => {
  test('detects a reserved section and a reserved part', () => {
    expect(isReservedNode(findNode(root, { type: 'section', identifier: '1.2' })!)).toBe(true);
    expect(isReservedNode(findNode(root, { type: 'part', identifier: '2' })!)).toBe(true);
  });

  test('a part containing a reserved section is not itself reserved', () => {
    expect(isReservedNode(part1!)).toBe(false);
  });

  test('headText reads the node own heading only', () => {
    expect(headText(part1!)).toBe('PART 1—DEFINITIONS');
  });
});

describe('countable text', () => {
  const text = extractText(section!);

  test('excludes the heading', () => {
    expect(text).not.toContain('Definitions.');
  });

  test('excludes the citation line', () => {
    expect(text).not.toContain('23604');
  });

  test('excludes table markup, including cells and captions', () => {
    expect(text).not.toContain('Column heading');
    expect(text).not.toContain('Cell body');
    expect(text).not.toContain('Table 1');
  });

  test("excludes eCFR's injected pending-amendment notice", () => {
    // Volatile apparatus: it appears and disappears as amendments pend, so counting it makes
    // a section's total move for reasons unrelated to the regulation.
    expect(text).not.toContain('Link to an amendment');
  });

  test('excludes authority and source at every level', () => {
    const chapterText = extractText(chapter!);
    expect(chapterText).not.toContain('44 U.S.C. 1506');
    expect(chapterText).not.toContain('unless otherwise noted');
  });

  test('keeps prose, including inside a bare DIV wrapper', () => {
    expect(text).toContain('Nested bare DIV content');
  });

  test('an inline element does not split the word around it', () => {
    expect(text).toMatch(/the term Administrator means/);
  });

  test('stopAtStructureBoundary yields only directly-owned text', () => {
    const own = extractText(part1!, { stopAtStructureBoundary: true });
    expect(own).toContain('Part-level prose');
    expect(own).not.toContain('Administrator');
  });
});

describe('display HTML', () => {
  const rendered = toHtml(section!);

  test('never emits an image or any source URL attribute', () => {
    expect(rendered.html).not.toMatch(/<img/i);
    expect(rendered.html).not.toMatch(/src=/i);
    expect(rendered.html).not.toMatch(/href=/i);
  });

  test('normalises a lowercase source tag rather than leaking it', () => {
    // The predecessor's stripper matched /<[A-Z][^>]*>/ with no /i and let these through.
    expect(rendered.html.match(/<br>/g)).toHaveLength(1);
    expect(rendered.html).not.toContain('<br/>');
  });

  test('emits semantic classes', () => {
    expect(rendered.html).toContain('class="reg-paragraph"');
    expect(rendered.html).toContain('<section class="reg-section"');
    expect(rendered.html).toContain('reg-emphasis-italic');
  });

  test('the rendered node own heading sits at the requested level', () => {
    expect(rendered.html).toMatch(/<h2 class="reg-heading">/);
    expect(toHtml(section!, { headingLevel: 3 }).html).toMatch(/<h3 class="reg-heading">/);
  });

  test('renders table rows and cells, not bare text inside a table', () => {
    const html = toHtml(section!).html;
    expect(html).toContain('<table class="reg-table">');
    expect(html).toContain('<tr class="reg-table-row">');
    expect(html).toContain('<td class="reg-table-cell">');
    // A <table> whose cells were dropped would hoist the text out of the table in a browser.
    expect(html).not.toMatch(/<table[^>]*>\s*Column/);
  });

  test('escapes hostile text and attribute values', () => {
    const hostile = parseXml(
      '<DIV8 N="1.3" TYPE="SECTION"><P>&lt;script&gt;alert(1)&lt;/script&gt; &amp; "quoted"</P>' +
        '<PRTPAGE P="&quot;&gt;&lt;script&gt;"/></DIV8>',
    );
    const html = toHtml(findNode(hostile, { type: 'section' })!).html;
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&amp;');
    expect(html).toContain('data-page="&quot;&gt;&lt;script&gt;"');
  });

  test('an unknown element is transparent: text survives, markup and attributes do not', () => {
    const unknown = parseXml(
      '<DIV8 N="1.4" TYPE="SECTION"><WEIRDTAG onclick="x"><P>kept</P></WEIRDTAG></DIV8>',
    );
    const html = toHtml(findNode(unknown, { type: 'section' })!).html;
    expect(html).toContain('kept');
    expect(html).not.toContain('WEIRDTAG');
    expect(html).not.toMatch(/onclick/i);
  });

  test('extracts heading, authority, source and FR citations', () => {
    expect(rendered.meta.heading).toBe('§ 1.1 Definitions.');
    const chapterMeta = toHtml(chapter!).meta;
    expect(chapterMeta.authority).toEqual(['44 U.S.C. 1506; sec. 6, E.O. 10530.']);
    expect(chapterMeta.source).toEqual(['37 FR 23604, Nov. 4, 1972, unless otherwise noted.']);
    expect(chapterMeta.frCitations).toEqual(['37 FR 23604']);
  });

  test('renders the authority label as a label, not as a heading', () => {
    expect(toHtml(chapter!).html).toContain('<span class="reg-label">Authority:</span>');
  });
});
