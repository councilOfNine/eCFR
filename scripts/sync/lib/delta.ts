/**
 * Four-step change detection for the nightly run.
 *
 * The goal is to download the smallest amount of XML that provably covers everything that
 * changed. The full corpus is 810 MB raw / 163 MB gzipped and takes 331 s to pull serially;
 * eCFR publishes on business days only, with a median of 48 changed sections per day. Pulling
 * everything nightly would be ~200x more transfer than the change warrants, and would spend
 * the rate-limit budget that the retry path needs.
 *
 *   (a) titles.json  -> which TITLES moved            (cheap, one request)
 *   (b) versions     -> which SECTIONS moved, and why (one request per dirty title)
 *   (c) structure    -> which PARTS moved, by byte size fingerprint (one request per title)
 *   (d) full XML     -> only the parts implicated by (b) or (c)
 *
 * Steps (b) and (c) are combined by UNION, never by intersection. They can disagree — a
 * non-substantive correction moves bytes without appearing as a substantive version, and a
 * version row can name a part whose size happens to land identically. Over-fetching costs a
 * request; under-fetching silently serves stale text, so the asymmetry decides the operator.
 */

import type { ContentVersion, Title } from '@ecfr-atlas/core/ecfr-schemas';
import { VERSIONS_PAGE_SIZE } from '@ecfr-atlas/core/ecfr-schemas';

import { DirtyReason, RefetchReason } from './enums.js';
import { IMPORT_IN_PROGRESS_ABORT } from './messages.js';
import type { FlatNode } from './structure.js';

/**
 * Thrown when eCFR reports it is mid-import.
 *
 * The whole run aborts rather than degrading, because a half-written upstream corpus produces
 * a self-consistent but wrong snapshot: sizes and versions agree with each other and with
 * nothing real. There is no way to detect that after the fact, so the only safe move is not
 * to capture it.
 */
export class ImportInProgressError extends Error {
  constructor() {
    super(IMPORT_IN_PROGRESS_ABORT);
    this.name = 'ImportInProgressError';
  }
}

// ─── (a) which titles moved ──────────────────────────────────────────────────

export interface TitleWatermark {
  titleNumber: number;
  latestAmendedOn: string | null;
  latestIssueDate: string | null;
  lastSyncedAt: string | null;
}

export interface DirtyTitle {
  number: number;
  name: string;
  previousAmendedOn: string | null;
  latestAmendedOn: string;
  latestIssueDate: string | null;
  reason: DirtyReason;
}

export interface TitleDeltaPlan {
  /** eCFR's own snapshot date for this response, used as the content fetch date. */
  sourceDate: string | null;
  dirty: DirtyTitle[];
  unchanged: number[];
  /** Title 35 is reserved and all three of its date fields are null. */
  reserved: number[];
}

export interface TitlesPayload {
  titles: readonly Title[];
  meta?: { date?: string | undefined; import_in_progress?: boolean | undefined } | undefined;
}

/**
 * Compare `latest_amended_on` against the stored watermark.
 *
 * Deliberately NOT `up_to_date_as_of`: that field advances every publication day for all 49
 * titles whether or not their content changed, so keying on it would mark the entire corpus
 * dirty every night and turn the delta back into a backfill.
 */
export function planTitleDelta(
  payload: TitlesPayload,
  watermarks: readonly TitleWatermark[],
): TitleDeltaPlan {
  if (payload.meta?.import_in_progress === true) throw new ImportInProgressError();

  const stored = new Map(watermarks.map((w) => [w.titleNumber, w]));
  const plan: TitleDeltaPlan = {
    sourceDate: payload.meta?.date ?? null,
    dirty: [],
    unchanged: [],
    reserved: [],
  };

  for (const title of payload.titles) {
    // Reserved titles have no content and null dates. Comparing those nulls would either
    // throw or mark the title permanently dirty; skipping is the only correct handling.
    if (title.reserved || title.latest_amended_on === null) {
      plan.reserved.push(title.number);
      continue;
    }

    const watermark = stored.get(title.number);
    const previous = watermark?.latestAmendedOn ?? null;

    if (previous === null) {
      plan.dirty.push({
        number: title.number,
        name: title.name,
        previousAmendedOn: null,
        latestAmendedOn: title.latest_amended_on,
        latestIssueDate: title.latest_issue_date,
        reason: DirtyReason.NeverSynced,
      });
    } else if (previous !== title.latest_amended_on) {
      plan.dirty.push({
        number: title.number,
        name: title.name,
        previousAmendedOn: previous,
        latestAmendedOn: title.latest_amended_on,
        latestIssueDate: title.latest_issue_date,
        reason: DirtyReason.Amended,
      });
    } else {
      plan.unchanged.push(title.number);
    }
  }

  return plan;
}

// ─── (b) which sections moved ────────────────────────────────────────────────

export interface VersionSummary {
  /** Everything returned, for the `amendment` table. Both flags are stored as columns. */
  all: readonly ContentVersion[];
  /** Substantive rows only. These are what drive refetching. */
  substantive: readonly ContentVersion[];
  /** `removed === true` means the section is gone, not that its text changed. */
  removed: readonly ContentVersion[];
  /** Part identifiers implicated by substantive versions. */
  parts: ReadonlySet<string>;
  /**
   * True when the response is exactly one page long.
   *
   * eCFR omits `meta.total_pages` from FILTERED responses, so a truncated 1,000-row page is
   * byte-identical in shape to a complete one. Exactly-1000 therefore means "assume more" and
   * the caller must widen its handling rather than trust the list.
   */
  possiblyTruncated: boolean;
}

/**
 * `truncated` comes from the client, which knows whether the request was filtered and can
 * therefore tell "exactly 1,000 rows, unfiltered, total_pages says 1" from "exactly 1,000
 * rows, filtered, total_pages absent". When it is not supplied, fall back to the row-count
 * heuristic — right often enough to be safe, and safe in the over-fetching direction.
 */
export function summariseVersions(
  versions: readonly ContentVersion[],
  truncated?: boolean,
): VersionSummary {
  const substantive = versions.filter((v) => v.substantive);
  const removed = versions.filter((v) => v.removed);

  const parts = new Set<string>();
  for (const version of substantive) {
    if (version.part) parts.add(version.part);
  }

  return {
    all: versions,
    substantive,
    removed,
    parts,
    possiblyTruncated: truncated ?? versions.length === VERSIONS_PAGE_SIZE,
  };
}

/**
 * The `issue_date[gte]` value for a title's versions request.
 *
 * Keyed on issue_date, never amendment_date: the two differ in 49.7% of rows and 40.4% of
 * amendment_dates predate eCFR's 2017-01-01 full-text horizon, so a window built from
 * amendment dates asks for content that cannot be served.
 */
export function versionsWindowStart(watermark: TitleWatermark | undefined): string | undefined {
  return watermark?.latestIssueDate ?? undefined;
}

// ─── (c) which parts moved ───────────────────────────────────────────────────

export interface StructureDiff {
  /** Parts whose stored byte size differs from the freshly fetched structure. */
  changed: FlatNode[];
  /** Parts with no stored row at all. */
  added: FlatNode[];
  /** Citations present in D1 but absent from the new structure. Pruned, not refetched. */
  removedCitations: string[];
  /** Parts whose size matched exactly. Counted so the log can show the saving. */
  unchanged: number;
  /** Parts eCFR gave no `size` for. Treated as changed; we cannot prove otherwise. */
  sizeUnknown: number;
}

/**
 * Compare each part's additive byte size against what was stored last run.
 *
 * eCFR puts a `size` on every structure node and it is additive over the subtree, so a part
 * whose size is byte-identical cannot have changed. This is the entire reason the nightly
 * delta is cheap: the structure JSON is 2.4-2.7 MB per title and tells us which of a title's
 * parts to skip without downloading any of its 810 MB of XML.
 *
 * Size is a change DETECTOR, not a measurement. It correlates with word count at r=0.99936,
 * which is more than good enough to decide "refetch or not" and nowhere near good enough to
 * publish. Nothing in this function produces a number that reaches a user.
 */
export function diffStructureSizes(
  freshNodes: readonly FlatNode[],
  storedSizes: ReadonlyMap<string, number | null>,
): StructureDiff {
  const diff: StructureDiff = {
    changed: [],
    added: [],
    removedCitations: [],
    unchanged: 0,
    sizeUnknown: 0,
  };

  const freshCitations = new Set<string>();
  for (const node of freshNodes) freshCitations.add(node.citation);

  for (const node of freshNodes) {
    if (node.nodeType !== 'part') continue;

    if (!storedSizes.has(node.citation)) {
      diff.added.push(node);
      continue;
    }

    const stored = storedSizes.get(node.citation) ?? null;
    if (node.xmlBytes === null || stored === null) {
      diff.sizeUnknown += 1;
      diff.changed.push(node);
      continue;
    }

    if (node.xmlBytes === stored) diff.unchanged += 1;
    else diff.changed.push(node);
  }

  for (const citation of storedSizes.keys()) {
    if (!freshCitations.has(citation)) diff.removedCitations.push(citation);
  }

  return diff;
}

// ─── (d) what to refetch ─────────────────────────────────────────────────────

export interface RefetchTarget {
  titleNumber: number;
  /** Part identifier for `?part=`. Only `?part=` and `?section=` actually slice a title. */
  part: string;
  citation: string;
  reason: RefetchReason;
}

/**
 * Union of the size diff and the version list.
 *
 * A part named by a substantive version but not flagged by the size diff still gets fetched.
 * That is not redundancy: the size fingerprint is additive over a subtree, so a change that
 * adds exactly as many bytes as it removes is invisible to it. Costing one extra request per
 * such part is the price of never serving text we know upstream touched.
 *
 * When the versions response may be truncated, every part in the title is refetched. A
 * truncated list is not a smaller list — it is an unknown one, and the delta's whole guarantee
 * rests on the union being complete.
 */
export function planRefetch(
  titleNumber: number,
  diff: StructureDiff,
  versions: VersionSummary,
  allParts: readonly FlatNode[],
): RefetchTarget[] {
  const targets = new Map<string, RefetchTarget>();

  const add = (node: FlatNode, reason: RefetchReason): void => {
    if (!node.identifier) return; // a part with no identifier cannot be sliced with ?part=
    if (targets.has(node.citation)) return;
    targets.set(node.citation, {
      titleNumber,
      part: node.identifier,
      citation: node.citation,
      reason,
    });
  };

  if (versions.possiblyTruncated) {
    for (const part of allParts) add(part, RefetchReason.VersionsTruncated);
    return [...targets.values()];
  }

  for (const node of diff.added) add(node, RefetchReason.NewPart);
  for (const node of diff.changed) add(node, RefetchReason.SizeChanged);

  if (versions.parts.size > 0) {
    const byIdentifier = new Map<string, FlatNode>();
    for (const part of allParts) {
      if (part.identifier) byIdentifier.set(part.identifier, part);
    }
    for (const identifier of versions.parts) {
      const node = byIdentifier.get(identifier);
      if (node) add(node, RefetchReason.VersionNamed);
    }
  }

  return [...targets.values()];
}
