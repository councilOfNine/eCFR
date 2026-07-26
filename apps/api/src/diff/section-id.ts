/**
 * Strict validation of the values that reach the eCFR URL and the diff cache key.
 *
 * THE BUG THIS REPLACES: the predecessor's /diff took `?sections=` from the query string,
 * escaped `.` in it, and interpolated the result into `new RegExp(...)`. That is an
 * unauthenticated ReDoS — 2,462 ms of CPU on a 1,600-character input — and it is also a cache
 * poisoning primitive, because whatever the caller sent became part of a key.
 *
 * The replacement is not a better escape. It is an allowlist: a section identifier either
 * matches one fixed, anchored, length-bounded pattern or the request is a 400. Nothing that
 * reaches R2 or ecfr.gov from this module was chosen by the caller beyond passing that test.
 */

import { ECFR_FULLTEXT_HORIZON } from '../constants/config.js';
import {
  beforeHorizonMessage,
  issueDateShapeMessage,
  notACalendarDateMessage,
  SECTION_FORMAT_MESSAGE,
  sectionLengthMessage,
  TITLE_RANGE_MESSAGE,
} from '../constants/messages.js';
import { badRequest } from '../errors.js';

/**
 * CFR section identifiers, exhaustively:
 *
 *   60.1            part.section
 *   1.72-9          Treasury's hyphenated series
 *   1.401(a)(4)-1   Treasury's parenthesised series — these are real section numbers, not
 *                   paragraph references, which is why parentheses have to be allowed
 *   1926.1101       four-digit parts (OSHA)
 *   17.95           the largest single section in the corpus, 5,010,215 B
 *
 * Every quantifier is bounded and every repeated group begins with a literal that cannot be
 * produced by the group before it — `(` after a character class that excludes `(`, `-` after
 * one that excludes `-`. There is no ambiguity for a backtracking engine to explore, so
 * matching is linear in the input, and the input is capped at 48 characters anyway.
 */
const SECTION_ID_RE =
  /^\d{1,4}[a-z]?\.[0-9a-z]{1,10}(?:\([0-9a-z]{1,4}\)){0,6}(?:-[0-9a-z]{1,10}){0,4}$/i;

export const SECTION_ID_PATTERN = SECTION_ID_RE.source;
const SECTION_ID_MAX = 48;

export function assertSectionId(raw: string): string {
  const value = raw.trim();
  if (value.length === 0 || value.length > SECTION_ID_MAX) {
    throw badRequest(sectionLengthMessage(SECTION_ID_MAX), { section: '[rejected]' });
  }
  if (!SECTION_ID_RE.test(value)) {
    // The rejected value is echoed back only after it has been length-bounded and is going
    // into a JSON string, never into a header or a URL.
    throw badRequest(SECTION_FORMAT_MESSAGE, { section: value, pattern: SECTION_ID_PATTERN });
  }
  return value;
}

export function assertTitleNumber(raw: number): number {
  if (!Number.isInteger(raw) || raw < 1 || raw > 50) {
    throw badRequest(TITLE_RANGE_MESSAGE, { title: raw });
  }
  return raw;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Issue dates only.
 *
 * The parameter is named `issue_date` throughout and validated here against eCFR's full-text
 * horizon because the alternative failure is silent and wrong: amendment_date differs from
 * issue_date in 49.7% of rows and 40.4% of amendment_dates predate 2017-01-01, so a caller
 * who passes an amendment_date gets an empty old side, and an empty old side rendered as
 * "section added" is a lie about a section that has existed for decades.
 */
export function assertIssueDate(raw: string, field: string): string {
  const value = raw.trim();
  if (!DATE_RE.test(value)) {
    throw badRequest(issueDateShapeMessage(field), { [field]: value.slice(0, 32) });
  }
  // Rejects 2024-13-45 and 2023-02-30, which match the shape but are not dates.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw badRequest(notACalendarDateMessage(field), { [field]: value });
  }
  if (value < ECFR_FULLTEXT_HORIZON) {
    throw badRequest(beforeHorizonMessage(field, ECFR_FULLTEXT_HORIZON), {
      [field]: value,
      horizon: ECFR_FULLTEXT_HORIZON,
    });
  }
  return value;
}

/**
 * The R2 memo key.
 *
 * Every component has already passed an allowlist, so the key cannot contain a traversal
 * segment, a wildcard, or a newline. Keyed on issue_date rather than amendment_date, for the
 * reason above. Versioned by prefix so a change to the extraction or hunking logic can
 * invalidate every memo by bumping one constant instead of enumerating a bucket.
 */
export function diffCacheKey(
  prefix: string,
  title: number,
  section: string,
  from: string,
  to: string,
): string {
  // `(` and `)` are legal in R2 keys but awkward in shell and log contexts; the substitution
  // is injective over the allowlisted alphabet, so distinct sections keep distinct keys.
  const safeSection = section.replaceAll('(', '_').replaceAll(')', '_');
  return `${prefix}/title-${title}/section-${safeSection}/${from}..${to}.json`;
}
