/**
 * Presentation helpers.
 *
 * Every function that could return a number instead returns null when the input is not known.
 * There is no `formatNumber(value ?? 0)` anywhere in this app — the predecessor's
 * `formatNumber(null) === "0"` is the single line that made its dashboard untrustworthy, and
 * the shape of these signatures is what stops it being rewritten by accident.
 */

import {
  formatMeasurement,
  fromRow,
  type Measurement,
  UNKNOWN_STATUSES,
  type UnknownStatus,
  WORD_COUNT_STATUSES,
  type WordCountStatus,
} from '@ecfr-atlas/core';
import type { WordCount } from '@ecfr-atlas/core/api-schemas';
import { STRINGS } from '../constants/strings';

/**
 * Wire envelope → core's discriminated union.
 *
 * Deliberately routed through core's `fromRow` rather than reimplemented, so the known/unknown
 * decision is made in exactly one place in the codebase.
 */
export function toMeasurement(wc: WordCount): Measurement {
  return fromRow({
    word_count: wc.words,
    word_count_status: wc.status,
    word_count_method: wc.method,
    word_count_reason: wc.reason,
  });
}

export function isKnown(wc: WordCount): boolean {
  return toMeasurement(wc).known;
}

/** Formatted count, or an em dash. Never "0" for an unknown. */
export function formatWords(wc: WordCount): string {
  return formatMeasurement(toMeasurement(wc));
}

const INT = new Intl.NumberFormat('en-US');

export function formatInt(n: number): string {
  return INT.format(n);
}

/**
 * Compact form for chart labels and tight table cells, e.g. "105.1M". Full precision is always
 * available in the cell's `title` and in the copyable export, so nothing is lost.
 */
export function formatCompact(wc: WordCount): string {
  const m = toMeasurement(wc);
  if (!m.known) return STRINGS.common.missingValue;
  const n = m.words;
  if (n < 1_000) return INT.format(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/** Percentage of a whole — null unless BOTH sides are known and the whole is non-zero. */
export function shareOf(part: WordCount, whole: WordCount): number | null {
  const p = toMeasurement(part);
  const w = toMeasurement(whole);
  if (!p.known || !w.known || w.words === 0) return null;
  return p.words / w.words;
}

export function formatPct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/**
 * Human-readable cause for an unknown, used as the tooltip and the screen-reader text on every
 * em dash. Returns null when the value is known.
 */
export function unknownReason(wc: WordCount): string | null {
  const m = toMeasurement(wc);
  if (m.known) return null;
  return `${statusLabel(m.status)}: ${m.reason}`;
}

/**
 * Contract fields like `DataQualityGroup.status` are `z.string()` on the wire, so the guards
 * below are where an arbitrary string earns the union type. Copy lives in STRINGS (typed
 * `Record<WordCountStatus, string>` there, so a status without copy cannot compile); an
 * unrecognised status falls back to its raw spelling rather than throwing, because a newer
 * snapshot must degrade to ugly, not to down.
 */
const isWordCountStatus = (status: string): status is WordCountStatus =>
  (WORD_COUNT_STATUSES as readonly string[]).includes(status);

const isUnknownStatus = (status: string): status is UnknownStatus =>
  (UNKNOWN_STATUSES as readonly string[]).includes(status);

export function statusLabel(status: string): string {
  return isWordCountStatus(status) ? STRINGS.status.labels[status] : status;
}

/** Longer copy for /data-quality, where each status gets its own explained section. */
export function statusExplanation(status: string): string | null {
  return isUnknownStatus(status) ? STRINGS.status.explanations[status] : null;
}

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

/**
 * eCFR dates are bare `YYYY-MM-DD`. Parsed as UTC explicitly: `new Date('2026-03-12')` is UTC
 * midnight, which formats as the previous day in any negative-offset timezone, and this project
 * is read mostly from US timezones.
 */
export function formatDate(iso: string | null): string {
  if (!iso) return STRINGS.common.missingValue;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return DATE_FMT.format(parsed);
}

const MONTH_FMT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

export function formatMonth(month: string): string {
  const parsed = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return month;
  return MONTH_FMT.format(parsed);
}

/** `title-40/chapter-I/part-60` → `title-40 / chapter-I / part-60` for readable breadcrumbs. */
export function prettyCitation(citation: string): string {
  return citation.split('/').join(' / ');
}
