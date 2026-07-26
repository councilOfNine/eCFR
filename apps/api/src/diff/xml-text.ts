/**
 * eCFR XML -> readable lines, for diffing.
 *
 * RULE 2, NON-NEGOTIABLE: no regex touches this XML. DIV levels are not sequential (title 7
 * jumps DIV2 -> DIV5 thirty-five times) and title 40 contains 19,134 untyped `<DIV>` elements
 * inside sections, so pattern-matching the structure is not merely fragile, it is impossible.
 * fast-xml-parser in `preserveOrder` mode gives document order and real nesting.
 *
 * NOTE ON SCOPE: the sync pipeline's word counter EXCLUDES HEAD/AUTH/SOURCE/CITA/CONTENTS
 * boilerplate, measured at 18.4% of 1 CFR Chapter I, because a heading is not regulation text.
 * This extractor deliberately does NOT exclude them. A diff answers a different question: if
 * the authority citation or the source note changed, the person preparing a comment on the
 * rule wants to see it. The two functions disagree on purpose; only one of them produces a
 * published number, and it is not this one.
 */

import { XMLParser } from 'fast-xml-parser';

const TEXT_KEY = '#text';
const ATTR_KEY = ':@';

/**
 * Tags that start a new line.
 *
 * Everything not listed is treated as inline — `<I>`, `<E>`, `<SU>` and friends wrap emphasis
 * and superscripts mid-sentence, and breaking on those would shred every paragraph into
 * unusable diff fragments. Any `DIV*` element is a block by prefix, which covers both the
 * numbered levels and title 40's untyped ones.
 */
const BLOCK_TAGS = new Set([
  'ECFR',
  'HEAD',
  'HED',
  'SUBJECT',
  'P',
  'FP',
  'PSPACE',
  'AUTH',
  'SOURCE',
  'CITA',
  'EDNOTE',
  'EFFDNOT',
  'NOTE',
  'NOTES',
  'EXTRACT',
  'EXAMPLE',
  'FTNT',
  'TABLE',
  'ROW',
  'GPOTABLE',
  'TTITLE',
  'CONTENTS',
  'APPRO',
  'PRTPAGE',
  'IMG',
]);

/**
 * Constructed once at module scope.
 *
 * The parser is stateless between `parse` calls and building it costs real time; a Worker
 * isolate handles many requests, so paying that cost per request would be pure waste.
 */
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // eCFR text is full of &#8212; and &sect;. Without this they survive into the diff as
  // entity source and every line containing one reads as changed when nothing changed.
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

/**
 * fast-xml-parser's preserveOrder output: an array of single-key objects, where the key is
 * either a tag name (value: a nested array) or `#text` (value: a string). `:@` carries
 * attributes. Typed loosely because the shape is genuinely dynamic — this is XML.
 */
type OrderedNode = Record<string, unknown>;

/**
 * Read one attribute off a `:@` bag as a string.
 *
 * The bag is typed `unknown` because the parse result is genuinely dynamic. `parseAttributeValue`
 * is false above, so fast-xml-parser hands back strings — but coercing with `String()` would turn
 * any other shape into '[object Object]', and this value is compared against a section identifier.
 * A non-string is therefore treated as absent rather than stringified into a false match.
 */
function attrText(attrs: Record<string, unknown> | undefined, name: string): string {
  const value = attrs?.[name];
  return typeof value === 'string' ? value : '';
}

export interface ExtractedText {
  lines: string[];
  /** The requested section element was present in the document. */
  sectionFound: boolean;
  /** The document as a whole contained text, whether or not the section did. */
  documentHasText: boolean;
}

/**
 * Extract the text of one section as an array of lines.
 *
 * `sectionId` selects the element whose `N` attribute matches. The eCFR full-text endpoint's
 * `?section=` parameter already slices — unlike `?chapter=` and `?subtitle=`, which VALIDATE
 * BUT DO NOT SLICE and return the entire title, which is the upstream quirk that produced the
 * predecessor's fabricated word counts. Filtering here anyway costs nothing and means a
 * future change to that behaviour degrades to "slower", not "wrong document".
 *
 * When the section is NOT found, this returns no lines and says so, rather than falling back
 * to the whole document. Diffing a whole title against one section would render as a colossal
 * deletion, and inventing a change is the exact failure mode this module exists to prevent.
 * Disambiguating "the section is genuinely absent at this date" from "we fetched the wrong
 * thing" is the caller's job, and `documentHasText` is what it needs to do it.
 */
export function extractSectionLines(xml: string, sectionId: string): ExtractedText {
  const parsed = parser.parse(xml) as OrderedNode[];
  const target = findSection(parsed, sectionId);

  const raw: string[] = [];
  collect(target ?? [], raw);
  const lines = normalise(raw);

  if (target) return { lines, sectionFound: true, documentHasText: true };

  const whole: string[] = [];
  collect(parsed, whole);
  return {
    lines: [],
    sectionFound: false,
    documentHasText: normalise(whole).length > 0,
  };
}

function normalise(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    // Collapse runs of whitespace: eCFR's XML indentation varies between issues, and without
    // this every reindented paragraph reads as a change when the words are identical.
    const cleaned = line.replace(/\s+/g, ' ').trim();
    if (cleaned.length > 0) out.push(cleaned);
  }
  return out;
}

/**
 * Depth-first search for the section element.
 *
 * eCFR marks sections as `<DIV8 N="60.1" TYPE="SECTION">`, but the DIV level is not reliable
 * across titles, so the match is on the attributes rather than the tag name — any `DIV*`
 * whose `TYPE` is SECTION and whose `N` is the identifier we asked for.
 */
function findSection(nodes: OrderedNode[], sectionId: string): OrderedNode[] | null {
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key === TEXT_KEY || key === ATTR_KEY) continue;
      if (!Array.isArray(value)) continue;

      if (key.startsWith('DIV')) {
        const attrs = node[ATTR_KEY] as Record<string, unknown> | undefined;
        const type = attrText(attrs, '@_TYPE').toUpperCase();
        const n = attrText(attrs, '@_N');
        if (type === 'SECTION' && n === sectionId) return value as OrderedNode[];
      }

      const found = findSection(value as OrderedNode[], sectionId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Walk in document order, flushing a line whenever a block element opens or closes.
 *
 * Line granularity is what makes the diff readable: eCFR paragraphs are the unit a lawyer
 * thinks in, and Myers on paragraphs produces hunks that map to edits a human made. Diffing
 * on words or characters would be technically finer and practically useless.
 */
function collect(nodes: OrderedNode[], out: string[]): void {
  let buffer = '';

  const flush = (): void => {
    const trimmed = buffer.trim();
    if (trimmed.length > 0) out.push(trimmed);
    buffer = '';
  };

  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key === ATTR_KEY) continue;

      if (key === TEXT_KEY) {
        if (typeof value === 'string' && value.length > 0) buffer += `${value} `;
        continue;
      }

      if (!Array.isArray(value)) continue;

      const isBlock = BLOCK_TAGS.has(key) || key.startsWith('DIV');
      if (isBlock) {
        flush();
        collect(value as OrderedNode[], out);
      } else {
        // Inline: recurse into a temporary sink and splice the result back into the current
        // line, so `<P>see <I>id.</I> at 5</P>` stays one line.
        const inline: string[] = [];
        collect(value as OrderedNode[], inline);
        if (inline.length > 0) buffer += `${inline.join(' ')} `;
      }
    }
  }

  flush();
}
