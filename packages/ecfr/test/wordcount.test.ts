/**
 * Word counter tests.
 *
 * The tokenisation cases are the published rule in `WORD_DEFINITION` turned into assertions,
 * one per clause, because that string is quoted on /methodology and a silent drift between the
 * prose and the code would make every published total unverifiable.
 *
 * The measurement cases assert the property the whole project rests on: there is no input for
 * which this module returns a number it did not measure.
 */

import { rollUp } from '@ecfr-atlas/core';
import { describe, expect, test } from 'vitest';
import {
  countWords,
  createWordCounter,
  DEFAULT_MAX_TEXT_CHARS,
  findAllNodes,
  findNode,
  measureNode,
  measureOwnText,
  measureXml,
  parseXml,
  WORD_DEFINITION,
} from '../src/index.js';

describe('the published tokenisation rule', () => {
  test('a single hyphen joins a compound word', () => {
    expect(countWords('cost-benefit')).toBe(1);
    expect(countWords('re- entry')).toBe(2);
  });

  test('em dash, en dash and a run of two or more hyphens separate', () => {
    expect(countWords('words—including')).toBe(2);
    expect(countWords('1990–1991')).toBe(2);
    expect(countWords('words--including')).toBe(2);
  });

  test('bare punctuation is not a word', () => {
    expect(countWords('* — • ¶')).toBe(0);
    expect(countWords('§ 60.1')).toBe(1);
  });

  test('periods, slashes and parentheses do not split a token', () => {
    expect(countWords('and/or')).toBe(1);
    expect(countWords('(a)(2)(iii)')).toBe(1);
    expect(countWords('60.1')).toBe(1);
  });

  test('invisible characters are removed rather than treated as boundaries', () => {
    expect(countWords('co­operate')).toBe(1);
    expect(countWords('a​b')).toBe(1);
  });

  test('every Unicode space separates', () => {
    expect(countWords('one two')).toBe(2);
    expect(countWords('one two')).toBe(2);
  });

  test('empty and whitespace-only input counts zero', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t  ')).toBe(0);
  });

  test('a plain sentence counts as read', () => {
    expect(countWords('The Administrator shall issue a permit.')).toBe(6);
  });

  test('the published definition names every rule the code implements', () => {
    for (const clause of ['zero-width', 'em dash', 'hyphen-minus', 'letter', 'digit', '18.4%']) {
      expect(WORD_DEFINITION).toContain(clause);
    }
  });
});

describe('the streaming counter', () => {
  const sample = 'cost-benefit analysis--including the (a)(2) rule and/or § 60.1 thereof';

  test('chunking cannot change the count, including mid-hyphen-run', () => {
    // The walker feeds arbitrary chunk boundaries, so a run of hyphens split across two chunks
    // must resolve identically to the same run seen whole.
    for (const size of [1, 2, 3, 5, 7, 13, 64]) {
      const counter = createWordCounter();
      for (let i = 0; i < sample.length; i += size) counter.feed(sample.slice(i, i + size));
      expect(counter.words).toBe(countWords(sample));
    }
  });

  test('breakToken forces a boundary without inserting a character', () => {
    const counter = createWordCounter();
    counter.feed('alpha');
    counter.breakToken();
    counter.feed('beta');
    expect(counter.words).toBe(2);
  });

  test('tracks characters fed, which is what the size ceiling watches', () => {
    const counter = createWordCounter();
    counter.feed('abc');
    counter.feed('de');
    expect(counter.chars).toBe(5);
  });
});

describe('measurement never guesses', () => {
  const XML = `<DIV5 N="1" TYPE="PART"><HEAD>PART 1</HEAD>
<P>Part-level prose owned directly here.</P>
<DIV8 N="1.1" TYPE="SECTION"><HEAD>§ 1.1 One.</HEAD><P>Alpha beta gamma.</P></DIV8>
<DIV8 N="1.2" TYPE="SECTION"><HEAD>§ 1.2 [Reserved]</HEAD></DIV8>
</DIV5>`;
  const root = parseXml(XML);
  const part = findNode(root, { type: 'part', identifier: '1' })!;

  test('a reserved node is reserved_empty, not a measured zero', () => {
    expect(measureXml(XML, { type: 'section', identifier: '1.2' })).toEqual({
      known: true,
      words: 0,
      status: 'reserved_empty',
      method: 'reserved',
    });
  });

  test('an absent node is unknown with a reason and no number', () => {
    const m = measureXml(XML, { type: 'part', identifier: '404' });
    expect(m.known).toBe(false);
    expect(m.status).toBe('unavailable_parse_failed');
    expect(m.words).toBeNull();
    expect(m).toHaveProperty('reason');
  });

  test('unparseable XML is unknown, never a number', () => {
    const m = measureXml('<DIV1 N="1"><P>unclosed', { type: 'part' });
    expect(m.known).toBe(false);
    expect(m.words).toBeNull();
  });

  test('a node over the text ceiling is unavailable_too_large, not a truncated count', () => {
    const m = measureXml(XML, { type: 'part', identifier: '1' }, { maxTextChars: 10 });
    expect(m.status).toBe('unavailable_too_large');
    expect(m.words).toBeNull();
  });

  test('an oversized subtree is rejected from its reported size before any parsing', () => {
    // 26 CFR Part 1 is 69,598,633 bytes. The sync must skip it on the structure JSON alone.
    const m = measureXml(XML, { type: 'part', identifier: '1' }, { xmlBytes: 69_598_633 });
    expect(m.status).toBe('unavailable_too_large');
  });

  test('a document with no CFR structure is refused, even without a target', () => {
    // eCFR serves an HTML interstitial to clients it takes for scrapers. It parses fine as
    // XML, so without a structure check the untargeted form would count its prose and report
    // a confident number about something that is not the CFR.
    for (const notRegulation of [
      '<!DOCTYPE html><html><body>Please verify you are human</body></html>',
      '<DIV5 N="1"><P>unclosed',
      '',
    ]) {
      const m = measureXml(notRegulation);
      expect(m.known).toBe(false);
      expect(m.words).toBeNull();
    }
  });

  test('a well-formed document without a target is still counted', () => {
    expect(measureXml(XML)).toMatchObject({ known: true, status: 'counted' });
  });

  test('a node under the ceiling is counted by xml_parse', () => {
    const m = measureNode(part);
    expect(m).toMatchObject({ known: true, status: 'counted', method: 'xml_parse' });
  });

  test('the default ceiling admits the largest real section', () => {
    // 50 CFR 17.95 is 5,010,215 bytes, the largest section in the corpus.
    expect(DEFAULT_MAX_TEXT_CHARS).toBeGreaterThan(5_010_215);
  });
});

describe('composition', () => {
  const XML = `<DIV5 N="1" TYPE="PART"><HEAD>PART 1</HEAD>
<P>Part-level prose owned directly here.</P>
<DIV8 N="1.1" TYPE="SECTION"><HEAD>§ 1.1 One.</HEAD><P>Alpha beta gamma.</P></DIV8>
<DIV8 N="1.2" TYPE="SECTION"><HEAD>§ 1.2 Two.</HEAD><P>Delta epsilon.</P></DIV8>
</DIV5>`;
  const root = parseXml(XML);
  const part = findNode(root, { type: 'part', identifier: '1' })!;
  const sections = findAllNodes(root, { type: 'section' });

  test('a parent equals its own text plus its children, never just its children', () => {
    const whole = measureNode(part).words;
    const own = measureOwnText(part).words;
    const children = rollUp(sections.map((s) => measureNode(s))).words;
    // "Part-level" is one word: a single hyphen joins.
    expect(own).toBe(5);
    expect(children).toBe(5);
    // Rolling up children alone would report 5 and lose the part-level prose entirely.
    expect(children).not.toBe(whole);
    expect((own ?? 0) + (children ?? 0)).toBe(whole);
  });

  test('a roll-up with one unknown child stays unknown', () => {
    const partial = rollUp([measureNode(sections[0]), measureNode(null)]);
    expect(partial.known).toBe(false);
    expect(partial.words).toBeNull();
  });

  test('adjacent blocks with no source whitespace do not merge into one word', () => {
    const noWs = parseXml('<DIV8 N="9.9" TYPE="SECTION"><P>alpha</P><P>beta</P></DIV8>');
    expect(measureNode(findNode(noWs, { type: 'section' })).words).toBe(2);
  });
});
