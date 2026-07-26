/**
 * Closed string unions the sync pipeline dispatches on, written as const objects.
 *
 * Not TypeScript `enum`s, and not by preference: the pipeline runs from source under Node's
 * strip-only type stripping, which erases types without transforming code, so `enum` is a
 * runtime error. `erasableSyntaxOnly` in tsconfig.json turns that 3am failure into a
 * typecheck failure; the const-object + union pattern below is the erasable equivalent — a
 * value namespace to write `RunKind.Backfill` against, and a union type the compiler can
 * prove a `switch` exhausts. Same pattern, same key casing, as packages/core/src/enums.ts.
 *
 * THE LITERAL VALUES ARE FROZEN. `RunKind` and `RunStatus` are CHECK constraints on
 * `sync_run` (packages/db/migrations/0001_init.sql), and every value here is embedded in
 * generated SQL and in rows already sitting in D1. Renaming a KEY is a refactor; changing a
 * VALUE is a migration plus a data rewrite, and the CHECK will reject the write until both
 * have happened.
 *
 * Only sync-local vocabularies live here. Word-count statuses, count methods, hierarchy
 * levels and structure node types are the measurement contract itself and belong to
 * `@ecfr-atlas/core` (enums.ts there); consume core's, including its `assertNever`.
 */

// One definition of "impossible" per program: core owns it, the pipeline re-exports it so
// lib modules do not each reach across the package boundary for a one-liner.
export { assertNever } from '@ecfr-atlas/core';

/** What a sync run set out to do. `sync_run.kind`. */
export const RunKind = {
  Backfill: 'backfill',
  Delta: 'delta',
  Recount: 'recount',
} as const;
export type RunKind = (typeof RunKind)[keyof typeof RunKind];

/** How a sync run ended — or that it has not. `sync_run.status`. */
export const RunStatus = {
  Running: 'running',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Aborted: 'aborted',
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

/**
 * Per-title outcome within a run. In-memory only (it feeds the publish gate), so the values
 * are not database-frozen — but `Partial` is load-bearing: it is the one state the gate's
 * aggregate checks cannot see, and the reason `TitleOutcome` exists at all.
 */
export const TitleStatus = {
  Complete: 'complete',
  Skipped: 'skipped',
  Partial: 'partial',
  Failed: 'failed',
} as const;
export type TitleStatus = (typeof TitleStatus)[keyof typeof TitleStatus];

/** Why the nightly delta considers a title dirty. Logged, never stored. */
export const DirtyReason = {
  NeverSynced: 'never_synced',
  Amended: 'amended',
} as const;
export type DirtyReason = (typeof DirtyReason)[keyof typeof DirtyReason];

/**
 * Why a part is being refetched. The union of two detectors that are allowed to disagree —
 * see planRefetch in delta.ts for why disagreement means "fetch", never "skip".
 */
export const RefetchReason = {
  SizeChanged: 'size_changed',
  NewPart: 'new_part',
  VersionNamed: 'version_named',
  VersionsTruncated: 'versions_truncated',
} as const;
export type RefetchReason = (typeof RefetchReason)[keyof typeof RefetchReason];

/**
 * The publish gate's checks, by id. An id appears in every verdict line and in incident
 * notes, so these are operator vocabulary: change one and every runbook grep goes stale.
 */
export const GateCheckId = {
  TotalWordsComputable: 'total_words_computable',
  TotalWordsDrift: 'total_words_drift',
  AgencyCountDrop: 'agency_count_drop',
  TitleCountDrop: 'title_count_drop',
  UncountedGrowth: 'uncounted_growth',
  PartialTitles: 'partial_titles',
} as const;
export type GateCheckId = (typeof GateCheckId)[keyof typeof GateCheckId];
