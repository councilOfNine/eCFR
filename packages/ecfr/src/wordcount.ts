/**
 * The counting rules. Single source of truth for every number this project publishes.
 *
 * `WORD_DEFINITION` below is written to be quoted verbatim on /methodology. If the rule
 * changes, that string changes with it in the same commit, because a published total whose
 * definition has drifted is worse than no total at all.
 *
 * Everything here returns a `Measurement` from `@ecfr-atlas/core`. There is no code path that
 * produces a bare number, and no code path that guesses. When a subtree cannot be resolved or
 * is too large to process, the answer is `unavailable(...)` with a reason — never a
 * proportional estimate. That estimate is the bug this rewrite exists to make impossible.
 */

import type { Measurement } from '@ecfr-atlas/core';
import {
  CountMethod,
  counted,
  REASON_NOT_REGULATION_XML,
  REASON_SUBTREE_NOT_IN_XML,
  reasonDocumentOverParseCeiling,
  reasonNodeNotFoundInXml,
  reasonOwnTextOverCeiling,
  reasonSubtreeOverXmlCeiling,
  reasonTextOverCeiling,
  reservedEmpty,
  unavailable,
  WordCountStatus,
} from '@ecfr-atlas/core';

import { EcfrTooLargeError } from './errors.js';
import type { NodeTarget, ParseOptions, TextSink, XmlElement } from './parser.js';
import {
  findNode,
  hasStructureElement,
  isReservedNode,
  parseXml,
  walkCountableText,
} from './parser.js';

/**
 * The published definition of a word. Quoted on /methodology.
 *
 * Every clause is a decision that changes the total, so each one is stated rather than left to
 * the implementation:
 *
 *   - Discarding tokens with no letter or digit is what stops "§", "—", "*" and bullet glyphs
 *     from being counted as words. "§ 60.1" is therefore one word, not two.
 *   - A single hyphen joins, because "cost-benefit" is one word in every reading of the text.
 *     Two or more hyphens, and the em/en dashes, separate, because they join independent words
 *     in prose and treating "words—including" as one token would under-count.
 *   - Periods, apostrophes, slashes and parentheses never split a token, so "and/or",
 *     "(a)(2)(iii)" and "40.1" are one word each. Paragraph designators are part of the
 *     regulation and are counted.
 *   - Soft hyphens and zero-width characters are removed rather than treated as boundaries,
 *     since they are invisible in the rendered text.
 */
export const WORD_DEFINITION = `A word is a maximal run of non-space characters, after the following normalisation, \
excluding runs that contain neither a letter nor a digit.
 1. Remove zero-width and invisible formatting characters (U+00AD, U+200B-U+200D, U+2060, U+FEFF).
 2. Treat every Unicode whitespace character as a separator.
 3. Treat en dash, em dash, horizontal bar, and runs of two or more hyphen-minus as separators.
 4. Split on separators.
 5. Discard tokens containing no letter and no digit (bare punctuation such as the section
    symbol, dashes, asterisks and bullets).
Hyphens, apostrophes, periods, slashes and parentheses inside a token do not split it, so
"cost-benefit", "and/or", "(a)(2)(iii)" and "60.1" each count as one word. Headings, authority
lines, source lines, editorial citations, running heads, footnote apparatus and table markup \
are excluded before counting; they were measured at 18.4% of 1 CFR Chapter I.`;

// ─── character classification ─────────────────────────────────────────────────

const HYPHEN_MINUS = 0x2d;
const DEL = 0x7f;

/**
 * Invisible characters. Removed entirely rather than treated as separators, so a word broken
 * across a line with a soft hyphen counts once, not twice.
 */
function isIgnorable(codePoint: number): boolean {
  return (
    codePoint === 0x00ad ||
    (codePoint >= 0x200b && codePoint <= 0x200d) ||
    codePoint === 0x2060 ||
    codePoint === 0xfeff
  );
}

function isUnicodeSpace(codePoint: number): boolean {
  return (
    codePoint === 0x0085 ||
    codePoint === 0x00a0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

/**
 * Dashes that separate words.
 *
 * U+2010 HYPHEN and U+2011 NON-BREAKING HYPHEN are deliberately absent: they are hyphens and
 * they join. U+2012 FIGURE DASH is absent for the same reason — it appears inside numeric
 * ranges.
 */
function isDashSeparator(codePoint: number): boolean {
  return (
    codePoint === 0x2013 ||
    codePoint === 0x2014 ||
    codePoint === 0x2015 ||
    codePoint === 0x2e3a ||
    codePoint === 0x2e3b
  );
}

const ALNUM_RE = /[\p{L}\p{N}]/u;
const alnumCache = new Map<number, boolean>();

function isUnicodeAlnum(codePoint: number): boolean {
  const cached = alnumCache.get(codePoint);
  if (cached !== undefined) return cached;
  const result = ALNUM_RE.test(String.fromCodePoint(codePoint));
  // Bounded so a pathological input cannot grow the cache without limit. CFR prose uses a few
  // dozen distinct non-ASCII characters, so this never fills in practice.
  if (alnumCache.size < 4096) alnumCache.set(codePoint, result);
  return result;
}

// ─── the counter ──────────────────────────────────────────────────────────────

export interface WordCounter {
  /** Feed a chunk. Chunks may split anywhere, including mid-word and mid-hyphen-run. */
  feed(chunk: string): void;
  /** Force a word boundary without inserting a character. */
  breakToken(): void;
  /** Words seen so far, including any token still open. */
  readonly words: number;
  /** Characters fed. Used to enforce the size ceiling without a second pass. */
  readonly chars: number;
}

/**
 * A single-pass, allocation-free scanner.
 *
 * Splitting with a regex and counting the array would allocate one string per word: 105,096,026
 * of them across the corpus, over 665 MB of input. Scanning by code point keeps a full backfill
 * inside a sane heap and is what makes counting-while-walking possible at all.
 */
class Counter implements WordCounter {
  #words = 0;
  #chars = 0;
  #inToken = false;
  #tokenHasAlnum = false;
  /** Hyphens at the very end of a chunk, whose run length is not yet decided. */
  #pendingHyphens = 0;

  get words(): number {
    // An open token contributes exactly when it has seen a letter or digit. Pending hyphens
    // cannot change that: a run of one is a non-alnum token character, a run of two or more
    // closes the token, and both leave this expression's value unchanged.
    return this.#words + (this.#inToken && this.#tokenHasAlnum ? 1 : 0);
  }

  get chars(): number {
    return this.#chars;
  }

  breakToken(): void {
    this.#flushHyphens();
    this.#closeToken();
  }

  feed(chunk: string): void {
    const length = chunk.length;
    if (length === 0) return;
    this.#chars += length;

    let i = 0;
    while (i < length) {
      const code = chunk.charCodeAt(i);

      if (code === HYPHEN_MINUS) {
        let run = this.#pendingHyphens;
        this.#pendingHyphens = 0;
        let j = i;
        while (j < length && chunk.charCodeAt(j) === HYPHEN_MINUS) {
          run += 1;
          j += 1;
        }
        if (j === length) {
          // The run may continue in the next chunk; deciding now could split a word.
          this.#pendingHyphens = run;
          return;
        }
        this.#applyHyphenRun(run);
        i = j;
        continue;
      }

      this.#flushHyphens();

      if (code < 0x80) {
        if (code <= 0x20 || code === DEL) {
          this.#closeToken();
          i += 1;
          continue;
        }
        this.#inToken = true;
        if (
          (code >= 0x30 && code <= 0x39) ||
          (code >= 0x41 && code <= 0x5a) ||
          (code >= 0x61 && code <= 0x7a)
        ) {
          this.#tokenHasAlnum = true;
        }
        i += 1;
        continue;
      }

      const codePoint = chunk.codePointAt(i) ?? code;
      i += codePoint > 0xffff ? 2 : 1;
      if (isIgnorable(codePoint)) continue;
      if (isUnicodeSpace(codePoint) || isDashSeparator(codePoint)) {
        this.#closeToken();
        continue;
      }
      this.#inToken = true;
      if (isUnicodeAlnum(codePoint)) this.#tokenHasAlnum = true;
    }
  }

  #flushHyphens(): void {
    if (this.#pendingHyphens === 0) return;
    const run = this.#pendingHyphens;
    this.#pendingHyphens = 0;
    this.#applyHyphenRun(run);
  }

  #applyHyphenRun(run: number): void {
    if (run >= 2) {
      this.#closeToken();
    } else if (run === 1) {
      // A joining hyphen: part of the token, but not itself a letter or digit.
      this.#inToken = true;
    }
  }

  #closeToken(): void {
    if (!this.#inToken) return;
    if (this.#tokenHasAlnum) this.#words += 1;
    this.#inToken = false;
    this.#tokenHasAlnum = false;
  }
}

export function createWordCounter(): WordCounter {
  return new Counter();
}

/** The definition in `WORD_DEFINITION`, applied to one string. */
export function countWords(text: string): number {
  const counter = new Counter();
  counter.feed(text);
  return counter.words;
}

/** Adapter so `walkCountableText` can drive a counter directly. */
export function countingSink(counter: WordCounter): TextSink {
  return {
    text: (chunk: string) => {
      counter.feed(chunk);
    },
    blockBreak: () => {
      counter.breakToken();
    },
  };
}

// ─── size ceilings ────────────────────────────────────────────────────────────

/**
 * Default ceiling on the countable text of one node, in characters.
 *
 * Chosen against the measured extremes. The largest single section is 50 CFR 17.95 at
 * 5,010,215 bytes, so every section must fit. 26 CFR Part 1 is 69,598,633 bytes and must NOT
 * be attempted whole — it is also over Cloudflare's 25 MiB per-file static asset cap and has
 * to be split by subpart regardless. 16M characters sits between the two: it admits every
 * section and all but a handful of parts, and the parts it rejects are exactly the ones that
 * have to be measured by rolling up their subparts.
 */
export const DEFAULT_MAX_TEXT_CHARS = 16_000_000;

/**
 * Ceiling for the Worker runtime.
 *
 * A Worker isolate gets 128 MB total, shared with the runtime, the bundle, and every other
 * request in flight. A JS string is up to two bytes per character, so 2M characters is already
 * a meaningful fraction of that budget.
 */
export const WORKER_MAX_TEXT_CHARS = 2_000_000;

/**
 * Default ceiling on a node's XML subtree, in bytes, when the caller knows it up front.
 *
 * eCFR's structure JSON carries an additive `size` on every node, so this can be checked
 * before a single byte of XML is fetched.
 */
export const DEFAULT_MAX_XML_BYTES = 32 * 1024 * 1024;

export interface MeasureOptions {
  maxTextChars?: number;
  /** The subtree's XML byte size from eCFR's structure JSON, when known. */
  xmlBytes?: number;
  maxXmlBytes?: number;
}

/**
 * Pre-flight the size ceiling using eCFR's own reported subtree size.
 *
 * Returns the `Measurement` to record, or null when the node is worth fetching. Lets the sync
 * skip a 69 MB part without spending a request on it.
 */
export function rejectBySize(options: MeasureOptions = {}): Measurement | null {
  const { xmlBytes } = options;
  if (xmlBytes === undefined) return null;
  const limit = options.maxXmlBytes ?? DEFAULT_MAX_XML_BYTES;
  if (xmlBytes <= limit) return null;
  return unavailable(
    WordCountStatus.UnavailableTooLarge,
    reasonSubtreeOverXmlCeiling(xmlBytes, limit),
  );
}

// ─── measurement ──────────────────────────────────────────────────────────────

/**
 * Measure one parsed subtree.
 *
 * The four outcomes are exhaustive and none of them is a guess:
 *   - the node is absent           -> unavailable_parse_failed
 *   - the node is over the ceiling -> unavailable_too_large
 *   - the node is reserved         -> reserved_empty (zero by definition, nothing parsed)
 *   - otherwise                    -> counted, from this node's own XML
 */
export function measureNode(
  node: XmlElement | null | undefined,
  options: MeasureOptions = {},
): Measurement {
  if (node === null || node === undefined) {
    return unavailable(WordCountStatus.UnavailableParseFailed, REASON_SUBTREE_NOT_IN_XML);
  }

  const tooLargeUpFront = rejectBySize(options);
  if (tooLargeUpFront !== null) return tooLargeUpFront;

  if (isReservedNode(node)) return reservedEmpty();

  const maxChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const counter = createWordCounter();
  const walk = walkCountableText(node, countingSink(counter), { maxChars });
  if (walk.truncated) {
    return unavailable(WordCountStatus.UnavailableTooLarge, reasonTextOverCeiling(maxChars));
  }

  return counted(counter.words, CountMethod.XmlParse);
}

/**
 * Measure only the text a node owns directly, excluding every nested structure node.
 *
 * A parent is NOT the sum of its structure children. Measured across seven parts: 29 CFR 1910
 * carries 146 words directly under the part, 21 CFR 201 carries 15, and 26 CFR 20 carries 5,
 * while 40 CFR 60, 7 CFR 210, 12 CFR 1026 and 50 CFR 17 carry none. A pipeline that composes a
 * parent as `rollUp(children)` therefore loses those words silently — an under-report, which
 * is the failure mode that looks most like a plausible number.
 *
 * The exact composition is:
 *
 *     measureNode(parent) === measureOwnText(parent) + sum(measureNode(child) for children)
 *
 * so a parent can be recomposed without re-parsing, and the identity can be asserted in CI.
 */
export function measureOwnText(
  node: XmlElement | null | undefined,
  options: MeasureOptions = {},
): Measurement {
  if (node === null || node === undefined) {
    return unavailable(WordCountStatus.UnavailableParseFailed, REASON_SUBTREE_NOT_IN_XML);
  }
  if (isReservedNode(node)) return reservedEmpty();

  const maxChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const counter = createWordCounter();
  const walk = walkCountableText(node, countingSink(counter), {
    maxChars,
    stopAtStructureBoundary: true,
  });
  if (walk.truncated) {
    return unavailable(WordCountStatus.UnavailableTooLarge, reasonOwnTextOverCeiling(maxChars));
  }
  return counted(counter.words, CountMethod.XmlParse);
}

export interface MeasureXmlOptions extends MeasureOptions, ParseOptions {}

/**
 * Parse XML and measure a subtree of it, converting every failure into a `Measurement`.
 *
 * This is the entry point the sync pipeline uses, because it guarantees that a malformed or
 * oversized document produces an honest "unknown" row rather than an exception that some
 * caller upstream turns into a zero.
 *
 * Omit `target` to measure the whole document.
 */
export function measureXml(
  xml: string,
  target?: NodeTarget,
  options: MeasureXmlOptions = {},
): Measurement {
  let root: XmlElement;
  try {
    root = parseXml(xml, options);
  } catch (error) {
    if (error instanceof EcfrTooLargeError) {
      return unavailable(
        WordCountStatus.UnavailableTooLarge,
        reasonDocumentOverParseCeiling(error.bytes, error.limitBytes),
      );
    }
    return unavailable(
      WordCountStatus.UnavailableParseFailed,
      error instanceof Error ? error.message : String(error),
    );
  }

  // Whether targeted or not, a document with no CFR structure in it is not regulation and must
  // not be counted. Without this the untargeted path returns `counted(0)` for truncated XML and
  // `counted(4)` for eCFR's "Please verify you are human" interstitial — a confident number
  // derived from something that is not the CFR, which is the exact failure this project exists
  // to prevent.
  if (!hasStructureElement(root)) {
    return unavailable(WordCountStatus.UnavailableParseFailed, REASON_NOT_REGULATION_XML);
  }

  if (target === undefined) return measureNode(root, options);

  const node = findNode(root, target);
  if (node === null) {
    const description = [target.type, target.identifier].filter(Boolean).join(' ');
    return unavailable(
      WordCountStatus.UnavailableParseFailed,
      reasonNodeNotFoundInXml(description),
    );
  }
  return measureNode(node, options);
}
