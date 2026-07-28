/**
 * Every operator- and consumer-facing string the API emits, in one place.
 *
 * Two reasons this module exists, and neither is tidiness:
 *
 *   1. Several of these strings are LOAD-BEARING. Tests assert on them, the public docs quote
 *      them, and the measurement reasons are part of the honesty contract — a reason that
 *      names the wrong cause sends a reader to audit an agency that is fine. A string that
 *      can only be produced here can be reviewed here.
 *   2. Parameterised messages are template FUNCTIONS, not call-site concatenation, so the
 *      same message cannot drift into three slightly different spellings as call sites are
 *      added. The wording below is frozen verbatim from the call sites it replaced.
 *
 * Layout mirrors the modules that consume it. Fixed strings are UPPER_SNAKE consts; anything
 * with a parameter is a function.
 */

import { ApiTier, assertNever } from '../enums.js';
import { OPENAPI_SPEC_PATH } from './config.js';

// ─── error envelope (src/errors.ts) ──────────────────────────────────────────

/** Deliberately does not echo `err.message`: an unexpected throw can carry a query fragment. */
export const INTERNAL_ERROR_MESSAGE =
  'The API failed to handle this request. Quote the request id if you report it.';

export const routeNotFoundMessage = (method: string, pathname: string): string =>
  `No route matches ${method} ${pathname}. See the OpenAPI spec at ${OPENAPI_SPEC_PATH}.`;

/** Request-validation failure. With exactly one issue the offending path is named inline. */
export const validationFailedMessage = (
  target: string,
  issue: { path: string; message: string } | null,
): string =>
  issue === null
    ? `Invalid ${target}.`
    : `Invalid ${target}: ${issue.path || '(root)'} — ${issue.message}`;

// ─── metering (src/auth/quota.ts) ────────────────────────────────────────────

export const burstLimitedMessage = (tier: ApiTier, burstPerMinute: number): string =>
  `Too many requests in a short window. The ${tier} tier allows ${burstPerMinute} requests per minute.`;

export const quotaExhaustedMessage = (tier: ApiTier, dailyQuota: number): string =>
  `Daily quota exhausted for the ${tier} tier (${dailyQuota} requests per UTC day).`;

/** `how_to_raise` on every 429: what the caller can actually do about it. */
export function upgradeAdvice(tier: ApiTier): string {
  switch (tier) {
    case ApiTier.Anonymous:
      return 'POST /v1/account/register with your email to get a free key with a much higher limit.';
    case ApiTier.Registered:
      return 'Email us with your use case to be granted the elevated tier.';
    case ApiTier.Elevated:
      return 'You are on the highest self-serve tier. Get in touch if you need more.';
    default:
      return assertNever(tier, 'ApiTier');
  }
}

export const anonSaltMisconfiguredMessage = (minimumLength: number): string =>
  'This deployment is misconfigured and cannot meter anonymous requests: the ANON_SALT ' +
  `secret is missing or shorter than ${minimumLength} characters. Without it the ` +
  'anonymous quota key is derived from a public constant and a client IP, which is not a ' +
  'pseudonym. Requests presenting an API key are unaffected.';

/** Shipped in the 500's `details.how_to_fix`, because the operator reading it is the fix. */
export const ANON_SALT_FIX =
  'openssl rand -base64 32 | wrangler secret put ANON_SALT --config apps/api/wrangler.jsonc';

// ─── authentication (src/middleware/auth.ts) ─────────────────────────────────

export const MALFORMED_KEY_MESSAGE =
  'Malformed API key. Keys look like `ecfr_<id>_<secret>` and go in an `Authorization: Bearer` header.';

export const UNKNOWN_KEY_MESSAGE = 'Unknown or invalid API key.';

export const REVOKED_KEY_MESSAGE = 'This API key has been revoked.';

export const SUSPENDED_ACCOUNT_MESSAGE =
  'The account behind this key is suspended. Reply to the notice we sent you.';

export const UNVERIFIED_ACCOUNT_MESSAGE =
  'The account behind this key has not been verified. Check your email for the verification token.';

export const KEY_REQUIRED_MESSAGE =
  'This endpoint needs an API key. POST /v1/account/register to get one, then send it as `Authorization: Bearer ecfr_...`.';

// ─── account lifecycle (src/routes/account.ts) ───────────────────────────────

/**
 * Label on the key minted by verification. Stored on the row AND echoed in the 200 body, which
 * is why it is one constant: two spellings would put a different label in the database from
 * the one the caller was just told they had.
 */
export const FIRST_KEY_LABEL = 'first key';

export const KEY_SHOWN_ONCE_WARNING =
  'Store this key now. It is shown once and cannot be recovered — mint a new one if you lose it.';

/**
 * The registration 202. Identical for a new address, a pending one, and an active one —
 * anything else is an account-enumeration oracle.
 */
export const registrationAcceptedMessage = (email: string, ttlHours: number): string =>
  `If ${email} can receive mail, a verification token is on its way. It expires in ${ttlHours} hours. POST it to /v1/account/verify.`;

export const INVALID_VERIFY_TOKEN_MESSAGE =
  'That verification token is not valid. It may have already been used, or a newer one may have replaced it. POST /v1/account/register to get a fresh one.';

export const EXPIRED_VERIFY_TOKEN_MESSAGE =
  'That verification token has expired. POST /v1/account/register to get a fresh one.';

export const SUSPENDED_CANNOT_ACTIVATE_MESSAGE =
  'This account is suspended and cannot be activated.';

export const ACCOUNT_NOT_ACTIVE_MESSAGE = 'This account is not active.';

export const keyLimitReachedMessage = (active: number, max: number): string =>
  `This account already has ${active} active keys, the maximum is ${max}. Revoke one first.`;

/** Same body whether the key is someone else's or nonexistent — no probing for key ids. */
export const NO_ACTIVE_KEY_MESSAGE = 'No active key with that id on this account.';

/** Belt-and-braces narrowing inside a handler `requireKey` already guards. */
export const ACCOUNT_ROUTE_NEEDS_KEY_MESSAGE = 'This endpoint needs an API key.';

/** The admin route answers as if it did not exist unless the operator token matches. */
export const ADMIN_ROUTE_NOT_FOUND_MESSAGE = 'No route matches POST /v1/account/tier.';

export const NO_ACCOUNT_FOR_ADDRESS_MESSAGE = 'No account with that address.';

// ─── mailer (src/mailer.ts) ──────────────────────────────────────────────────

/** Loud on purpose: this line in a production log is a visible defect, not noise. */
export const MAILER_NOT_CONFIGURED_MESSAGE =
  'Verification email was not sent. Wire a real Mailer before running registration in production.';

/**
 * Stands in for a field the log deliberately does not carry.
 *
 * A distinct string from `REDACTED_PLACEHOLDER` below on purpose: withheld means "this
 * deployment does not log tokens", redacted means "this value was masked". Reading a log and
 * knowing which of the two happened is the difference between a policy and a bug.
 */
export const WITHHELD_PLACEHOLDER = '[withheld]';

/** What `redactEmail` returns when the input is not an address it can partially reveal. */
export const REDACTED_PLACEHOLDER = '[redacted]';

// ─── measurement reasons (src/wire.ts) ───────────────────────────────────────
//
// These travel inside the `reason` field of a `words: null` envelope. They are the API's
// explanation of WHY a number cannot be stated, and test/wire.test.ts pins several of them
// verbatim. Change the wording only with the tests, and only for a better explanation.

export const NO_CLAIMED_SCOPES_REASON =
  'this agency claims no CFR scopes, so there is nothing to roll up';

export const uncountedScopesReason = (uncounted: number, total: number): string =>
  `${uncounted} of ${total} claimed scopes have no measured word count`;

/**
 * A NULL subtree total, explained at the right altitude: the sum spans this agency plus its
 * descendants, so the gap is located (own scopes vs somewhere below) rather than blamed on
 * the agency's own counters, which may be perfect.
 */
export const subtreeUnknownReason = (counters: {
  childrenCount: number;
  refsCounted: number;
  refsTotal: number;
}): string => {
  const ownUncounted = Math.max(counters.refsTotal - counters.refsCounted, 0);
  const own =
    ownUncounted > 0
      ? `${ownUncounted} of this agency's own ${counters.refsTotal} claimed scopes are unmeasured`
      : "this agency's own scopes are all measured, so the gap is in a descendant";
  const children = counters.childrenCount === 1 ? 'child agency' : 'child agencies';
  return (
    `this total covers every distinct scope claimed by this agency and its ` +
    `${counters.childrenCount} ${children} (and their descendants); at least one of those ` +
    `scopes has no measured word count — ${own}`
  );
};

export const unresolvedScopeReason = (refKey: string): string =>
  `scope ${refKey} does not resolve to a node in the currently published CFR structure`;

export const claimantMismatchReason = (recorded: number, named: number): string =>
  `this scope records ${recorded} claimants but names ${named}, so a ` +
  'share cannot be attributed to a specific agency';

export const SHARE_OF_UNKNOWN_REASON =
  'the scope itself has no measured word count, and a share of an unknown is an unknown';

/** A `scope_overlap` row whose stored total is NULL, on /v1/overlap's own `word_count`. */
export const scopeUnmeasuredReason = (refKey: string): string =>
  `the word count for scope ${refKey} has not been measured`;

// ─── labels (src/routes/search.ts, src/routes/word-counts.ts) ────────────────

/**
 * How a whole title is named in a result row. Em dash, not a hyphen — /v1/search and
 * /v1/word-counts can return the same title and had their own copies of this template.
 */
export const titleLabel = (number: number, name: string): string => `${number} CFR — ${name}`;

// ─── corpus totals (src/routes/meta.ts, src/routes/word-counts.ts) ───────────

export const corpusUnknownReason = (unknownTitles: number, titles: number): string =>
  `${unknownTitles} of ${titles} titles have no measured word count`;

export const corpusTotalUnstatedReason = (unknownTitles: number, titles: number): string =>
  `${unknownTitles} of ${titles} titles have no measured word count, so the corpus total cannot be stated`;

/**
 * The corpus rollups are summed over AGENCIES, not over an agency's scopes, so they cannot
 * borrow `NO_CLAIMED_SCOPES_REASON` — on an empty database that answered a corpus-level
 * question with "this agency claims no CFR scopes".
 */
export const NO_AGENCIES_REASON =
  'no agencies have been synced yet, so there is nothing to roll up';

export const corpusAgenciesUncountedReason = (uncounted: number, total: number): string =>
  `${uncounted} of ${total} agencies have no measured word count`;

// ─── diff notes (src/diff/service.ts) ────────────────────────────────────────
//
// `note` on an `unavailable` or `too_large` diff is the consumer's only explanation, and the
// first sentence of the unavailable one is the endpoint's core promise: a fetch failure is
// NEVER a statement about the section.

export const diffUnavailableNote = (sideReasons: readonly string[]): string =>
  `Could not retrieve one or both sides from eCFR, so no comparison was made. This is NOT a statement that the section changed. ${sideReasons.join('; ')}`;

export const diffNoTextNote = (title: number, section: string): string =>
  `eCFR has no text for ${title} CFR ${section} at either issue date. Check the section identifier, or use /v1/amendments to find the dates it actually changed.`;

export const diffTooLargeNote = (longestSideLines: number, capLines: number): string =>
  `This section is ${longestSideLines} lines, over the ${capLines}-line inline diff cap. Both sides are linked below; fetch them from eCFR and diff locally.`;

export const sideParseFailedReason = (issueDate: string, detail: string): string =>
  `the XML for ${issueDate} could not be parsed: ${detail}`;

export const sectionMissingFromDocumentReason = (issueDate: string, section: string): string =>
  `eCFR returned a document for ${issueDate} that does not contain section ${section}`;

// ─── upstream fetch reasons (src/diff/ecfr.ts) ───────────────────────────────

export const NO_ATTEMPT_REASON = 'no attempt was made';

export const networkErrorReason = (detail: string | null): string =>
  detail === null ? 'network error' : `network error: ${detail}`;

export const RATE_LIMIT_PERSISTED_REASON =
  'eCFR rate limit (429) persisted through the retry budget';

export const gatewayErrorPersistedReason = (status: number): string =>
  `eCFR gateway error (${status}) persisted through the retry budget`;

export const upstreamHttpErrorReason = (status: number): string => `eCFR returned HTTP ${status}`;

export const declaredSizeOverCeilingReason = (declaredBytes: number, ceiling: number): string =>
  `section XML is ${declaredBytes} bytes, over the ${ceiling}-byte inline diff ceiling`;

export const decodedSizeOverCeilingReason = (decodedChars: number): string =>
  `section XML decoded to ${decodedChars} characters, over the inline diff ceiling`;

// ─── diff request validation (src/routes/diff.ts, src/diff/section-id.ts) ────

export const FROM_NOT_BEFORE_TO_MESSAGE = '`from` must be strictly earlier than `to`.';

/** `details.how_to_raise` beside it. Terser than `upgradeAdvice`: the message already explains. */
export const DIFF_REGISTER_HINT = 'POST /v1/account/register';

/** `details.how_to_find_dates` on the unknown-issue-date 404. */
export const ISSUE_DATES_HINT = '/v1/amendments';

export const DIFF_COMPUTE_FORBIDDEN_MESSAGE =
  'This comparison has not been computed yet, and the anonymous tier cannot trigger a live fetch from eCFR. Register for a free key and retry — it takes a minute.';

/** `which` names the offending field(s); "one of your two dates is wrong" is maddening. */
export const unknownIssueDatesMessage = (which: string, count: number): string =>
  `${which} ${count === 1 ? 'is not a date' : 'are not dates'} eCFR issued, so there ` +
  'is no full text to compare. eCFR issues content on roughly two days in three and never ' +
  'at weekends; list the real issue dates for a section with ' +
  '/v1/amendments?title=…&section=… and use the `issue_date` field.';

export const sectionLengthMessage = (max: number): string =>
  `\`section\` must be 1-${max} characters, e.g. "60.1" or "1.401(a)(4)-1".`;

export const SECTION_FORMAT_MESSAGE =
  '`section` is not a valid CFR section identifier. Expected forms: "60.1", "1.72-9", "1.401(a)(4)-1", "1926.1101".';

export const TITLE_RANGE_MESSAGE = '`title` must be a CFR title number between 1 and 50.';

export const issueDateShapeMessage = (field: string): string =>
  `\`${field}\` must be an eCFR issue date in YYYY-MM-DD form.`;

export const notACalendarDateMessage = (field: string): string =>
  `\`${field}\` is not a real calendar date.`;

export const beforeHorizonMessage = (field: string, horizon: string): string =>
  `\`${field}\` is before eCFR's full-text horizon (${horizon}). There is no text to fetch for that date, and reporting the absence as a change would be wrong.`;

// ─── resource lookups (src/routes/*.ts) ──────────────────────────────────────

export const agencyNotFoundMessage = (slug: string): string =>
  `No agency with slug "${slug}". Try /v1/search?q=...`;

export const titleNotFoundMessage = (n: number): string => `No CFR title ${n}.`;

export const parentOutsideTitleMessage = (n: number, parent: string): string =>
  `\`parent\` must be a citation inside title ${n}; got "${parent}".`;

export const PART_CITATION_FORMAT_MESSAGE = 'Part citations look like `40-60`.';

export const partNotFoundMessage = (title: number, part: string): string =>
  `No part ${part} in title ${title}. Part identifiers are case-sensitive; try /v1/search?q=${title}+CFR+${part}.`;

export const INVERTED_ISSUE_WINDOW_MESSAGE = '`issue_date_from` is after `issue_date_to`.';
