/**
 * Canonical identifiers for CFR nodes.
 *
 * Two distinct things live here and they must not be conflated:
 *
 *   `citation`  — the full ancestry path of a node in the structure tree. Stable, unique
 *                 (0 collisions across all 275,271 nodes), and used as the natural key in
 *                 `structure_node`. eCFR's own `generated_id` values churn between imports,
 *                 so they are stored for reference but never keyed on.
 *
 *   `refKey`    — the canonical form of an agency's CFR reference, which is a SCOPE (a
 *                 subtree) rather than a node. Two agencies pointing at the same scope
 *                 produce the same refKey; that identity is what makes shared-jurisdiction
 *                 detection possible instead of silent double counting.
 */

import type { CfrReference } from './ecfr-schemas.js';
import { HierarchyLevel } from './enums.js';

export interface Scope {
  title: number;
  subtitle?: string;
  chapter?: string;
  subchapter?: string;
  part?: string;
}

/**
 * The narrowest level a reference actually specifies.
 *
 * This is the single most important function in the data pipeline. Reading `chapter` while
 * ignoring a present `subchapter`/`part` is what produced the 12.7x over-credit in the
 * predecessor: 12 of 487 references name a chapter *and* something narrower.
 */
export function narrowestLevel(scope: Scope): HierarchyLevel {
  if (scope.part !== undefined && scope.part !== '') return HierarchyLevel.Part;
  if (scope.subchapter !== undefined && scope.subchapter !== '') return HierarchyLevel.Subchapter;
  if (scope.chapter !== undefined && scope.chapter !== '') return HierarchyLevel.Chapter;
  if (scope.subtitle !== undefined && scope.subtitle !== '') return HierarchyLevel.Subtitle;
  return HierarchyLevel.Title;
}

export function toScope(ref: CfrReference): Scope {
  return {
    title: ref.title,
    ...(ref.subtitle ? { subtitle: ref.subtitle } : {}),
    ...(ref.chapter ? { chapter: ref.chapter } : {}),
    ...(ref.subchapter ? { subchapter: ref.subchapter } : {}),
    ...(ref.part ? { part: ref.part } : {}),
  };
}

/**
 * Canonical reference key, e.g. `title-40/chapter-I/part-60`.
 *
 * Levels always appear in hierarchy order regardless of key order in the source JSON, and
 * empty strings are treated as absent, so `{chapter: 'I'}` and `{chapter: 'I', part: ''}`
 * collapse to the same key. That normalisation is what stopped
 * `foreign-service-labor-relations-board` getting two rows for the same 22 CFR XIV scope.
 */
export function refKey(scope: Scope): string {
  const parts: string[] = [`title-${scope.title}`];
  if (scope.subtitle) parts.push(`subtitle-${scope.subtitle}`);
  if (scope.chapter) parts.push(`chapter-${scope.chapter}`);
  if (scope.subchapter) parts.push(`subchapter-${scope.subchapter}`);
  if (scope.part) parts.push(`part-${scope.part}`);
  return parts.join('/');
}

export function parseRefKey(key: string): Scope {
  const scope: Partial<Scope> = {};
  for (const segment of key.split('/')) {
    const idx = segment.indexOf('-');
    if (idx === -1) continue;
    const level = segment.slice(0, idx);
    const value = segment.slice(idx + 1);
    // No default and no assertNever: `level` is untrusted input, not a HierarchyLevel, and
    // an unrecognised segment is skipped rather than fatal so old keys survive new levels.
    switch (level) {
      case HierarchyLevel.Title:
        scope.title = Number.parseInt(value, 10);
        break;
      case HierarchyLevel.Subtitle:
        scope.subtitle = value;
        break;
      case HierarchyLevel.Chapter:
        scope.chapter = value;
        break;
      case HierarchyLevel.Subchapter:
        scope.subchapter = value;
        break;
      case HierarchyLevel.Part:
        scope.part = value;
        break;
    }
  }
  if (scope.title === undefined || Number.isNaN(scope.title)) {
    throw new Error(`refKey missing a valid title: ${key}`);
  }
  return scope as Scope;
}

/** Build a node citation by appending a level to its parent's citation. */
export function childCitation(
  parentCitation: string | null,
  nodeType: string,
  identifier: string | null | undefined,
  ordinal: number,
): string {
  // Nodes without an identifier (hed1, generated subject groups) get a positional segment
  // so the path stays unique. It is stable as long as sibling order is stable, which it is
  // within a given structure snapshot.
  const segment =
    identifier && identifier !== '' ? `${nodeType}-${identifier}` : `${nodeType}-@${ordinal}`;
  return parentCitation ? `${parentCitation}/${segment}` : segment;
}

/** Human-readable citation, e.g. `40 CFR 60.1` or `40 CFR Part 60`. */
export function displayCitation(scope: Scope, section?: string): string {
  if (section) return `${scope.title} CFR ${section}`;
  if (scope.part) return `${scope.title} CFR Part ${scope.part}`;
  if (scope.subchapter) return `${scope.title} CFR Subchapter ${scope.subchapter}`;
  if (scope.chapter) return `${scope.title} CFR Chapter ${scope.chapter}`;
  if (scope.subtitle) return `${scope.title} CFR Subtitle ${scope.subtitle}`;
  return `${scope.title} CFR`;
}

/** Canonical link back to the official eCFR. Required by the attribution policy. */
export function ecfrUrl(scope: Scope, section?: string): string {
  const base = 'https://www.ecfr.gov/current';
  if (section) return `${base}/title-${scope.title}/section-${section}`;
  const parts = [`title-${scope.title}`];
  if (scope.subtitle) parts.push(`subtitle-${scope.subtitle}`);
  if (scope.chapter) parts.push(`chapter-${scope.chapter}`);
  if (scope.subchapter) parts.push(`subchapter-${scope.subchapter}`);
  if (scope.part) parts.push(`part-${scope.part}`);
  return `${base}/${parts.join('/')}`;
}

/** True when `inner` is at or below `outer` in the same title. Used for overlap detection. */
export function scopeContains(outer: Scope, inner: Scope): boolean {
  if (outer.title !== inner.title) return false;
  for (const level of [
    HierarchyLevel.Subtitle,
    HierarchyLevel.Chapter,
    HierarchyLevel.Subchapter,
    HierarchyLevel.Part,
  ] as const) {
    const o = outer[level];
    if (o === undefined || o === '') continue;
    if (inner[level] !== o) return false;
  }
  return true;
}
