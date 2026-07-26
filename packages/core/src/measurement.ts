/**
 * The data-fidelity core of this project.
 *
 * The predecessor codebase stored a guessed word count in the same INTEGER column as a
 * measured one, so "we don't know" and "we measured 104,642" were indistinguishable
 * downstream. Every consumer — the dashboard, the rollups, the API — then treated the guess
 * as fact.
 *
 * The fix is representational, not procedural: a count and a status travel together, and the
 * only way to produce a number is to have measured it. There is deliberately no
 * `estimate()` constructor. If you find yourself wanting one, you want `unavailable()`.
 */

import {
  assertNever,
  CountMethod,
  type KnownStatus,
  type UnknownStatus,
  WordCountStatus,
} from './enums.js';
import {
  REASON_NOT_COMPUTED,
  REASON_NOTHING_TO_ROLL_UP,
  REASON_UNRECORDED,
  reasonDescendantsUncounted,
} from './messages.js';

export type Measurement =
  | { known: true; words: number; status: KnownStatus; method: CountMethod }
  | { known: false; words: null; status: UnknownStatus; reason: string };

/**
 * The known/unknown partition as a type guard.
 *
 * A switch rather than a `KNOWN_STATUSES.includes(...)` lookup, so adding a status without
 * deciding which side it falls on is a compile error at the one place where deciding by
 * omission would quietly classify the new status as unknown.
 */
export function isKnownStatus(status: WordCountStatus): status is KnownStatus {
  switch (status) {
    case WordCountStatus.Counted:
    case WordCountStatus.RolledUp:
    case WordCountStatus.ReservedEmpty:
    case WordCountStatus.Stale:
      return true;
    case WordCountStatus.NotComputed:
    case WordCountStatus.UnavailableFetchFailed:
    case WordCountStatus.UnavailableParseFailed:
    case WordCountStatus.UnavailableTooLarge:
      return false;
    default:
      return assertNever(status, 'WordCountStatus');
  }
}

export function counted(words: number, method: CountMethod = CountMethod.XmlParse): Measurement {
  if (!Number.isInteger(words) || words < 0) {
    throw new RangeError(`word count must be a non-negative integer, got ${words}`);
  }
  return { known: true, words, status: WordCountStatus.Counted, method };
}

export function rolledUp(words: number): Measurement {
  if (!Number.isInteger(words) || words < 0) {
    throw new RangeError(`rolled-up count must be a non-negative integer, got ${words}`);
  }
  return {
    known: true,
    words,
    status: WordCountStatus.RolledUp,
    method: CountMethod.DescendantSum,
  };
}

export function reservedEmpty(): Measurement {
  return {
    known: true,
    words: 0,
    status: WordCountStatus.ReservedEmpty,
    method: CountMethod.Reserved,
  };
}

export function unavailable(status: UnknownStatus, reason: string): Measurement {
  return { known: false, words: null, status, reason };
}

export function notComputed(): Measurement {
  return unavailable(WordCountStatus.NotComputed, REASON_NOT_COMPUTED);
}

/**
 * Sum descendants into a parent.
 *
 * Returns `unavailable` unless EVERY child is known. A partial sum is silently wrong in the
 * one direction that matters — it under-reports, and an under-report looks like a plausible
 * number rather than an error. `reserved_empty` children contribute 0 and do not spoil the
 * roll-up; that is the whole reason it is a known status rather than an unknown one.
 */
export function rollUp(children: readonly Measurement[]): Measurement {
  if (children.length === 0) {
    return unavailable(WordCountStatus.NotComputed, REASON_NOTHING_TO_ROLL_UP);
  }
  const missing = children.filter((c) => !c.known).length;
  if (missing > 0) {
    return unavailable(
      WordCountStatus.NotComputed,
      reasonDescendantsUncounted(missing, children.length),
    );
  }
  let total = 0;
  for (const child of children) total += child.words as number;
  return rolledUp(total);
}

/** Shape written to `structure_node`. Mirrors the CHECK constraints exactly. */
export interface MeasurementRow {
  word_count: number | null;
  word_count_status: WordCountStatus;
  word_count_method: CountMethod | null;
  word_count_reason: string | null;
}

export function toRow(m: Measurement): MeasurementRow {
  return m.known
    ? {
        word_count: m.words,
        word_count_status: m.status,
        word_count_method: m.method,
        word_count_reason: null,
      }
    : {
        word_count: null,
        word_count_status: m.status,
        word_count_method: null,
        word_count_reason: m.reason,
      };
}

export function fromRow(row: MeasurementRow): Measurement {
  if (row.word_count === null) {
    return {
      known: false,
      words: null,
      // Assertions rather than `isKnownStatus` branches on purpose: the null-ness of
      // `word_count` is the CHECK-enforced source of truth for known/unknown, and second-
      // guessing it here would let an inconsistent row pick whichever branch lies better.
      status: row.word_count_status as UnknownStatus,
      reason: row.word_count_reason ?? REASON_UNRECORDED,
    };
  }
  return {
    known: true,
    words: row.word_count,
    status: row.word_count_status as KnownStatus,
    method: row.word_count_method ?? CountMethod.XmlParse,
  };
}

/**
 * Render for display. Never returns "0" for an unknown value — that conflation is exactly
 * what made the old dashboard untrustworthy (`formatNumber(null)` returned `"0"`).
 */
export function formatMeasurement(m: Measurement): string {
  return m.known ? m.words.toLocaleString('en-US') : '—';
}
