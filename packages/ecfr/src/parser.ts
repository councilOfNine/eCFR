/**
 * eCFR XML -> a typed tree, countable prose, and safe display HTML.
 *
 * Why a real parser is not negotiable here:
 *
 *   - DIV levels are NOT sequential. Title 7 jumps DIV2 -> DIV5 thirty-five times, so depth
 *     does not imply level and a level does not imply a depth. Any regex or index-based
 *     extraction is wrong on real data.
 *   - Title 40 contains 19,134 untyped `<DIV>` elements INSIDE sections. A pattern that treats
 *     "a DIV" as "a structure node" mis-slices that entire title.
 *   - The predecessor's display path was `html.replace(/<[A-Z][^>]*>/g, '')` with no `/i` flag.
 *     10,386 lowercase `<br>` and 101 `<img>` tags went straight through it into
 *     `dangerouslySetInnerHTML`. The fix is structural: nothing here ever pattern-matches
 *     markup, and `toHtml` emits from an allowlist rather than removing from a denylist.
 *
 * Two conventions make the case-sensitivity class of bug impossible rather than merely fixed:
 * element names and attribute names are UPPERCASED during normalisation, so every lookup in
 * this file is case-insensitive by construction.
 *
 * Memory: normalising fast-xml-parser's output into our own nodes costs a second tree. A whole
 * title is 39-157 MB of XML and will land in the low gigabytes once parsed. That is affordable
 * in the Node sync (run with --max-old-space-size=8192) and impossible in a Worker (128 MB per
 * isolate). Parse PART slices, not whole titles — see `EcfrClient.fetchTitleXml`.
 */

import { xmlNotWellFormedMessage, xmlParserFailedMessage } from '@ecfr-atlas/core';
import { StructureNodeType } from '@ecfr-atlas/core/ecfr-schemas';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { EcfrParseError, EcfrTooLargeError } from './errors.js';

// ─── the node model ───────────────────────────────────────────────────────────

export interface XmlText {
  readonly text: string;
}

export interface XmlElement {
  /** Always uppercase. See the case-insensitivity note above. */
  readonly name: string;
  /** Keys always uppercase; values verbatim. */
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}

export type XmlNode = XmlElement | XmlText;

export function isElement(node: XmlNode): node is XmlElement {
  return (node as XmlElement).name !== undefined;
}

export function isText(node: XmlNode): node is XmlText {
  return (node as XmlText).text !== undefined && (node as XmlElement).name === undefined;
}

/** Synthetic name of the wrapper element returned by `parseXml`. */
export const DOCUMENT_ROOT = '#DOCUMENT';

/** The vocabulary is the DB's, imported rather than re-declared so the two cannot drift. */
export type CfrNodeType = StructureNodeType;

// ─── fast-xml-parser configuration ────────────────────────────────────────────

/**
 * Tags eCFR emits unpaired. Shared by the parser and the validator so the two cannot disagree
 * about whether a document is well-formed.
 */
const UNPAIRED_TAGS = ['br', 'BR', 'hr', 'HR', 'img', 'IMG'];

const ATTRS_KEY = ':@';
const TEXT_KEY = '#text';

const XML_PARSER = new XMLParser({
  // Ordered output. Without it, mixed content ("... the <E T="03">Administrator</E> shall ...")
  // loses the interleaving of text and children, and both word counting and rendering become
  // guesses about document order.
  preserveOrder: true,
  ignoreAttributes: false,
  // Empty prefix: attributes live in their own `:@` bag under preserveOrder, so there is no
  // key to collide with and no prefix worth stripping later.
  attributeNamePrefix: '',
  textNodeName: TEXT_KEY,
  alwaysCreateTextNode: true,
  // Do NOT trim. The whitespace between elements is the only thing keeping "...text</P>\n<P>and
  // more..." from concatenating into one token. `extractText` re-inserts a break where the
  // source genuinely has none; it cannot recover whitespace that the parser threw away.
  trimValues: false,
  // Identifiers are strings. Coercing them would turn part "1.10" into the number 1.1 and
  // silently merge two different parts.
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
  allowBooleanAttributes: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  // eCFR XML contains lowercase HTML-isms — 1,336 `<img>` and 774 `<br>` in 40 CFR 60 alone.
  // Declaring them unpaired stops a bare <br> from swallowing the remainder of the document as
  // its children.
  unpairedTags: UNPAIRED_TAGS,
  // `commentPropName` is intentionally unset: comments are dropped, so they can never reach
  // rendered HTML.
});

/**
 * Ceiling on a single `parseXml` call.
 *
 * 128 MiB accommodates every title except 40 (156,946,999 B) and keeps a runaway input from
 * taking the sync process down with an OOM instead of a diagnosable error.
 */
export const DEFAULT_MAX_PARSE_BYTES = 128 * 1024 * 1024;

export interface ParseOptions {
  maxBytes?: number;
  /**
   * Reject malformed XML rather than let fast-xml-parser salvage it. Defaults to true.
   *
   * The parser is lenient by design: handed the truncated `<DIV5 N="1"><P>unclosed` it returns
   * a perfectly usable tree containing a DIV5 with no countable text, and the measurement that
   * falls out is `counted(0)`. A truncated download reporting zero words is the under-report
   * failure mode — a number that looks entirely plausible and is wrong. `XMLValidator` catches
   * it as "Unclosed tag 'DIV5'".
   *
   * Measured cost: 220 ms against a 14.4 MB document that takes 357 ms to parse, and all nine
   * real eCFR documents sampled across seven titles validate clean. Roughly 7 s over the whole
   * 810 MB corpus, against a backfill whose serial fetch alone is 331 s.
   */
  validate?: boolean;
}

/** `XMLValidator.validate` returns `true` or this. Typed structurally to survive a rename. */
interface XmlValidationFailure {
  err: { code?: string; msg?: string; line?: number; col?: number };
}

const EMPTY_ATTRS: Readonly<Record<string, string>> = Object.freeze({});

function normalizeChildren(raw: unknown, out: XmlNode[]): void {
  if (!Array.isArray(raw)) return;
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;

    let attrs: Readonly<Record<string, string>> = EMPTY_ATTRS;
    const rawAttrs = record[ATTRS_KEY];
    if (rawAttrs !== null && typeof rawAttrs === 'object') {
      const collected: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawAttrs as Record<string, unknown>)) {
        collected[key.toUpperCase()] = typeof value === 'string' ? value : String(value);
      }
      attrs = collected;
    }

    for (const key of Object.keys(record)) {
      if (key === ATTRS_KEY) continue;
      if (key === TEXT_KEY) {
        const value = record[key];
        out.push({ text: typeof value === 'string' ? value : String(value) });
        continue;
      }
      const children: XmlNode[] = [];
      normalizeChildren(record[key], children);
      out.push({ name: key.toUpperCase(), attrs, children });
    }
  }
}

/** Parse a document into a synthetic root element holding the top-level nodes. */
export function parseXml(xml: string, options: ParseOptions = {}): XmlElement {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PARSE_BYTES;
  // Cheap upper bound on UTF-8 length; exact byte length would cost another full pass.
  if (xml.length > maxBytes) {
    throw new EcfrTooLargeError(xml.length, maxBytes);
  }
  if (options.validate !== false) {
    const verdict = XMLValidator.validate(xml, {
      allowBooleanAttributes: true,
      unpairedTags: UNPAIRED_TAGS,
    });
    if (verdict !== true) {
      const { err } = verdict as XmlValidationFailure;
      throw new EcfrParseError(xmlNotWellFormedMessage(err.msg, err.line, err.col));
    }
  }
  let raw: unknown;
  try {
    raw = XML_PARSER.parse(xml);
  } catch (error) {
    throw new EcfrParseError(
      xmlParserFailedMessage(error instanceof Error ? error.message : String(error)),
      error,
    );
  }
  const children: XmlNode[] = [];
  normalizeChildren(raw, children);
  return { name: DOCUMENT_ROOT, attrs: EMPTY_ATTRS, children };
}

// ─── structure identification ─────────────────────────────────────────────────

/**
 * Fallback level mapping, used only when a DIV carries no usable TYPE attribute.
 *
 * The DIV number is a LEVEL, never a depth. Title 7 goes DIV2 -> DIV5 directly thirty-five
 * times, so walking "children of a DIV3 are DIV4" finds nothing on real data.
 */
const DIV_NUMBER_TO_TYPE: Readonly<Record<string, CfrNodeType>> = {
  DIV1: StructureNodeType.Title,
  DIV2: StructureNodeType.Subtitle,
  DIV3: StructureNodeType.Chapter,
  DIV4: StructureNodeType.Subchapter,
  DIV5: StructureNodeType.Part,
  DIV6: StructureNodeType.Subpart,
  DIV7: StructureNodeType.SubjectGroup,
  DIV8: StructureNodeType.Section,
  // DIV9 is real and it matters. 40 CFR 60 alone contains 147 of them, all TYPE="APPENDIX",
  // holding 513,475 words — 30% of that part. Stopping the structure vocabulary at DIV8 would
  // make every part with appendices roll up short by exactly the appendices.
  DIV9: StructureNodeType.Appendix,
};

/** eCFR's TYPE attribute vocabulary, including the abbreviations it actually emits. */
const TYPE_ATTR_TO_TYPE: Readonly<Record<string, CfrNodeType>> = {
  TITLE: StructureNodeType.Title,
  SUBTITLE: StructureNodeType.Subtitle,
  CHAPTER: StructureNodeType.Chapter,
  SUBCHAP: StructureNodeType.Subchapter,
  SUBCHAPTER: StructureNodeType.Subchapter,
  PART: StructureNodeType.Part,
  SUBPART: StructureNodeType.Subpart,
  SUBJGRP: StructureNodeType.SubjectGroup,
  SUBJECTGROUP: StructureNodeType.SubjectGroup,
  SUBJECT_GROUP: StructureNodeType.SubjectGroup,
  SECTION: StructureNodeType.Section,
  SECT: StructureNodeType.Section,
  APPENDIX: StructureNodeType.Appendix,
  APP: StructureNodeType.Appendix,
};

/**
 * Any numbered DIV, not a fixed 1..8 range. eCFR emits DIV9 today and has no stated ceiling;
 * an open pattern degrades to "structure node of unknown level" rather than to "invisible".
 */
const DIV_NUMBERED_RE = /^DIV\d+$/;

/**
 * Is this element a structure node at all?
 *
 * The TAG decides structure-ness, not the TYPE attribute. That ordering is what keeps title
 * 40's 19,134 bare `<DIV>` content wrappers out of the structure tree — they are DIV, not
 * DIVn, so they are content no matter what attributes they happen to carry. eCFR also uses
 * `<DIV width="100%">` and `<DIV class="gpotbl_div">` as pure layout wrappers around tables,
 * which the same rule excludes.
 */
export function isStructureElement(element: XmlElement): boolean {
  return DIV_NUMBERED_RE.test(element.name);
}

/**
 * The CFR level of a structure element.
 *
 * TYPE wins where present because it is what eCFR asserts; the DIV number is the fallback for
 * the elements that omit it. Returns null for anything that is not a numbered DIV.
 */
export function nodeTypeOf(element: XmlElement): CfrNodeType | null {
  if (!isStructureElement(element)) return null;
  const declared = element.attrs.TYPE;
  if (declared !== undefined) {
    const key = declared
      .trim()
      .toUpperCase()
      .replace(/[^A-Z_]/g, '');
    const mapped = TYPE_ATTR_TO_TYPE[key];
    if (mapped !== undefined) return mapped;
  }
  return DIV_NUMBER_TO_TYPE[element.name] ?? null;
}

/**
 * Identifier normalisation for matching.
 *
 * Uppercased so roman-numeral chapters match regardless of source casing, and stripped of a
 * leading section symbol because section identifiers appear both as `1.1` and `§ 1.1`.
 */
export function normalizeIdentifier(value: string): string {
  return value
    .replace(/^[\s§]+/, '')
    .trim()
    .toUpperCase();
}

/** The `N` attribute, normalised. Null for hed1 nodes and generated subject groups. */
export function identifierOf(element: XmlElement): string | null {
  const raw = element.attrs.N;
  if (raw === undefined) return null;
  const normalized = normalizeIdentifier(raw);
  return normalized === '' ? null : normalized;
}

export interface NodeTarget {
  type?: CfrNodeType;
  identifier?: string;
}

function matchesTarget(element: XmlElement, target: NodeTarget): boolean {
  if (!isStructureElement(element)) return false;
  if (target.type !== undefined && nodeTypeOf(element) !== target.type) return false;
  if (target.identifier !== undefined) {
    if (identifierOf(element) !== normalizeIdentifier(target.identifier)) return false;
  }
  return true;
}

/**
 * Locate a subtree by level and identifier.
 *
 * Searches the whole tree rather than descending level by level, precisely because levels are
 * not sequential and a chapter's parent may be the title itself or a subtitle in between.
 */
export function findNode(root: XmlElement, target: NodeTarget): XmlElement | null {
  if (target.type === undefined && target.identifier === undefined) return null;
  const stack: XmlNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as XmlNode;
    if (!isElement(node)) continue;
    if (node !== root && matchesTarget(node, target)) return node;
    // Pushed in reverse so the pop order is document order; a title with two chapters sharing
    // an identifier (it happens across subtitles) should resolve to the first.
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i];
      if (child !== undefined) stack.push(child);
    }
  }
  return null;
}

/**
 * Does this document contain any CFR structure at all?
 *
 * The guard against counting something that is not regulation. eCFR serves an HTML interstitial
 * to clients it thinks are scrapers, and a CAPTCHA page parses perfectly well as XML — without
 * this check, "Please verify you are human" is four countable words and the answer comes back
 * as a confident number. Early-exits on the first hit, so it is cheap on real documents.
 */
export function hasStructureElement(root: XmlElement): boolean {
  const stack: XmlNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as XmlNode;
    if (!isElement(node)) continue;
    if (node !== root && isStructureElement(node)) return true;
    for (const child of node.children) stack.push(child);
  }
  return false;
}

/** Every matching subtree, document-ordered. Used for per-chapter sums within a title. */
export function findAllNodes(root: XmlElement, target: NodeTarget): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (node: XmlNode): void => {
    if (!isElement(node)) return;
    if (node !== root && matchesTarget(node, target)) found.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return found;
}

/**
 * Convenience matching the shape callers expect when they hold raw XML.
 *
 * Reparses on every call. Parse once and reuse `findNode` when looking up more than one node
 * in the same document.
 */
export function findNodeInXml(
  xml: string,
  target: NodeTarget,
  options: ParseOptions = {},
): XmlElement | null {
  return findNode(parseXml(xml, options), target);
}

/**
 * Immediate structure descendants, skipping non-structure wrappers.
 *
 * Non-sequential levels mean the structural children of a DIV3 may be DIV5s, and they may sit
 * inside a content DIV. This descends through anything that is not itself a structure node.
 */
export function childStructureNodes(element: XmlElement): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (node: XmlNode): void => {
    if (!isElement(node)) return;
    if (isStructureElement(node)) {
      found.push(node);
      return; // do not descend past a structure boundary
    }
    for (const child of node.children) visit(child);
  };
  for (const child of element.children) visit(child);
  return found;
}

// ─── text extraction ──────────────────────────────────────────────────────────

/**
 * Elements whose text is excluded from the word count.
 *
 * Measured at 18.4% of 1 CFR Chapter I. Every entry is apparatus rather than regulation:
 *
 *   HEAD      headings. Repeated verbatim in every ancestor's table of contents, so counting
 *             them inflates the parent and double-counts the child.
 *   AUTH      the statutory authority line ("Authority: 5 U.S.C. 301."). Boilerplate, and
 *             identical across large runs of parts.
 *   SOURCE    the Federal Register source line. Provenance, not regulation.
 *   CITA      a bare citation line, same argument as SOURCE.
 *   CONTENTS  a generated table of contents. Pure duplication of the HEADs below it.
 *   EAR       the running-head "ear" printed in the margin of the paper CFR.
 *   FTNT      footnote apparatus.
 *
 * Table markup is excluded as well: the tags below carry cell scaffolding whose "words" are
 * column labels and repeated units, not prose, and counting them would make a title's total a
 * function of how its tables were laid out. eCFR's versioner XML uses HTML table markup
 * (TABLE/CAPTION/THEAD/TBODY/TFOOT/TR/TH/TD) rather than the GPO vocabulary
 * (GPOTABLE/BOXHD/CHED/ROW/ENT); both are listed because both appear in CFR source and
 * excluding only the ancestor would leave a stray row countable.
 *
 * ONE ADDITION beyond the measured list, called out because it changes a published number:
 *
 *   XREF      eCFR injects "Link to an amendment published at 91 FR 43564, July 16, 2026."
 *             into sections with a pending amendment. It is eCFR's editorial navigation, not
 *             regulation, and it appears and disappears as amendments pend — so counting it
 *             makes a section's word count move for a reason that has nothing to do with the
 *             regulation. Measured at 17 occurrences and 204 words in 40 CFR 60 (0.012% of
 *             that part) and absent from 1 CFR entirely.
 *
 * Deliberately NOT excluded, having been checked:
 *
 *   HD1/HD2/HD3  undesignated centre headings inside a section body ("1.3 Summary of
 *                Procedure"). 1,997 of them and 9,418 words in 40 CFR 60. Unlike HEAD they do
 *                not appear in any ancestor's table of contents, so counting them duplicates
 *                nothing — they are regulation text that happens to be set as a heading.
 *   MATH         equations, which eCFR publishes as raster images. They contain no text and
 *                so contribute zero words. That is a real limitation of the source, recorded
 *                here rather than papered over.
 */
export const EXCLUDED_FROM_COUNT: ReadonlySet<string> = new Set([
  'HEAD',
  'AUTH',
  'SOURCE',
  'CITA',
  'CONTENTS',
  'EAR',
  'FTNT',
  'XREF',
  // A section-scoped authority statement. Same apparatus as AUTH, different tag; rare (2
  // occurrences across the seven sampled parts) but classifying it anywhere else would make
  // the treatment of an authority line depend on which tag eCFR happened to use.
  'SECAUTH',
  // HTML table markup, as emitted by the versioner API
  'TABLE',
  'CAPTION',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TH',
  'TD',
  // GPO table markup
  'GPOTABLE',
  'BOXHD',
  'CHED',
  'ROW',
  'ENT',
  'TTITLE',
  'TDESC',
  'TNOTE',
]);

/**
 * Elements after which a word boundary is guaranteed.
 *
 * The baseline behaviour is pure concatenation of source text, which is what the ElementTree
 * cross-check used when per-chapter DIV3 sums matched the whole-title count to within 4 words.
 * Deviating from that baseline for an unknown tag risks splitting one word into two, so the
 * set is an explicit allowlist of block containers and unknown tags default to inline.
 */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  'DIV',
  'DIV1',
  'DIV2',
  'DIV3',
  'DIV4',
  'DIV5',
  'DIV6',
  'DIV7',
  'DIV8',
  'DIV9',
  'P',
  'PSPACE',
  // eCFR's flush-paragraph family, verified present in title 40: FP, FP-1, FP-2, FP1-2 and
  // FP-DASH all appear, and each is a block.
  'FP',
  'FP1',
  'FP2',
  'FP-1',
  'FP-2',
  'FP1-2',
  'FP-DASH',
  'FLUSHTEXT',
  'HED',
  'HD1',
  'HD2',
  'HD3',
  'HEAD',
  'SECTNO',
  'SUBJECT',
  'EXTRACT',
  'NOTE',
  'NOTES',
  'EDNOTE',
  'EFFDNOT',
  'APPRO',
  'AUTH',
  'SOURCE',
  'CITA',
  'CONTENTS',
  'FTNT',
  'XREF',
  'SECAUTH',
  'LI',
  'ITEM',
  // Block containers found by censusing seven parts across titles 7, 12, 21, 26, 29, 40 and
  // 50. Each is listed because an unlisted block merges its last word into the next block's
  // first word wherever the source omits whitespace at the boundary.
  'EXAMPLE',
  'P-1',
  'P-2',
  'FL-1',
  'FL-2',
  'FRP',
  'BOXTXT',
  'SCOL2',
  'LDRFIG',
  'LDRWK',
  'HED1',
  'TCAP',
  'BCAP',
  'MATH',
  'TABLE',
  'CAPTION',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TH',
  'TD',
  'GPOTABLE',
  'ROW',
  'ENT',
  'CHED',
  'BOXHD',
  'TTITLE',
]);

export interface TextSink {
  text(chunk: string): void;
  /** A guaranteed word boundary. Never merges two words; never splits one. */
  blockBreak(): void;
}

export interface WalkOptions {
  /** Stop once this many characters of countable text have been seen. */
  maxChars?: number;
  /**
   * Do not descend into nested structure nodes, yielding only the text the node owns directly.
   *
   * This exists because a parent's text is NOT the union of its structure children's text.
   * Measured across seven parts: 40 CFR 60, 7 CFR 210, 12 CFR 1026 and 50 CFR 17 have no
   * residue, but 29 CFR 1910 holds 146 words directly under the part, 21 CFR 201 holds 15 and
   * 26 CFR 20 holds 5. Rolling a parent up from its children alone silently loses those.
   */
  stopAtStructureBoundary?: boolean;
}

export interface WalkResult {
  chars: number;
  /** True when `maxChars` was hit. The result is INCOMPLETE and must not be published. */
  truncated: boolean;
}

/**
 * Feed a node's countable prose to a sink, without ever materialising it as one string.
 *
 * Streaming matters at this scale: the corpus is 665,622,840 bytes of text and the largest
 * single section is 5,010,215 bytes. Counting as we walk means a node can be measured without
 * allocating a copy of it, and means `maxChars` aborts before the memory is spent rather than
 * after.
 */
export function walkCountableText(
  element: XmlElement,
  sink: TextSink,
  options: WalkOptions = {},
): WalkResult {
  const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;
  const stopAtStructure = options.stopAtStructureBoundary === true;
  let chars = 0;
  let truncated = false;

  const visit = (node: XmlNode): boolean => {
    if (isText(node)) {
      const chunk = node.text;
      if (chunk.length === 0) return true;
      if (chars + chunk.length > maxChars) {
        truncated = true;
        return false;
      }
      chars += chunk.length;
      sink.text(chunk);
      return true;
    }
    if (!isElement(node)) return true;
    if (EXCLUDED_FROM_COUNT.has(node.name)) return true;
    if (stopAtStructure && node !== element && isStructureElement(node)) return true;

    const isBlock = BLOCK_ELEMENTS.has(node.name);
    if (isBlock) sink.blockBreak();
    for (const child of node.children) {
      if (!visit(child)) return false;
    }
    if (isBlock) sink.blockBreak();
    return true;
  };

  visit(element);
  return { chars, truncated };
}

class StringSink implements TextSink {
  readonly #parts: string[] = [];
  #pendingBreak = false;
  #lastChar = '';

  text(chunk: string): void {
    if (chunk.length === 0) return;
    if (this.#pendingBreak) {
      this.#pendingBreak = false;
      // Only insert where the source genuinely has no whitespace. Inserting unconditionally
      // would add a token boundary that the ElementTree baseline does not have.
      if (this.#lastChar !== '' && !isSpaceLike(this.#lastChar) && !isSpaceLike(chunk[0] ?? '')) {
        this.#parts.push('\n');
      }
    }
    this.#parts.push(chunk);
    this.#lastChar = chunk[chunk.length - 1] ?? '';
  }

  blockBreak(): void {
    if (this.#parts.length > 0) this.#pendingBreak = true;
  }

  value(): string {
    return this.#parts.join('');
  }
}

function isSpaceLike(char: string): boolean {
  return char === '' || /\s/u.test(char);
}

/**
 * The countable prose of a subtree, as one string.
 *
 * Allocates the whole thing. Prefer `walkCountableText` with a streaming sink for anything
 * measured in megabytes; this exists for display, diffing, and tests.
 */
export function extractText(element: XmlElement, options: WalkOptions = {}): string {
  const sink = new StringSink();
  walkCountableText(element, sink, options);
  return sink.value();
}

/** Raw text of the first direct HEAD child, ignoring the count exclusions. */
export function headText(element: XmlElement): string | null {
  for (const child of element.children) {
    if (isElement(child) && child.name === 'HEAD') {
      return collectAllText(child).trim();
    }
  }
  return null;
}

/** Every descendant text node, exclusions ignored. For headings and metadata only. */
function collectAllText(element: XmlElement): string {
  const parts: string[] = [];
  const visit = (node: XmlNode): void => {
    if (isText(node)) {
      parts.push(node.text);
      return;
    }
    if (isElement(node)) for (const child of node.children) visit(child);
  };
  visit(element);
  return parts.join('');
}

const RESERVED_RE = /\[\s*reserved\s*\]/i;

/**
 * A reserved node: present in the structure, no text by definition.
 *
 * Detected from the node's own HEAD only, so a part containing one reserved section is not
 * itself flagged. This distinction is why `reserved_empty` exists as a status separate from a
 * measured zero: "0 because it is reserved" and "0 because we parsed it and found nothing"
 * are different claims and only one of them is a bug when it is wrong.
 */
export function isReservedNode(element: XmlElement): boolean {
  const head = headText(element);
  return head !== null && RESERVED_RE.test(head);
}

// ─── display HTML ─────────────────────────────────────────────────────────────

interface HtmlRule {
  /** HTML element to emit, or null to recurse without emitting a wrapper. */
  tag: string | null;
  className?: string;
  /** Emit no children (void element). */
  void?: true;
  /** Drop the element and its entire subtree. */
  drop?: true;
  /** source attribute -> data-* attribute name. Values are escaped; nothing else is copied. */
  data?: Readonly<Record<string, string>>;
}

/**
 * The allowlist.
 *
 * Three invariants, all of them reactions to how the predecessor's stripper failed:
 *   1. an element not in this table emits NO markup — it is transparent, and its text still
 *      renders. An unknown tag can therefore never become an unknown element in the output.
 *   2. no source attribute is ever copied to the output except through `data`, so there is no
 *      path by which a source `href`, `src`, or event handler reaches a browser.
 *   3. IMG is dropped outright rather than rewritten. eCFR image URLs are resolvable, but
 *      emitting them makes every regulation page issue cross-origin requests to ecfr.gov,
 *      which violates the project's no-outbound-calls-on-the-read-path rule.
 */
const HTML_RULES: Readonly<Record<string, HtmlRule>> = {
  P: { tag: 'p', className: 'reg-paragraph' },
  PSPACE: { tag: 'p', className: 'reg-paragraph' },
  FP: { tag: 'p', className: 'reg-flush-paragraph' },
  'FP-1': { tag: 'p', className: 'reg-flush-paragraph reg-indent-1' },
  'FP-2': { tag: 'p', className: 'reg-flush-paragraph reg-indent-2' },
  'FP1-2': { tag: 'p', className: 'reg-flush-paragraph reg-indent-2' },
  'FP-DASH': { tag: 'p', className: 'reg-flush-paragraph reg-dash-leader' },
  FP1: { tag: 'p', className: 'reg-flush-paragraph reg-indent-1' },
  FP2: { tag: 'p', className: 'reg-flush-paragraph reg-indent-2' },
  FLUSHTEXT: { tag: 'p', className: 'reg-flush-paragraph' },
  // The label inside AUTH/SOURCE ("Authority:", "Source:"). Emphatically not a heading —
  // rendering it as one would put an <h3>Authority:</h3> above every part in the corpus.
  HED: { tag: 'span', className: 'reg-label' },
  HED1: { tag: 'span', className: 'reg-label' },
  'P-1': { tag: 'p', className: 'reg-paragraph reg-indent-1' },
  'P-2': { tag: 'p', className: 'reg-paragraph reg-indent-2' },
  'FL-1': { tag: 'p', className: 'reg-flush-paragraph reg-indent-1' },
  'FL-2': { tag: 'p', className: 'reg-flush-paragraph reg-indent-2' },
  FRP: { tag: 'p', className: 'reg-paragraph' },
  EXAMPLE: { tag: 'div', className: 'reg-example' },
  BOXTXT: { tag: 'div', className: 'reg-boxed-text' },
  SCOL2: { tag: 'div', className: 'reg-two-column' },
  LDRFIG: { tag: 'p', className: 'reg-leader' },
  LDRWK: { tag: 'p', className: 'reg-leader' },
  SECAUTH: { tag: 'div', className: 'reg-authority' },
  FTREF: { tag: 'sup', className: 'reg-footnote-ref' },
  SECTNO: { tag: 'span', className: 'reg-section-number' },
  SUBJECT: { tag: 'span', className: 'reg-section-subject' },
  EXTRACT: { tag: 'blockquote', className: 'reg-extract' },
  NOTE: { tag: 'aside', className: 'reg-note' },
  NOTES: { tag: 'aside', className: 'reg-note' },
  EDNOTE: { tag: 'aside', className: 'reg-editorial-note' },
  EFFDNOT: { tag: 'aside', className: 'reg-effective-date-note' },
  AUTH: { tag: 'div', className: 'reg-authority' },
  SOURCE: { tag: 'div', className: 'reg-source' },
  CITA: { tag: 'p', className: 'reg-citation' },
  APPRO: { tag: 'p', className: 'reg-approval' },
  FTNT: { tag: 'div', className: 'reg-footnote' },
  LI: { tag: 'p', className: 'reg-item' },
  ITEM: { tag: 'p', className: 'reg-item' },
  // Source-cased lowercase HTML-isms arrive here uppercased, so `em`/`strong`/`sup`/`sub`/
  // `img`/`br` from the source are matched by the same entries as their CFR equivalents.
  E: { tag: 'em', className: 'reg-emphasis' },
  EM: { tag: 'em', className: 'reg-emphasis' },
  I: { tag: 'em', className: 'reg-emphasis' },
  B: { tag: 'strong', className: 'reg-strong' },
  STRONG: { tag: 'strong', className: 'reg-strong' },
  SU: { tag: 'sup', className: 'reg-superscript' },
  SUP: { tag: 'sup', className: 'reg-superscript' },
  SUB: { tag: 'sub', className: 'reg-subscript' },
  FR: { tag: 'span', className: 'reg-fraction' },
  BR: { tag: 'br', void: true },
  HR: { tag: null },
  IMG: { tag: null, drop: true },
  // eCFR publishes every equation as a raster image, so MATH's only child is an <img> that we
  // drop. The empty span is a hook for CSS to mark the gap honestly rather than render nothing
  // where a formula belongs.
  MATH: { tag: 'span', className: 'reg-equation reg-equation-image-only' },
  TCAP: { tag: 'p', className: 'reg-graphic-caption reg-graphic-caption-top' },
  BCAP: { tag: 'p', className: 'reg-graphic-caption reg-graphic-caption-bottom' },
  XREF: { tag: 'p', className: 'reg-amendment-notice' },
  PRTPAGE: { tag: 'span', className: 'reg-print-page', void: true, data: { P: 'page' } },
  // HTML table markup, which is what the versioner API actually emits. Without these the
  // cells fall out of the <table> and browsers hoist the text above it.
  TABLE: { tag: 'table', className: 'reg-table' },
  CAPTION: { tag: 'caption', className: 'reg-table-caption' },
  THEAD: { tag: 'thead', className: 'reg-table-head' },
  TBODY: { tag: 'tbody', className: 'reg-table-body' },
  TFOOT: { tag: 'tfoot', className: 'reg-table-foot' },
  TR: { tag: 'tr', className: 'reg-table-row' },
  TH: { tag: 'th', className: 'reg-table-heading' },
  TD: { tag: 'td', className: 'reg-table-cell' },
  // GPO table markup, for the titles that still use it.
  GPOTABLE: { tag: 'table', className: 'reg-table' },
  TTITLE: { tag: 'caption', className: 'reg-table-caption' },
  BOXHD: { tag: 'thead', className: 'reg-table-head' },
  CHED: { tag: 'th', className: 'reg-table-heading' },
  ROW: { tag: 'tr', className: 'reg-table-row' },
  ENT: { tag: 'td', className: 'reg-table-cell' },
  CONTENTS: { tag: null, drop: true },
  EAR: { tag: null, drop: true },
};

/**
 * Undesignated centre headings inside a section body, mapped to a heading one level below the
 * containing node's own HEAD. Distinct from HEAD: these are not table-of-contents entries and
 * they are counted as regulation text.
 */
const SUB_HEADING_OFFSETS: Readonly<Record<string, number>> = { HD1: 1, HD2: 2, HD3: 3 };

/** `E T="03"` is italic, `04` bold, `52` small caps. Anything else gets no modifier class. */
const EMPHASIS_TYPE_CLASSES: Readonly<Record<string, string>> = {
  '01': 'reg-emphasis-bold-italic',
  '02': 'reg-emphasis-bold',
  '03': 'reg-emphasis-italic',
  '04': 'reg-emphasis-bold',
  '51': 'reg-emphasis-superscript',
  '52': 'reg-emphasis-small-caps',
};

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape text for HTML.
 *
 * Required, not optional: fast-xml-parser decodes entities during parsing, so `&amp;` in the
 * source arrives here as a bare `&` and must be re-encoded on the way out.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

export interface NodeMetadata {
  /** The node's own HEAD text. */
  heading: string | null;
  /** AUTH lines, label stripped. */
  authority: string[];
  /** SOURCE lines, label stripped. */
  source: string[];
  /** Federal Register citations found in the authority, source and citation lines. */
  frCitations: string[];
}

export interface RenderedNode {
  html: string;
  meta: NodeMetadata;
}

export interface ToHtmlOptions {
  /** Heading level for the rendered node itself. Defaults to 2, leaving h1 to the page. */
  headingLevel?: number;
  /** Abort rather than emit more than this much HTML. */
  maxChars?: number;
}

const LABEL_PREFIX_RE = /^(authority|source|citation)\s*:\s*/i;

function stripLabel(value: string): string {
  return value.replace(LABEL_PREFIX_RE, '').trim();
}

/**
 * Federal Register citations, e.g. "84 FR 12345".
 *
 * This regex runs over text that has ALREADY been extracted by the parser — it is not being
 * used to find structure in markup, which is the thing that is forbidden. It is also a
 * literal, never built from input, so there is no ReDoS surface.
 */
function extractFrCitations(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b(\d{1,3})\s+FR\s+(\d{1,6})\b/g)) {
    found.add(`${match[1]} FR ${match[2]}`);
  }
  return [...found];
}

/**
 * Render a subtree as display HTML plus its metadata.
 *
 * Walks the parsed tree and emits from `HTML_RULES`. There is no tag stripping anywhere in
 * this function, and no source markup is ever copied through verbatim.
 */
export function toHtml(element: XmlElement, options: ToHtmlOptions = {}): RenderedNode {
  const baseLevel = Math.min(Math.max(options.headingLevel ?? 2, 1), 6);
  const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;

  const out: string[] = [];
  let length = 0;
  const meta: NodeMetadata = { heading: null, authority: [], source: [], frCitations: [] };
  const citationText: string[] = [];

  const emit = (chunk: string): void => {
    length += chunk.length;
    if (length > maxChars) throw new EcfrTooLargeError(length, maxChars);
    out.push(chunk);
  };

  /**
   * `structureDepth` counts nested DIV1..DIV8 boundaries, not tree depth. Levels are not
   * sequential, so the rendered node's own heading must sit at `headingLevel` regardless of
   * whether it happens to be a DIV3 or a DIV8, with each nested structure level one deeper.
   */
  const visit = (node: XmlNode, structureDepth: number): void => {
    if (isText(node)) {
      emit(escapeHtml(node.text));
      return;
    }
    if (!isElement(node)) return;

    // Metadata is harvested on the way past, so the tree is walked once.
    if (node.name === 'AUTH') {
      const value = stripLabel(collectAllText(node));
      if (value !== '') {
        meta.authority.push(value);
        citationText.push(value);
      }
    } else if (node.name === 'SOURCE') {
      const value = stripLabel(collectAllText(node));
      if (value !== '') {
        meta.source.push(value);
        citationText.push(value);
      }
    } else if (node.name === 'CITA') {
      citationText.push(collectAllText(node));
    }

    if (isStructureElement(node)) {
      const type = nodeTypeOf(node) ?? 'node';
      const identifier = identifierOf(node);
      emit(
        `<section class="reg-${type}"${identifier ? ` data-identifier="${escapeHtml(identifier)}"` : ''}>`,
      );
      for (const child of node.children) visit(child, structureDepth + 1);
      emit('</section>');
      return;
    }

    const subHeadingOffset = SUB_HEADING_OFFSETS[node.name];
    if (node.name === 'HEAD' || subHeadingOffset !== undefined) {
      const own = baseLevel + Math.max(structureDepth - 1, 0);
      const level = Math.min(own + (subHeadingOffset ?? 0), 6);
      if (node.name === 'HEAD') {
        const text = collectAllText(node).trim();
        if (meta.heading === null && text !== '') meta.heading = text;
      }
      const headingClass = subHeadingOffset === undefined ? 'reg-heading' : 'reg-subheading';
      emit(`<h${level} class="${headingClass}">`);
      for (const child of node.children) visit(child, structureDepth);
      emit(`</h${level}>`);
      return;
    }

    const rule = HTML_RULES[node.name];
    if (rule?.drop) return;

    if (rule?.tag === undefined || rule.tag === null) {
      // Transparent: unknown or deliberately unwrapped elements contribute their text only.
      for (const child of node.children) visit(child, structureDepth);
      return;
    }

    let className = rule.className ?? '';
    if ((node.name === 'E' || node.name === 'I') && node.attrs.T !== undefined) {
      const modifier = EMPHASIS_TYPE_CLASSES[node.attrs.T];
      if (modifier !== undefined) className = `${className} ${modifier}`.trim();
    }

    let attributes = className === '' ? '' : ` class="${escapeHtml(className)}"`;
    if (rule.data) {
      for (const [sourceAttr, dataName] of Object.entries(rule.data)) {
        const value = node.attrs[sourceAttr];
        if (value !== undefined) attributes += ` data-${dataName}="${escapeHtml(value)}"`;
      }
    }

    if (rule.void) {
      emit(`<${rule.tag}${attributes}>`);
      return;
    }
    emit(`<${rule.tag}${attributes}>`);
    for (const child of node.children) visit(child, structureDepth);
    emit(`</${rule.tag}>`);
  };

  visit(element, 0);

  if (meta.heading === null) meta.heading = headText(element);
  meta.frCitations = extractFrCitations(citationText.join('\n'));

  return { html: out.join(''), meta };
}
