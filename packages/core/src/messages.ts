/**
 * Every reusable human-readable string the packages emit, in one module.
 *
 * These strings travel further than a log line: measurement reasons are stored in
 * `structure_node.word_count_reason`, served by the public API, and rendered in the UI, and
 * the eCFR boundary messages become reasons too when `measureXml` converts a failure into a
 * `Measurement`. A future i18n pass will key off this module.
 *
 * The wording is load-bearing. Tests assert on it (packages/core/test/rollup-and-dedup.test.ts,
 * packages/ecfr/test/never-fabricate.test.ts, packages/db/test/schema-constraints.test.ts) and
 * the committed fixture embeds it, so a change here is a visible, deliberate diff — never a
 * side effect of a refactor.
 *
 * Parameterised messages are template FUNCTIONS rather than concatenation at the call site,
 * so the whole sentence is readable (and translatable) in one place.
 */

// ─── measurement reasons (persisted in word_count_reason) ─────────────────────

export const REASON_NOT_COMPUTED = 'no sync run has reached this node';

export const REASON_NOTHING_TO_ROLL_UP = 'no descendants to roll up';

export const reasonDescendantsUncounted = (missing: number, total: number): string =>
  `${missing} of ${total} descendants are not counted`;

/**
 * Fallback for a row whose reason column is unexpectedly null. The CHECK constraint makes
 * that unreachable through the sync pipeline; this exists for hand-written rows in tests.
 */
export const REASON_UNRECORDED = 'unknown';

export const REASON_SUBTREE_NOT_IN_XML =
  'the requested subtree was not present in the XML returned by eCFR';

export const reasonSubtreeOverXmlCeiling = (xmlBytes: number, limitBytes: number): string =>
  `subtree is ${xmlBytes} bytes of XML, over the ${limitBytes}-byte per-node ceiling; ` +
  'measure its children and roll up instead';

export const reasonTextOverCeiling = (maxChars: number): string =>
  `countable text exceeds the ${maxChars}-character per-node ceiling; ` +
  'measure its children and roll up instead';

export const reasonOwnTextOverCeiling = (maxChars: number): string =>
  `directly-owned text exceeds the ${maxChars}-character per-node ceiling`;

export const reasonDocumentOverParseCeiling = (chars: number, limitChars: number): string =>
  `document is ${chars} characters, over the ${limitChars}-character parse ceiling`;

export const REASON_NOT_REGULATION_XML =
  'document contains no CFR structure element (DIV1..DIVn); it is truncated, empty, ' +
  'or not regulation XML at all';

/** `description` is the target's "type identifier" pair; empty when the target was blank. */
export const reasonNodeNotFoundInXml = (description: string): string =>
  `no ${description === '' ? 'matching' : description} node found in the XML returned by eCFR`;

// ─── eCFR boundary: error messages ────────────────────────────────────────────

export const ecfrContractFailedMessage = (
  schemaName: string,
  issueCount: number,
  head: string,
): string => `eCFR response failed the '${schemaName}' contract (${issueCount} issue(s)): ${head}`;

export const ecfrHttpStatusMessage = (status: number, url: string): string =>
  `eCFR responded ${status} for ${url}`;

export const ecfrAbortedMessage = (url: string): string => `eCFR request aborted by caller: ${url}`;

export const ecfrPayloadTooLargeMessage = (bytes: number, limitBytes: number): string =>
  `payload of ${bytes} bytes exceeds the ${limitBytes}-byte ceiling`;

export const ecfrRequestTimedOutMessage = (detail: string): string =>
  `eCFR request timed out: ${detail}`;

export const ecfrRequestFailedMessage = (detail: string): string =>
  `eCFR request failed: ${detail}`;

export const ecfrDeadlineExceededMessage = (timeoutMs: number): string =>
  `eCFR request exceeded ${timeoutMs} ms`;

export const ECFR_STREAM_NO_BODY_MESSAGE = 'eCFR returned no body for a streaming request';

export const xmlNotWellFormedMessage = (
  detail: string | undefined,
  line: number | undefined,
  column: number | undefined,
): string =>
  `document is not well-formed XML: ${detail ?? 'unknown error'}` +
  (line === undefined ? '' : ` (line ${line}, column ${column ?? '?'})`);

export const xmlParserFailedMessage = (detail: string): string =>
  `fast-xml-parser could not parse the document: ${detail}`;

// ─── eCFR boundary: operator warnings ─────────────────────────────────────────

export const ecfrVersionsTruncatedMessage = (pageSize: number): string =>
  `filtered /versions returned exactly ${pageSize} rows and omitted ` +
  'meta.total_pages, so this window may be silently truncated; narrow the ' +
  'issue_date[gte] window and re-run';

export const contactUrlFallbackWarning = (problem: string, fallbackUrl: string): string =>
  `ECFR_CONTACT_URL is set but ${problem}; falling back to ${fallbackUrl}. ` +
  'eCFR expects a contactable User-Agent, so this deployment is now attributed to the ' +
  'upstream project rather than to you.';

export const CONTACT_URL_PROBLEM_BAD_CHARACTER =
  'contains a character that is not allowed in a URL inside a User-Agent comment — ' +
  'whitespace, a control character, or one of ( ) \\ "';

export const CONTACT_URL_PROBLEM_NOT_ABSOLUTE = 'is not an absolute URL';

export const contactUrlProblemBadScheme = (protocol: string): string =>
  `uses the ${protocol} scheme rather than https: or http:`;
