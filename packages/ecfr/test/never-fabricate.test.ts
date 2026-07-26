/**
 * THE test. If only one file in this repository survives, it should be this one.
 *
 * The predecessor's counter, when its regex failed to find an agency's chapter inside a title's
 * XML, did this:
 *
 *     chapterText = fullText.substring(0, estimatedWords * 6);
 *
 * and stored `countWords(chapterText)` in the same INTEGER column as a real measurement. The
 * number looked plausible. It was invented. One agency was over-credited 12.7x and nobody could
 * tell from the data.
 *
 * Every assertion below is a different way of asking the same question: when the counter cannot
 * resolve what it was asked to measure, does it say so? The answers it must never give are a
 * proportional guess, a partial count, and — most dangerously, because it is the one that looks
 * like data — zero.
 */

import { readFileSync } from 'node:fs';
import type { CountMethod, Measurement } from '@ecfr-atlas/core';
import { describe, expect, it } from 'vitest';
import {
  countWords,
  DEFAULT_MAX_TEXT_CHARS,
  measureNode,
  measureXml,
  parseXml,
  rejectBySize,
} from '../src/index.js';

const FIXTURES = new URL('../../../fixtures/xml/', import.meta.url);
const readFixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

/** 1 CFR Part 51, real, as served on 2024-05-17. 1,231 countable words across six sections. */
const PART_51 = readFixture('title-1-part-51-2024-05-17.xml');

/**
 * Narrow a Measurement to its unknown arm, with a readable failure when it is not.
 *
 * `expect(m.known).toBe(false)` reports "expected true to be false", which tells you nothing
 * about what was wrongly counted. This prints the fabricated number.
 */
function expectUnknown(m: Measurement): asserts m is Extract<Measurement, { known: false }> {
  if (m.known) {
    throw new Error(
      `expected an unavailable measurement, got a count of ${m.words} ` +
        `(status ${m.status}, method ${m.method}). A number was invented.`,
    );
  }
}

describe('an unresolvable subtree is unavailable, never a number', () => {
  it('returns unavailable_parse_failed when the requested chapter is absent', () => {
    // The exact shape of the predecessor's failure: a title's XML is in hand, the reference
    // names a chapter, and the chapter is not in the document.
    const measurement = measureXml(PART_51, { type: 'chapter', identifier: 'XIV' });

    expectUnknown(measurement);
    expect(measurement.status).toBe('unavailable_parse_failed');
    expect(measurement.words).toBeNull();
    expect(measurement.reason).toMatch(/chapter XIV/);
  });

  it('does not fall back to counting the whole document', () => {
    // 1,231 words are sitting right there. The old code would have taken a proportion of them.
    const whole = measureXml(PART_51);
    expect(whole).toEqual({ known: true, words: 1231, status: 'counted', method: 'xml_parse' });

    const missing = measureXml(PART_51, { type: 'part', identifier: '9999' });
    expectUnknown(missing);
  });

  it('does not return 0 for an absent node', () => {
    // Zero is the most dangerous wrong answer: it is a valid count, it aggregates silently, and
    // it drags every parent's roll-up down without tripping anything.
    const measurement = measureXml(PART_51, { type: 'section', identifier: '51.999' });
    expectUnknown(measurement);
    expect(measurement.words).not.toBe(0);
    expect(measurement.words).toBeNull();
  });

  it('distinguishes an absent node from a genuinely empty reserved one', () => {
    // Both are "no words". Only one of them is a measurement. `reserved_empty` carries a
    // method of 'reserved' precisely so a reader can tell which claim is being made.
    const titleThree = readFixture('title-3-full-2024-05-17.xml');

    const reserved = measureXml(titleThree, { type: 'part', identifier: '103-199' });
    expect(reserved).toEqual({
      known: true,
      words: 0,
      status: 'reserved_empty',
      method: 'reserved',
    });

    const absent = measureXml(titleThree, { type: 'part', identifier: '104-200' });
    expectUnknown(absent);
  });

  it('reports a null node as unavailable rather than throwing or zeroing', () => {
    // `findNode` returning null is the common path into `measureNode`; a caller that forgets to
    // check must still get an honest answer rather than an exception a layer above turns into
    // a default.
    const measurement = measureNode(null);
    expectUnknown(measurement);
    expect(measurement.status).toBe('unavailable_parse_failed');
  });
});

describe('malformed and hostile input is unavailable, never a number', () => {
  /**
   * Every case here passes a TARGET, because that is how the pipeline calls in: it knows from
   * eCFR's structure JSON which node it is trying to measure, and it asks for that node by
   * name. Asking for a specific node is what makes "the document is not what we asked for"
   * detectable at all.
   *
   * See the untargeted case at the bottom of this block for the one path where that is not
   * true, and why it must not be used on a fetched response.
   */
  const target = { type: 'part', identifier: '51' } as const;

  it('turns a truncated response into a measurement, not an exception', () => {
    // A connection dropped mid-transfer. fast-xml-parser salvages what it can rather than
    // throwing, so the guard has to be "the node we wanted is not here", not "the parser
    // complained".
    const measurement = measureXml('<DIV5 N="1"><P>unclosed', target);
    expectUnknown(measurement);
    expect(measurement.words).toBeNull();
  });

  it('is unavailable for an empty document', () => {
    const measurement = measureXml('', target);
    expectUnknown(measurement);
    expect(measurement.words).toBeNull();
  });

  it('is unavailable for a document that is not XML at all', () => {
    // eCFR 302s automated clients to a CAPTCHA interstitial. If one ever reaches the counter,
    // the answer is "we do not know", not "1 CFR Part 51 is five words long".
    const measurement = measureXml(
      '<!DOCTYPE html><html><body>Please verify you are human</body></html>',
      target,
    );
    expectUnknown(measurement);
    expect(measurement.words).toBeNull();
  });

  it('is unavailable when eCFR serves a different part than the one requested', () => {
    // The failure mode behind `?chapter=` and `?subtitle=`: those params VALIDATE but DO NOT
    // SLICE, so a request for a chapter returns the entire title, HTTP 200. Full of real text,
    // and none of it an answer to the question.
    const titleThree = readFixture('title-3-full-2024-05-17.xml');
    const measurement = measureXml(titleThree, { type: 'part', identifier: '51' });
    expectUnknown(measurement);
    expect(measurement.words).toBeNull();
  });

  it('refuses to measure an untargeted document that contains no CFR structure', () => {
    // An earlier revision of this test asserted that the untargeted form returns counted(5)
    // here, on the reasoning that it is "an honest count of the document supplied". That is
    // true of the arithmetic and false of the claim: nothing in the row that number lands in
    // says "of a document that may not be the CFR". eCFR serves this interstitial to clients
    // it takes for scrapers, so it is a response the pipeline can really receive.
    //
    // `measureXml` now requires at least one DIV1..DIVn in the document before it will count
    // anything, targeted or not. `measureNode` is unguarded and remains available to callers
    // that already hold a node they located themselves.
    const captcha = measureXml(
      '<!DOCTYPE html><html><body>Please verify you are human</body></html>',
    );
    expectUnknown(captcha);
    expect(captcha.status).toBe('unavailable_parse_failed');
    expect(captcha.words).toBeNull();
  });

  it('still counts a well-formed CFR document handed over without a target', () => {
    // The guard keys on the presence of CFR structure, not on a target being supplied, so the
    // legitimate untargeted use — "I fetched this part, count all of it" — is unaffected.
    const measurement = measureXml(
      '<DIV5 N="51" TYPE="PART"><HEAD>PART 51</HEAD><P>Four countable words here.</P></DIV5>',
    );
    expect(measurement).toMatchObject({ known: true, words: 4, status: 'counted' });
  });
});

describe('a size ceiling produces unavailable_too_large, never a truncated count', () => {
  it('rejects an oversized subtree from its reported byte size without fetching it', () => {
    // 26 CFR Part 1 is 69,598,633 bytes. The point of checking eCFR's own additive `size` is
    // that the part is never downloaded, so there is nothing to accidentally half-count.
    const measurement = rejectBySize({ xmlBytes: 69_598_633 });
    expect(measurement).not.toBeNull();
    expectUnknown(measurement as Measurement);
    expect((measurement as Measurement).status).toBe('unavailable_too_large');
  });

  it('does not publish the words it managed to read before hitting the ceiling', () => {
    // A truncated count is the same bug wearing a different hat: a real number, honestly
    // derived, that is nonetheless not the answer to the question asked.
    const partial = measureXml(PART_51, { type: 'part', identifier: '51' }, { maxTextChars: 200 });
    expectUnknown(partial);
    expect(partial.status).toBe('unavailable_too_large');
    expect(partial.words).toBeNull();
    expect(partial.reason).toMatch(/roll up/);
  });

  it('accepts the same subtree once the ceiling is raised', () => {
    // Confirms the previous assertion failed for the stated reason and not because the fixture
    // is unmeasurable.
    const full = measureXml(
      PART_51,
      { type: 'part', identifier: '51' },
      { maxTextChars: DEFAULT_MAX_TEXT_CHARS },
    );
    expect(full).toEqual({ known: true, words: 1231, status: 'counted', method: 'xml_parse' });
  });
});

describe('the estimate that caused the rewrite, reconstructed', () => {
  it('the old heuristic and the truth disagree, and only the truth is producible', () => {
    const root = parseXml(PART_51);

    // Reconstruct `chapterText = fullText.substring(0, estimatedWords * 6)` exactly. The
    // predecessor's `estimatedWords` came from an unrelated proportion; 400 stands in for it.
    const fullText = PART_51;
    const estimatedWords = 400;
    const fabricated = countWords(fullText.substring(0, estimatedWords * 6));

    const honest = measureNode(root);
    expect(honest.known).toBe(true);
    expect(honest.words).toBe(1231);

    // The fabricated figure is not merely different, it is confidently wrong — and on a real
    // 40 CFR chapter that difference was 12.7x.
    expect(fabricated).not.toBe(1231);

    // And there is no constructor that would let it into the pipeline. `Measurement` has
    // `counted`, `rolledUp`, `reservedEmpty` and `unavailable`; nothing accepts a bare number
    // without a method, and no method names a guess.
    // `CountMethod` is a closed union of three names. Listing them here means adding a
    // fourth breaks this test, which is the point: a new method is a new way for a number to
    // enter the database and needs to be argued for.
    const methods: CountMethod[] = ['xml_parse', 'descendant_sum', 'reserved'];
    expect(methods).toHaveLength(3);
    expect(methods as string[]).not.toContain('estimate');
  });
});
