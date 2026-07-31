/**
 * 40 CFR 60 is the one part in the corpus with case-colliding sibling identifiers: subparts
 * `Cc` and `CC`, `AAa` and `AAA` — different regulation under names that differ only by
 * case. The folded-only match resolved both names to the first sibling in document order,
 * which is how subpart CC's sections vanished from the rendered corpus while subpart Cc's
 * text appeared twice. Verified against the live XML: the `N` attributes preserve case.
 */

import { describe, expect, it } from 'vitest';

import { extractText, findNode, parseXml } from '../src/index.js';

const XML = `<DIV5 TYPE="PART" N="60">
  <HEAD>PART 60</HEAD>
  <DIV6 TYPE="SUBPART" N="Cc">
    <HEAD>Subpart Cc—Guidelines</HEAD>
    <DIV8 TYPE="SECTION" N="60.30c"><HEAD>§ 60.30c</HEAD><P>guideline text</P></DIV8>
  </DIV6>
  <DIV6 TYPE="SUBPART" N="CC">
    <HEAD>Subpart CC—Glass Manufacturing Plants</HEAD>
    <DIV8 TYPE="SECTION" N="60.290"><HEAD>§ 60.290</HEAD><P>glass text</P></DIV8>
  </DIV6>
</DIV5>`;

describe('findNode case handling', () => {
  it('distinguishes sibling identifiers that differ only by case', () => {
    const doc = parseXml(XML);
    const lower = findNode(doc, { type: 'subpart', identifier: 'Cc' });
    const upper = findNode(doc, { type: 'subpart', identifier: 'CC' });

    expect(lower).not.toBeNull();
    expect(upper).not.toBeNull();
    expect(extractText(lower ?? doc)).toContain('guideline text');
    // The regression: the folded-only match returned Cc (first in document order) for both.
    expect(extractText(upper ?? doc)).toContain('glass text');
    expect(extractText(upper ?? doc)).not.toContain('guideline text');
  });

  it('still folds case when the document does not honour it', () => {
    // Roman-numeral chapters vary in source casing; with no exact-case node present the
    // folded fallback must keep matching, exactly as before the exact pass existed.
    const doc = parseXml('<DIV3 TYPE="CHAPTER" N="II"><HEAD>Chapter II</HEAD><P>x</P></DIV3>');
    expect(findNode(doc, { type: 'chapter', identifier: 'ii' })).not.toBeNull();
  });
});
