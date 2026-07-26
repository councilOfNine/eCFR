/**
 * Stored row -> published JSON. The single choke point for word counts.
 *
 * There is exactly one function in this file that can produce a `words` number on the wire,
 * and it takes a `Measurement`, which can only be produced by `@ecfr-atlas/core`'s
 * constructors, which have no `estimate()`. That chain is the structural reason this codebase
 * cannot repeat `chapterText = fullText.substring(0, estimatedWords * 6)`.
 *
 * NOTE FOR packages/core: `toWordCount`, `rollupMeasurement` and `unresolvedScopeMeasurement`
 * arguably belong next to the `WordCount` schema in core/src/api-schemas.ts, so the Astro
 * build applies the identical interpretation of a NULL rollup. They live here only because
 * core's `exports` map is fixed and api-schemas.ts is owned by another module. Moving them is
 * a pure lift-and-shift.
 */

import { fromRow, type Measurement, type MeasurementRow, unavailable } from '@ecfr-atlas/core';
import type { WordCount } from '@ecfr-atlas/core/api-schemas';
import {
  claimantMismatchReason,
  NO_CLAIMED_SCOPES_REASON,
  SHARE_OF_UNKNOWN_REASON,
  subtreeUnknownReason,
  uncountedScopesReason,
  unresolvedScopeReason,
} from './constants/messages.js';
// Constructors and types come from core; the closed vocabularies come from ./enums.js, which
// re-exports them. Same objects either way — the split is so that "which vocabularies does
// this API dispatch on" has one answer to grep for. db/search.ts, db/titles.ts, routes/meta.ts
// and routes/search.ts all carry the same pair of imports.
import { CountMethod, WordCountStatus } from './enums.js';

/**
 * The only way a number reaches a response body.
 *
 * All four keys are always present. A consumer cannot receive `{words: 5}` on one row and
 * `{}` on the next and have to guess; and `words: null` always arrives with the `reason` that
 * explains it.
 */
export function toWordCount(m: Measurement): WordCount {
  return m.known
    ? { words: m.words, status: m.status, reason: null, method: m.method }
    : { words: null, status: m.status, reason: m.reason, method: null };
}

/** Convenience for the common case of a `structure_node` row read straight out of D1. */
export function nodeWordCount(row: MeasurementRow): WordCount {
  return toWordCount(fromRow(row));
}

/** A known rollup. Extracted because three functions below need the identical envelope. */
function knownRollup(words: number): WordCount {
  // A rollup is a sum over descendants by construction; it is never a direct parse.
  return {
    words,
    status: WordCountStatus.RolledUp,
    reason: null,
    method: CountMethod.DescendantSum,
  };
}

/**
 * `agency_rollup` and `scope_overlap` store a bare nullable INTEGER. They have no status
 * column because a rollup's status is derivable from the coverage counters stored beside it —
 * but only if every caller derives it the same way, so no caller derives it. This does.
 *
 * NULL is never 0. `formatNumber(null) === "0"` is the predecessor bug this project exists to
 * not repeat, and the fix has to hold at the serialisation boundary too, not just in the DB.
 *
 * `refsCounted`/`refsTotal` are THIS AGENCY'S OWN reference counters, so this function is only
 * correct for `attributed_word_count` and `deduplicated_word_count`. The two subtree columns
 * are unknown for a different reason and go through `subtreeRollupWordCount` below.
 */
export function rollupWordCount(
  words: number | null,
  refsCounted: number,
  refsTotal: number,
): WordCount {
  if (words !== null) return knownRollup(words);

  const uncounted = Math.max(refsTotal - refsCounted, 0);
  return toWordCount(
    unavailable(
      WordCountStatus.NotComputed,
      refsTotal === 0 ? NO_CLAIMED_SCOPES_REASON : uncountedScopesReason(uncounted, refsTotal),
    ),
  );
}

/**
 * The same envelope for `subtree_attributed` / `subtree_deduplicated`, with a reason that is
 * actually about the subtree.
 *
 * These two columns are computed by the sync pipeline over the UNION of distinct scopes across
 * the whole subtree — this agency plus every descendant — and `rollUp()` returns unavailable
 * unless every input is known. So a NULL subtree total means "somebody in this subtree has an
 * unmeasured scope", and that somebody is very often not this agency.
 *
 * Passing the agency's own `refs_counted`/`refs_total` to `rollupWordCount` produced a reason
 * that read "0 of 3 claimed scopes have no measured word count" on a row whose own three
 * scopes were all counted perfectly. A reason that names the wrong cause is worse than no
 * reason: it sends a reader to audit an agency that is fine.
 *
 * There are no subtree-level coverage counters stored to be precise with, and inventing one by
 * dividing or estimating is exactly what this codebase does not do. So the reason says what is
 * actually known — the scope of the sum, and that something inside it is unmeasured — and
 * points at the descendants, which is where a reader should look.
 */
export function subtreeRollupWordCount(
  words: number | null,
  counters: { childrenCount: number; refsCounted: number; refsTotal: number },
): WordCount {
  if (words !== null) return knownRollup(words);

  // A childless agency's subtree IS the agency, so its own counters are the whole story and
  // the plain derivation is exact.
  if (counters.childrenCount <= 0) {
    return rollupWordCount(null, counters.refsCounted, counters.refsTotal);
  }

  return toWordCount(unavailable(WordCountStatus.NotComputed, subtreeUnknownReason(counters)));
}

/**
 * An `agency_cfr_reference` row with a NULL `node_citation` points at a scope that is not in
 * the current structure tree — eCFR keeps references to scopes that have since been removed.
 * "We cannot measure this" is the truthful answer; 0 and silent omission both are not.
 */
export function unresolvedScopeWordCount(refKey: string): WordCount {
  return toWordCount(unavailable(WordCountStatus.NotComputed, unresolvedScopeReason(refKey)));
}

/**
 * Split a scope's word count among its claimants — the SAME rule the stored totals used.
 *
 * THE RULE, as published on /methodology and implemented by `evenShares` in
 * scripts/sync/lib/rollup.ts:
 *
 *   A scope claimed by k agencies contributes floor(w / k) words to each claimant. The
 *   remainder r = w mod k is distributed one word each to the first r claimants in canonical
 *   order (sortable_name, then slug as a tiebreak). The shares therefore sum to exactly w,
 *   with no rounding drift, and the order is deterministic across runs.
 *
 * This used to be `words / agencyCount` — a bare float, published without a status. Two things
 * were wrong with it. It was a different arithmetic from the one that actually produced
 * `agency_rollup.deduplicated_word_count`, so a reader who summed the published shares got a
 * number that did not reconcile with the published totals; and it was a measurement-derived
 * quantity with no `status`, which is the exact shape this API exists to make unrepresentable.
 *
 * `scope_overlap.agency_slugs` is written in that same canonical order, so element i of the
 * returned array belongs to claimant i. test/wire.test.ts asserts this implementation agrees
 * with the pipeline's, value for value.
 */
export function evenShares(words: number, claimantCount: number): number[] {
  if (claimantCount <= 0) return [];
  const base = Math.floor(words / claimantCount);
  const remainder = words % claimantCount;
  return Array.from({ length: claimantCount }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * Each claimant's share of a shared scope, as a measurement per claimant.
 *
 * Every element carries a status, because a share is arithmetic over a measured value and
 * therefore `rolled_up` — the same constructor the pipeline uses for the intermediate that
 * lands in `deduplicated_word_count`. It is never a fresh observation and must not be mistaken
 * for one.
 *
 * Two ways this returns unknowns rather than numbers:
 *
 *   - the scope's own count is NULL. A share of an unknown is an unknown, not a zero.
 *   - `agency_slugs` and `agency_count` disagree. The split depends on the claimant ORDER, so
 *     if the stored order cannot be trusted neither can the mapping from share to agency, and
 *     publishing a confidently-attributed wrong number is the failure mode this whole file
 *     exists to prevent.
 */
export function scopeShares(
  words: number | null,
  claimantSlugs: readonly string[],
  agencyCount: number,
): WordCount[] {
  if (claimantSlugs.length === 0) return [];

  if (claimantSlugs.length !== agencyCount) {
    return claimantSlugs.map(() =>
      toWordCount(
        unavailable(
          WordCountStatus.NotComputed,
          claimantMismatchReason(agencyCount, claimantSlugs.length),
        ),
      ),
    );
  }

  if (words === null) {
    return claimantSlugs.map(() =>
      toWordCount(unavailable(WordCountStatus.NotComputed, SHARE_OF_UNKNOWN_REASON)),
    );
  }

  return evenShares(words, claimantSlugs.length).map((share) => knownRollup(share));
}

/** SQLite has no boolean. Every 0/1 column crosses the wire through here. */
export function asBool(value: number | null | undefined): boolean {
  return value === 1;
}
