/**
 * Turning eCFR's nested structure JSON into flat, citable rows — and rolling measurements
 * back up the tree.
 *
 * Two facts about this data shape the whole module:
 *
 *   - Levels are NOT sequential. Title 7 jumps DIV2 -> DIV5 thirty-five times. Anything that
 *     assumes "a chapter's parent is a subtitle" or "a part's children are subparts" is wrong
 *     on real data, so the walk carries an explicit ancestry record instead of inferring one
 *     from depth.
 *
 *   - 151 nodes corpus-wide have a null identifier (hed1 nodes and generated subject groups).
 *     `childCitation` gives those a positional segment so the citation stays unique; that is
 *     why the walk tracks a sibling ordinal.
 *
 * Roll-up is deliberately the ONLY way a non-leaf gets a number. Sections and appendices are
 * measured from their own XML; everything above them is `rollUp()` of its children, which
 * returns `unavailable` unless every child is known. A partial sum under-reports, and an
 * under-report is indistinguishable from a real number — that is the bug this project exists
 * to make impossible.
 */

import type { Measurement } from '@ecfr-atlas/core';
import {
  childCitation,
  reservedEmpty,
  rollUp,
  unavailable,
  WordCountStatus,
} from '@ecfr-atlas/core';
import type { StructureNode } from '@ecfr-atlas/core/ecfr-schemas';

/** Node types that carry their own regulatory text and are therefore measured directly. */
export const LEAF_TYPES: ReadonlySet<string> = new Set(['section', 'appendix']);

/** Ancestry levels denormalised onto every row so the table-of-contents query is a range scan. */
interface Ancestry {
  subtitleId: string | null;
  chapterId: string | null;
  subchapterId: string | null;
  partId: string | null;
}

export interface FlatNode extends Ancestry {
  citation: string;
  parentCitation: string | null;
  titleNumber: number;
  nodeType: string;
  identifier: string | null;
  label: string;
  reserved: boolean;
  /** eCFR's additive byte size for this subtree. The free change fingerprint. */
  xmlBytes: number | null;
  /** Depth from the title root; 0 is the title itself. */
  depth: number;
  childCitations: string[];
}

/**
 * Depth-first pre-order flatten.
 *
 * Pre-order matters downstream: `rollUpTree` walks the result in reverse, which guarantees
 * every child is resolved before its parent without building a separate topological sort.
 */
export function flattenStructure(root: StructureNode, titleNumber: number): FlatNode[] {
  const out: FlatNode[] = [];

  const visit = (
    node: StructureNode,
    parentCitation: string | null,
    ancestry: Ancestry,
    ordinal: number,
    depth: number,
  ): string => {
    const identifier = node.identifier ?? null;
    const citation = childCitation(parentCitation, node.type, identifier, ordinal);

    // A node contributes its own identifier to its descendants' ancestry, never to its own
    // row's ancestry columns — `part_id` on a part row would just restate `identifier`.
    const childAncestry: Ancestry = { ...ancestry };
    switch (node.type) {
      case 'subtitle':
        childAncestry.subtitleId = identifier;
        break;
      case 'chapter':
        childAncestry.chapterId = identifier;
        break;
      case 'subchapter':
        childAncestry.subchapterId = identifier;
        break;
      case 'part':
        childAncestry.partId = identifier;
        break;
      default:
        break;
    }

    const flat: FlatNode = {
      citation,
      parentCitation,
      titleNumber,
      nodeType: node.type,
      identifier,
      label: node.label,
      reserved: node.reserved === true,
      subtitleId: ancestry.subtitleId,
      chapterId: ancestry.chapterId,
      subchapterId: ancestry.subchapterId,
      partId: ancestry.partId,
      xmlBytes: node.size ?? null,
      depth,
      childCitations: [],
    };
    out.push(flat);

    const children = node.children ?? [];
    for (const [index, child] of children.entries()) {
      flat.childCitations.push(visit(child, citation, childAncestry, index, depth + 1));
    }
    return citation;
  };

  visit(root, null, { subtitleId: null, chapterId: null, subchapterId: null, partId: null }, 0, 0);
  return out;
}

/**
 * Resolve a Measurement for every node.
 *
 * `leafMeasurements` holds what was actually parsed out of XML for the countable leaves.
 * `ownText` holds, for containers the XML pass reached, the text that container owns DIRECTLY
 * — everything outside its nested structure children. Everything else is derived, in this
 * precedence:
 *
 *   1. a direct leaf measurement, if one was taken;
 *   2. `rollUp()` of children PLUS the node's own text, if the node has children;
 *   3. the node's own text, for a childless container the XML pass did reach;
 *   4. `reservedEmpty()` for a childless reserved node — genuinely zero, not unknown;
 *   5. otherwise unknown, with a reason naming the citation.
 *
 * WHY OWN TEXT IS AN ADDEND AND NOT AN AFTERTHOUGHT
 *
 * The composition `@ecfr-atlas/ecfr` guarantees is
 *
 *     measureNode(parent) === measureOwnText(parent) + Σ measureNode(child)
 *
 * so a parent is NOT the sum of its structure children. On today's corpus the residue is
 * usually nil — 12 CFR 1026's 59 sections and 18 appendices sum to the whole-part count with
 * 0.00% lost — but it is not always: 29 CFR 1910 carries 146 words directly under the part,
 * 21 CFR 201 carries 15, 26 CFR 20 carries 5. Rolling a container up from leaves alone
 * therefore happens to be right rather than being right by construction, and "happens to be
 * right" is not a property this project is allowed to depend on. Including own text as one
 * more child of the roll-up makes the identity structural: it now holds because of how the
 * sum is formed, not because of what the current corpus contains.
 *
 * Case 3 is the part with no sections. It used to fall through to case 5 and publish
 * `not_computed` with "no descendants to roll up" — safe, but a mass of spurious unknowns for
 * parts whose text simply sits directly under them. Such a part is measured, not guessed: its
 * own text IS its whole subtree, because it has no structure children to exclude.
 *
 * Case 5 exists because eCFR occasionally lists a leaf type the XML pass did not reach (a
 * section inside a part whose fetch 504'd). Returning `not_computed` there is what propagates
 * the gap all the way up to the agency total instead of quietly shrinking it.
 *
 * An `ownText` entry that is itself unknown propagates, exactly like an unknown leaf. The
 * pipeline therefore records an entry only when the container was found and measured; a
 * container absent from the XML records nothing and the roll-up degrades to its children,
 * which is the same answer this function gave before own text existed.
 */
export function rollUpTree(
  nodes: readonly FlatNode[],
  leafMeasurements: ReadonlyMap<string, Measurement>,
  ownText: ReadonlyMap<string, Measurement> = new Map(),
): Map<string, Measurement> {
  const resolved = new Map<string, Measurement>();

  // Reverse pre-order == children before parents.
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (!node) continue;

    const direct = leafMeasurements.get(node.citation);
    if (direct) {
      resolved.set(node.citation, direct);
      continue;
    }

    const own = ownText.get(node.citation);

    if (node.childCitations.length > 0) {
      const children = node.childCitations.map(
        (citation) =>
          resolved.get(citation) ??
          unavailable(
            WordCountStatus.NotComputed,
            `child ${citation} was not resolved before its parent`,
          ),
      );
      resolved.set(node.citation, rollUp(own ? [...children, own] : children));
      continue;
    }

    if (own) {
      resolved.set(node.citation, own);
      continue;
    }

    if (node.reserved) {
      resolved.set(node.citation, reservedEmpty());
      continue;
    }

    resolved.set(
      node.citation,
      unavailable(WordCountStatus.NotComputed, `no XML was measured for leaf ${node.citation}`),
    );
  }

  return resolved;
}

/**
 * Containers whose own text the XML pass measures: a part, and anything inside one.
 *
 * Bounded at the part on purpose, and the bound is what keeps a backfill and a delta
 * arithmetically identical. A backfill holds the whole title's XML and could measure a
 * chapter's own text; a delta holds only `?part=` slices and could not. Measuring where only
 * one of the two paths can look would put a step change in the time series every time someone
 * re-ran a full pull — the exact failure the pipeline's fixed stage order exists to prevent.
 *
 * Nothing is lost by the bound. Every residue upstream measured sits AT the part (29 CFR 1910:
 * 146 words, 21 CFR 201: 15, 26 CFR 20: 5); above the part the CFR carries only HEAD, AUTH and
 * SOURCE, all of which are excluded from the count by design. `?part=` returns the part
 * element itself, so both paths see every node this selects.
 */
export function containersOf(nodes: readonly FlatNode[]): FlatNode[] {
  return nodes.filter(
    (n) => !LEAF_TYPES.has(n.nodeType) && (n.nodeType === 'part' || n.partId !== null),
  );
}

/** Every part in a title, in document order. The unit of both refetch and rendering. */
export function partsOf(nodes: readonly FlatNode[]): FlatNode[] {
  return nodes.filter((n) => n.nodeType === 'part');
}

/** Leaves the XML pass must measure directly. */
export function leavesOf(nodes: readonly FlatNode[]): FlatNode[] {
  return nodes.filter((n) => LEAF_TYPES.has(n.nodeType));
}

/**
 * Index nodes by citation. Used by the scope resolver and by the delta's size comparison,
 * both of which are lookup-heavy over 275k rows.
 */
export function indexByCitation(nodes: readonly FlatNode[]): Map<string, FlatNode> {
  return new Map(nodes.map((n) => [n.citation, n]));
}
