/**
 * Turn one title's XML into measurements and HTML, in a single parse.
 *
 * Parsing is the expensive half of the pipeline and the memory-critical one. Title 26 decodes
 * to roughly 174 MB as a V8 two-byte string (50,914 characters above U+00FF force the wide
 * representation), and title 40 is 156,946,999 bytes on the wire. Both are comfortably over a
 * Worker's 128 MB per-isolate limit, which is the whole reason this runs in Node — but they
 * are only comfortable in Node if the document is parsed once and walked twice, not parsed
 * per node.
 *
 * Rendered HTML is handed straight to a callback rather than accumulated. Buffering title
 * 40's ~1,600 part pages before uploading would hold a second copy of the corpus in memory
 * next to the parsed tree.
 *
 * Measurement is delegated to `@ecfr-atlas/ecfr`'s `measureNode`, which is where the
 * boilerplate exclusion lives: HEAD/AUTH/SOURCE/CITA/CONTENTS are 18.4% of 1 CFR Chapter I
 * and counting them would inflate every number on the site by roughly a fifth.
 */

import type { Measurement } from '@ecfr-atlas/core';
import { displayCitation, ecfrUrl, unavailable, WordCountStatus } from '@ecfr-atlas/core';

import type { EcfrModule, ParsedDocument } from './ecfr-adapter.js';
import type { Logger } from './log.js';
import type { RenderUnit } from './render.js';
import { wrapFragment } from './render.js';
import type { FlatNode } from './structure.js';

export interface ProcessTitleInput {
  titleNumber: number;
  sourceDate: string;
  xml: string;
  /** Leaves to measure. In a delta this is only the refetched part's leaves. */
  leaves: readonly FlatNode[];
  /**
   * Containers whose DIRECTLY-owned text is measured (see `containersOf`). Parts and below.
   */
  containers: readonly FlatNode[];
  /** Render units to emit. In a delta, only the refetched parts'. */
  units: readonly RenderUnit[];
  byCitation: ReadonlyMap<string, FlatNode>;
  onLeaf(citation: string, measurement: Measurement): void;
  /**
   * Called ONLY with a measurement that succeeded.
   *
   * A container the XML does not contain records nothing, so its roll-up degrades to its
   * children rather than turning the whole subtree unknown over a lookup that failed. That
   * asymmetry is deliberate: own text is a correction to a sum, and a correction we could not
   * take must not destroy the sum it was going to correct.
   */
  onOwnText(citation: string, measurement: Measurement): void;
  /** Awaited, so an R2 upload backpressures the walk instead of queueing unboundedly. */
  onUnit(unit: RenderUnit, html: string): Promise<void>;
}

export interface ProcessTitleResult {
  leavesMeasured: number;
  parseFailures: number;
  unitsRendered: number;
  /** Containers whose directly-owned text was measured. Not a failure count either way. */
  containersMeasured: number;
  /** Containers that carry text of their own. Expected to be small; logged when it is not. */
  containersWithOwnText: number;
}

export async function processTitleXml(
  ecfr: EcfrModule,
  input: ProcessTitleInput,
  log: Logger,
): Promise<ProcessTitleResult> {
  const result: ProcessTitleResult = {
    leavesMeasured: 0,
    parseFailures: 0,
    unitsRendered: 0,
    containersMeasured: 0,
    containersWithOwnText: 0,
  };

  let doc: ParsedDocument;
  try {
    doc = ecfr.parser.parse(input.xml);
  } catch (error) {
    // The whole title failed to parse. Every leaf becomes explicitly unavailable rather than
    // silently absent — an absent leaf and an unparseable one look identical downstream
    // otherwise, and only one of them is worth paging someone about.
    const reason = `title ${input.titleNumber} XML did not parse: ${
      error instanceof Error ? error.message : String(error)
    }`;
    for (const leaf of input.leaves) {
      input.onLeaf(leaf.citation, unavailable(WordCountStatus.UnavailableParseFailed, reason));
    }
    return { ...result, parseFailures: input.leaves.length };
  }

  // Part-scoped XML lookup. A bare identifier search from the title root is the bug that
  // shipped part 2's text inside part 431's slice pages: every part has a subpart A, and
  // findNode returns the first one in document order. Part identifiers are unique within a
  // title, so the part is located once globally and everything beneath it is searched inside
  // that subtree only. Section and appendix identifiers embed their part number and are
  // globally unique anyway — which is why the MEASUREMENTS were right all along while the
  // rendered slices were wrong. A citation with no part segment falls back to the global
  // search; a part the XML lacks leaves the target unresolved so absence keeps being
  // reported per-leaf, never satisfied by a same-named node in someone else's part.
  const partNodes = new Map<string, ReturnType<EcfrModule['parser']['findNode']>>();
  const scopedFind = (
    citation: string,
    target: Parameters<EcfrModule['parser']['findNode']>[1],
  ): ReturnType<EcfrModule['parser']['findNode']> => {
    let partIdentifier: string | null = null;
    for (const segment of citation.split('/')) {
      if (segment.startsWith('part-')) {
        partIdentifier = segment.slice('part-'.length);
        break;
      }
    }
    if (partIdentifier === null || target.type === 'part') {
      return ecfr.parser.findNode(doc, target);
    }
    let partNode = partNodes.get(partIdentifier);
    if (partNode === undefined) {
      partNode = ecfr.parser.findNode(doc, { type: 'part', identifier: partIdentifier });
      partNodes.set(partIdentifier, partNode);
    }
    return partNode === null ? ecfr.parser.findNode(doc, target) : ecfr.parser.findNode(partNode, target);
  };

  for (const leaf of input.leaves) {
    if (!leaf.identifier) {
      input.onLeaf(
        leaf.citation,
        unavailable(
          WordCountStatus.UnavailableParseFailed,
          `${leaf.citation} has no identifier to look up`,
        ),
      );
      result.parseFailures += 1;
      continue;
    }

    let node: unknown;
    try {
      node = scopedFind(leaf.citation, { type: leaf.nodeType, identifier: leaf.identifier });
    } catch (error) {
      node = null;
      log.debug('findNode threw', {
        citation: leaf.citation,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (node === null || node === undefined) {
      // Structure JSON lists it, the XML does not contain it. Real and recurring: the two
      // endpoints are generated separately and can disagree at the edges of a publication.
      input.onLeaf(
        leaf.citation,
        unavailable(
          WordCountStatus.UnavailableParseFailed,
          `${leaf.nodeType} ${leaf.identifier} is in the structure for title ${input.titleNumber} but absent from its XML`,
        ),
      );
      result.parseFailures += 1;
      continue;
    }

    try {
      input.onLeaf(leaf.citation, ecfr.wordcount.measureNode(node));
      result.leavesMeasured += 1;
    } catch (error) {
      input.onLeaf(
        leaf.citation,
        unavailable(
          WordCountStatus.UnavailableParseFailed,
          `measureNode failed for ${leaf.citation}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      result.parseFailures += 1;
    }
  }

  // Own text, second pass. Separate from the leaf loop because the two ask different questions
  // of the same parsed document and a container is not a leaf that failed — a container the
  // XML does not carry is ordinary (a part whose slice was not fetched) and must not be
  // counted as a parse failure or recorded as unknown.
  for (const container of input.containers) {
    if (!container.identifier) continue;

    let node: unknown;
    try {
      node = scopedFind(container.citation, {
        type: container.nodeType,
        identifier: container.identifier,
      });
    } catch (error) {
      log.debug('findNode threw for a container', {
        citation: container.citation,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (node === null || node === undefined) continue;

    try {
      const own = ecfr.wordcount.measureOwnText(node);
      if (!own.known) continue;
      input.onOwnText(container.citation, own);
      result.containersMeasured += 1;
      if (own.words > 0) result.containersWithOwnText += 1;
    } catch (error) {
      // Same reasoning as the absence case: a correction we could not take must not destroy
      // the sum it was going to correct.
      log.debug('measureOwnText failed', {
        citation: container.citation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const unit of input.units) {
    const fragments: string[] = [];
    for (const citation of unit.citations) {
      const flat = input.byCitation.get(citation);
      if (!flat?.identifier) continue;
      try {
        const node = scopedFind(citation, {
          type: flat.nodeType,
          identifier: flat.identifier,
        });
        // toHtml returns { html, meta }; the metadata (authority, source, FR citations) is
        // rendered by the page template from D1, not embedded here.
        if (node !== null && node !== undefined) fragments.push(ecfr.parser.toHtml(node).html);
      } catch (error) {
        log.warn('toHtml failed', {
          citation,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (fragments.length === 0) continue;

    const anchor = input.byCitation.get(unit.citations[0] ?? '');
    const scope = {
      title: input.titleNumber,
      ...(anchor?.chapterId ? { chapter: anchor.chapterId } : {}),
      ...((anchor?.partId ?? anchor?.identifier)
        ? { part: anchor?.partId ?? anchor?.identifier ?? undefined }
        : {}),
    };

    await input.onUnit(
      unit,
      wrapFragment({
        citation: unit.citations[0] ?? unit.partCitation,
        displayCitation: displayCitation(scope),
        sourceUrl: ecfrUrl(scope),
        sourceDate: input.sourceDate,
        bodyHtml: fragments.join('\n'),
      }),
    );
    result.unitsRendered += 1;
  }

  return result;
}
