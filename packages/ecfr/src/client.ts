/**
 * The eCFR HTTP client.
 *
 * Three rules are baked into the shape of this file rather than left to callers:
 *
 *   1. Every JSON response goes through the matching Zod schema from `@ecfr-atlas/core`.
 *      There is no method that hands back unvalidated JSON, because the predecessor's failure
 *      began with reading a field that was not there.
 *
 *   2. The XML slice parameters are typed as `{ part?, section? }` and nothing else. eCFR's
 *      `?chapter=` and `?subtitle=` VALIDATE but DO NOT SLICE — they return the entire title
 *      with HTTP 200. That is the exact quirk that made the old extractor fall back to
 *      `substring(0, estimatedWords * 6)`. It is not possible to make that mistake through
 *      this API because the parameters do not exist on the type.
 *
 *   3. Retries distinguish the two measured upstream failures. See `errors.ts`.
 *
 * Never call this from a user-facing read path. Rule 4 of the project: no route may make an
 * outbound call to ecfr.gov on the read path.
 */

import {
  CONTACT_URL_PROBLEM_BAD_CHARACTER,
  CONTACT_URL_PROBLEM_NOT_ABSOLUTE,
  contactUrlFallbackWarning,
  contactUrlProblemBadScheme,
  ECFR_STREAM_NO_BODY_MESSAGE,
  ecfrDeadlineExceededMessage,
  ecfrRequestFailedMessage,
  ecfrRequestTimedOutMessage,
  ecfrVersionsTruncatedMessage,
} from '@ecfr-atlas/core';
import type {
  Agency,
  ContentVersion,
  EcfrSchemaName,
  StructureNode,
  Title,
} from '@ecfr-atlas/core/ecfr-schemas';
import {
  AgenciesResponse,
  StructureResponse,
  TitlesResponse,
  VERSIONS_PAGE_SIZE,
  VersionsResponse,
} from '@ecfr-atlas/core/ecfr-schemas';
import type { ZodError } from 'zod';
import type { RetryKind } from './errors.js';
import {
  EcfrAbortError,
  EcfrContractError,
  EcfrHttpError,
  EcfrNetworkError,
  EcfrTooLargeError,
  retryKindOf,
} from './errors.js';
import { type RateGovernor, sharedRateGovernor } from './governor.js';

// ─── constants ────────────────────────────────────────────────────────────────

export const ECFR_BASE_URL = 'https://www.ecfr.gov';

/**
 * Fallback contact URL, used only when `ECFR_CONTACT_URL` is unset or unusable.
 *
 * This is this project's own repository — a real, reachable address, not a placeholder. It used
 * to read `https://github.com/OWNER/ecfr-atlas`, which resolves to nothing, which means every
 * production request advertised a contact route that did not exist. eCFR's acceptable-use
 * expectation is a CONTACTABLE User-Agent and they rate-limit harder without one, so an
 * unreachable URL is functionally the same as sending no contact at all.
 *
 * A fork or a separate deployment should still override it: the point of the header is to reach
 * whoever is actually making the requests, and that is not us.
 */
const DEFAULT_ECFR_CONTACT_URL = 'https://github.com/councilOfNine/eCFR';

/**
 * Reads and validates `ECFR_CONTACT_URL`.
 *
 * Rejects rather than accepts on doubt, for two reasons. A value with whitespace, a control
 * character or a parenthesis would either break the `(+url)` comment token or — with CR/LF —
 * let an environment variable inject a second request header. And a value that is not an
 * absolute http(s) URL is not a contact route, it is noise in someone else's logs.
 *
 * An unusable value falls back and says so on stderr instead of throwing: aborting a four-hour
 * corpus sync over a typo in a contact string is the wrong trade, but doing it silently would
 * leave the operator believing they are attributable when they are not.
 */
function contactUrlFromEnv(): string | null {
  // `process` does not exist in a Worker isolate and this package is runtime-agnostic.
  const raw = globalThis.process?.env?.ECFR_CONTACT_URL;
  if (raw === undefined) return null;

  const value = raw.trim();
  if (value === '') return null;

  const reject = (reason: string): null => {
    console.warn(contactUrlFallbackWarning(reason, DEFAULT_ECFR_CONTACT_URL));
    return null;
  };

  // An ALLOW-list of the RFC 3986 URI characters, not a deny-list of bad ones. A deny-list has
  // to enumerate every control character correctly to be safe; this cannot miss one. Whitespace,
  // CR/LF, `(`, `)`, `\` and `"` are all absent from it — the first two because a newline in an
  // environment variable must never become a second request header, the rest because they
  // delimit and escape the `(...)` comment this value is interpolated into.
  //
  // Literal pattern, never built from input. See biome-plugins/no-dynamic-regexp.grit and
  // rule 3 in CONTRIBUTING.md.
  if (!/^[A-Za-z0-9._~:/?#@!$&'*+,;=%[\]-]+$/.test(value)) {
    return reject(CONTACT_URL_PROBLEM_BAD_CHARACTER);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return reject(CONTACT_URL_PROBLEM_NOT_ABSOLUTE);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return reject(contactUrlProblemBadScheme(parsed.protocol));
  }

  return value;
}

/**
 * Contact URL advertised in the User-Agent. Overridable with the `ECFR_CONTACT_URL` environment
 * variable; documented in README.md and docs/ARCHITECTURE.md.
 *
 * Read once at module load. The User-Agent is a deployment-level fact, not a per-request one,
 * and re-reading it per request would make the header depend on when a mutation happened.
 */
export const ECFR_CONTACT_URL = contactUrlFromEnv() ?? DEFAULT_ECFR_CONTACT_URL;

export const ECFR_USER_AGENT = `ecfr-atlas/0.1 (+${ECFR_CONTACT_URL})`;

/** eCFR paths accept a bare date, never an ISO timestamp. Guarded so a bad date is not a 404. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Titles run 1..50. Title 35 exists but is reserved. */
const MAX_TITLE_NUMBER = 50;

// ─── options ──────────────────────────────────────────────────────────────────

/**
 * `typeof fetch` rather than a hand-rolled signature, so the global implementation of either
 * Node 22 or the Workers runtime drops in unchanged and a test double is type-checked against
 * the real thing.
 */
export type FetchLike = typeof fetch;

export interface RetryBudget {
  /** Total attempts including the first. */
  attempts: number;
  /** First backoff, before jitter. */
  baseMs: number;
  /** Backoff ceiling, before jitter. */
  capMs: number;
}

/**
 * Keyed by `RetryKind` so the retry loop indexes it directly. Keeping the two vocabularies
 * identical removes the translation table that would otherwise be the place a failure mode
 * gets quietly mapped to the wrong budget.
 */
export type RetryPolicy = Record<RetryKind, RetryBudget>;

/**
 * Measured basis for these numbers:
 *
 *   - `rate_limited`: a 429 comes back in ~0.13 s from bare nginx with no Retry-After, so the
 *     only signal available is "wait longer each time". Full jitter, 2 s to 60 s, 6 attempts.
 *     Six attempts of full jitter at this shape spans roughly two minutes of wall clock, which
 *     is comfortably longer than any token bucket refill.
 *   - `gateway`: a 504 is origin XML generation timing out at ~50 s on a large title. Isolated
 *     sequential title-49 fetches failed 2 of 4 times, so this is a coin flip and not an error
 *     condition. Fewer attempts but a much longer ceiling, because retrying immediately just
 *     asks the origin to redo the same 50 s of work.
 *   - `network`: connection resets are cheap to retry and cheap to give up on.
 */
export function defaultRetryPolicy(): RetryPolicy {
  return {
    rate_limited: { attempts: 6, baseMs: 2_000, capMs: 60_000 },
    gateway: { attempts: 4, baseMs: 5_000, capMs: 120_000 },
    network: { attempts: 4, baseMs: 1_000, capMs: 30_000 },
  };
}

export type EcfrWarning =
  | {
      kind: 'retry';
      url: string;
      attempt: number;
      delayMs: number;
      status: number | null;
      retryKind: RetryKind;
      reason: string;
    }
  | {
      kind: 'versions_truncated';
      url: string;
      rows: number;
      reason: string;
    };

export type WarningSink = (warning: EcfrWarning) => void;

export interface EcfrClientOptions {
  baseUrl?: string;
  userAgent?: string;
  /** Injected for tests and for the Worker, which supplies its own bound fetch. */
  fetch?: FetchLike;
  /** Defaults to the process-wide governor so all callers share one 8 req/s budget. */
  governor?: RateGovernor;
  retry?: Partial<RetryPolicy>;
  /** Per-attempt deadline for JSON endpoints. */
  jsonTimeoutMs?: number;
  /**
   * Per-attempt deadline for XML. Generous on purpose: the origin's own timeout lands at ~50 s
   * and a successful large-title generation can legitimately run longer than that.
   */
  xmlTimeoutMs?: number;
  onWarning?: WarningSink;
  /** Injectable for deterministic jitter in tests. */
  random?: () => number;
  /** Injectable so tests do not sleep in real time. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  /** Caller cancellation. Aborting via this signal is never retried. */
  signal?: AbortSignal;
  /** Overrides the per-kind default deadline for this call. */
  timeoutMs?: number;
}

/**
 * The ONLY eCFR query parameters that actually slice a title's XML.
 *
 * `?chapter=` and `?subtitle=` are accepted by the API and return HTTP 200 with the ENTIRE
 * title body. They are absent from this type on purpose.
 */
export interface TitleXmlSlice {
  part?: string;
  section?: string;
}

export interface XmlFetchOptions extends RequestOptions {
  /**
   * Reject the response once this many decoded bytes have arrived, rather than buffering it.
   * Worth setting on the Worker /diff path (128 MB per isolate); leave unset in the Node sync,
   * which is run with --max-old-space-size=8192.
   */
  maxBytes?: number;
}

// ─── results ──────────────────────────────────────────────────────────────────

export interface AgenciesResult {
  agencies: Agency[];
}

export interface TitlesResult {
  titles: Title[];
  /** eCFR's snapshot date for this listing, when it reports one. */
  date: string | null;
  /**
   * TRUE means eCFR is mid-import. A sync must abort rather than capture a half-written
   * corpus; surfaced here so the caller cannot miss it.
   */
  importInProgress: boolean;
}

export interface VersionsTruncation {
  rows: number;
  filters: Readonly<Record<string, string>>;
  reason: string;
}

export interface VersionsResult {
  versions: ContentVersion[];
  totalPages: number | null;
  /**
   * `meta.page` — which page eCFR believes it just served.
   *
   * Present so a pager can prove the `page` parameter was honoured rather than infer it from
   * whether the rows looked new. If upstream ever starts ignoring `page`, this comes back as 1
   * for every request and the caller can refuse immediately instead of writing 1,000 of a
   * title's 18,752 amendments and rendering confidently on 5% of the data. Null when eCFR
   * omits the field, which it does whenever the result set fits on a single page.
   */
  page: number | null;
  /**
   * From `meta.result_count`, which is what eCFR actually calls it — there is no
   * `meta.total_count` on this endpoint. Null when the field is absent, which it is on every
   * FILTERED response, alongside the missing `total_pages` described below.
   */
  totalCount: number | null;
  /**
   * Non-null when this response may be silently short.
   *
   * eCFR omits `meta.total_pages` from FILTERED /versions responses, so a truncated page of
   * exactly VERSIONS_PAGE_SIZE rows is byte-for-byte indistinguishable from a complete one.
   * Under-reporting amendments is the quiet kind of wrong, so it is reported rather than
   * inferred away.
   */
  truncation: VersionsTruncation | null;
}

export interface XmlStreamResult {
  /** Already decompressed by the runtime. */
  stream: ReadableStream<Uint8Array>;
  /** Content-Length as sent. With gzip this is the COMPRESSED size, not the XML size. */
  contentLength: number | null;
  contentEncoding: string | null;
  /** Releases the connection without draining the body. */
  cancel: (reason?: unknown) => Promise<void>;
}

// ─── internals ────────────────────────────────────────────────────────────────

/**
 * Structural stand-in for a Zod schema.
 *
 * Depending on the shape rather than on `z.ZodType` keeps inference simple across Zod's
 * variance annotations (the recursive `StructureNode` schema is declared as an explicit
 * `ZodType`, the others are `ZodObject`s) and makes this boundary trivially fakeable in tests.
 */
interface SafeParser<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: ZodError };
}

interface ArmedTimeout {
  signal: AbortSignal;
  /** True once OUR deadline fired, as opposed to the caller aborting. */
  didTimeOut: () => boolean;
  disarm: () => void;
}

function armTimeout(timeoutMs: number, callerSignal: AbortSignal | undefined): ArmedTimeout {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(ecfrDeadlineExceededMessage(timeoutMs)));
  }, timeoutMs);

  // AbortSignal.any() would be tidier but is not uniformly available across the Node and
  // Workers versions this package targets; a listener is portable and cheap.
  const onCallerAbort = (): void => {
    controller.abort(callerSignal?.reason);
  };
  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    disarm: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

function fullJitterDelay(budget: RetryBudget, attempt: number, random: () => number): number {
  // Full jitter (random between 0 and the exponential ceiling) rather than equal jitter,
  // because every sync worker hits the same token bucket and correlated retries are what turn
  // one 429 into a stampede.
  const ceiling = Math.min(budget.capMs, budget.baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Map an HTTP status to a retry budget.
 *
 * 429 and the gateway statuses are the two measured modes. Other 5xx get the gateway budget
 * because they are also origin-side and also transient in practice. Every other 4xx fails
 * immediately: a 404 for a date before a title existed will never become a 200, and burning
 * six attempts on it just spends the shared rate budget.
 */
function retryKindForStatus(status: number): RetryKind | null {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'gateway';
  return null;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 300_000);
  const when = Date.parse(header);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.min(when - Date.now(), 300_000));
}

/** Read a small error body for diagnostics without risking a huge buffer. */
async function readErrorBody(response: Response): Promise<string> {
  try {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 64 * 1024) {
      await response.body?.cancel();
      return '';
    }
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * Buffer a text body, refusing to exceed `maxBytes`.
 *
 * A Content-Length pre-check is not sufficient: responses arrive gzipped (measured 4.96x on
 * the corpus), so the header describes the compressed size and would let a 4.96x-larger body
 * through. Counting decoded bytes as they arrive is the only honest ceiling.
 */
async function readTextWithLimit(
  response: Response,
  maxBytes: number | undefined,
  url: string,
): Promise<string> {
  if (maxBytes === undefined) return response.text();
  const body = response.body;
  if (!body) return '';

  // Annotated rather than inferred: the ambient `Response.body` declaration resolves to
  // `ReadableStream<any>` under @types/node, which would make every read below untyped.
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new EcfrTooLargeError(bytes, maxBytes, url);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
  parts.push(decoder.decode());
  return parts.join('');
}

function encodeQuery(params: Readonly<Record<string, string | undefined>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value);
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

function assertTitleNumber(titleNumber: number): void {
  if (!Number.isInteger(titleNumber) || titleNumber < 1 || titleNumber > MAX_TITLE_NUMBER) {
    throw new RangeError(
      `title number must be an integer 1..${MAX_TITLE_NUMBER}, got ${titleNumber}`,
    );
  }
}

/**
 * eCFR's /versions pages are 1-based. The ceiling is deliberately loose — it exists to catch a
 * caller that computed a page from bad arithmetic, not to encode a real upstream limit.
 */
function assertPageNumber(page: number): void {
  if (!Number.isInteger(page) || page < 1 || page > 100_000) {
    throw new RangeError(`page must be an integer 1..100000, got ${page}`);
  }
}

function assertDate(date: string): void {
  if (!DATE_RE.test(date)) {
    throw new RangeError(`eCFR dates must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
  }
}

// ─── the client ───────────────────────────────────────────────────────────────

export class EcfrClient {
  readonly baseUrl: string;
  readonly userAgent: string;
  readonly retry: RetryPolicy;

  readonly #fetch: FetchLike;
  readonly #governor: RateGovernor;
  readonly #jsonTimeoutMs: number;
  readonly #xmlTimeoutMs: number;
  readonly #onWarning: WarningSink | undefined;
  readonly #random: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: EcfrClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? ECFR_BASE_URL).replace(/\/+$/, '');
    this.userAgent = options.userAgent ?? ECFR_USER_AGENT;
    this.retry = { ...defaultRetryPolicy(), ...options.retry };
    // Bound to globalThis: an unbound `fetch` throws "Illegal invocation" in some runtimes.
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#governor = options.governor ?? sharedRateGovernor();
    this.#jsonTimeoutMs = options.jsonTimeoutMs ?? 60_000;
    this.#xmlTimeoutMs = options.xmlTimeoutMs ?? 240_000;
    this.#onWarning = options.onWarning;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  // ─── public API ─────────────────────────────────────────────────────────────

  async fetchAgencies(options: RequestOptions = {}): Promise<AgenciesResult> {
    const url = `${this.baseUrl}/api/admin/v1/agencies.json`;
    const parsed = await this.#getJson(url, 'agencies', AgenciesResponse, options);
    return { agencies: parsed.agencies };
  }

  async fetchTitles(options: RequestOptions = {}): Promise<TitlesResult> {
    const url = `${this.baseUrl}/api/versioner/v1/titles.json`;
    const parsed = await this.#getJson(url, 'titles', TitlesResponse, options);
    return {
      titles: parsed.titles,
      date: parsed.meta?.date ?? null,
      importInProgress: parsed.meta?.import_in_progress === true,
    };
  }

  /**
   * The structure tree for one title on one date.
   *
   * 2.4-2.7 MB per title, and every node carries an additive byte `size`. Comparing that
   * against the stored `xml_bytes` is the free change fingerprint that lets the nightly delta
   * skip untouched parts without downloading any XML.
   */
  async fetchStructure(
    titleNumber: number,
    date: string,
    options: RequestOptions = {},
  ): Promise<StructureNode> {
    assertTitleNumber(titleNumber);
    assertDate(date);
    const url = `${this.baseUrl}/api/versioner/v1/structure/${date}/title-${titleNumber}.json`;
    return this.#getJson(url, 'structure', StructureResponse, options);
  }

  /**
   * Title XML, optionally sliced to a part or a section.
   *
   * Unsliced, this is the whole title: up to 156,946,999 bytes (title 40), and title 26 decodes
   * to ~174 MB as a V8 two-byte string. Both exceed a Worker's 128 MB per-isolate limit, which
   * is why the backfill runs in Node under GitHub Actions. Prefer a `part` slice wherever the
   * caller knows one.
   */
  async fetchTitleXml(
    titleNumber: number,
    date: string,
    slice: TitleXmlSlice = {},
    options: XmlFetchOptions = {},
  ): Promise<string> {
    const url = this.titleXmlUrl(titleNumber, date, slice);
    const timeoutMs = options.timeoutMs ?? this.#xmlTimeoutMs;
    return this.#retryLoop(url, () =>
      this.#attempt(url, timeoutMs, options.signal, 'application/xml', (response) =>
        readTextWithLimit(response, options.maxBytes, url),
      ),
    );
  }

  /**
   * Streaming variant for titles too large to hold as one string.
   *
   * The per-attempt deadline covers response HEADERS only; once the stream is handed over the
   * caller owns it, including cancelling it. Retries cannot span a partially consumed body, so
   * a mid-stream failure is the caller's to handle — typically by calling this again.
   *
   * In Node, wrap with `Readable.fromWeb(result.stream)`. This package does not import
   * `node:stream` itself so that it stays loadable inside a Worker bundle.
   */
  async fetchTitleXmlStream(
    titleNumber: number,
    date: string,
    slice: TitleXmlSlice = {},
    options: RequestOptions = {},
  ): Promise<XmlStreamResult> {
    const url = this.titleXmlUrl(titleNumber, date, slice);
    const timeoutMs = options.timeoutMs ?? this.#xmlTimeoutMs;
    return this.#retryLoop(url, async () => {
      const armed = armTimeout(timeoutMs, options.signal);
      try {
        const response = await this.#governor.run(() =>
          this.#fetch(url, {
            method: 'GET',
            headers: this.#headers('application/xml'),
            signal: armed.signal,
          }),
        );
        if (!response.ok) throw await this.#httpError(response, url);
        const body = response.body;
        if (!body) {
          throw new EcfrNetworkError(ECFR_STREAM_NO_BODY_MESSAGE, url, false);
        }
        return {
          stream: body,
          contentLength: numberOrNull(response.headers.get('content-length')),
          contentEncoding: response.headers.get('content-encoding'),
          cancel: async (reason?: unknown) => {
            await body.cancel(reason);
          },
        } satisfies XmlStreamResult;
      } catch (error) {
        throw this.#wrapTransportError(error, url, armed.didTimeOut(), options.signal);
      } finally {
        // Disarmed as soon as the headers are in. Leaving it armed would abort a legitimate
        // multi-minute download of a 156 MB title mid-stream.
        armed.disarm();
      }
    });
  }

  /**
   * Amendment history for a title.
   *
   * `chapter` and `part` here are FILTER parameters on a JSON endpoint, not XML slicing
   * parameters; unlike the XML endpoint they do narrow the result. They also suppress
   * `meta.total_pages`, hence the truncation check.
   *
   * `page` is PAGINATION, not a filter, and is deliberately kept out of `activeFilters`: it does
   * not narrow the result set, so page 7 of an unfiltered history must not be mistaken for a
   * filtered response and flagged as possibly truncated. A backfill needs it because the whole
   * history of title 12 is 18,752 rows across 19 pages of 1,000.
   */
  async fetchVersions(
    titleNumber: number,
    filters: { issueDateGte?: string; chapter?: string; part?: string; page?: number } = {},
    options: RequestOptions = {},
  ): Promise<VersionsResult> {
    assertTitleNumber(titleNumber);
    if (filters.issueDateGte !== undefined) assertDate(filters.issueDateGte);
    if (filters.page !== undefined) assertPageNumber(filters.page);

    const query: Record<string, string | undefined> = {
      'issue_date[gte]': filters.issueDateGte,
      chapter: filters.chapter,
      part: filters.part,
    };
    const activeFilters: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') activeFilters[key] = value;
    }
    if (filters.page !== undefined) query.page = String(filters.page);

    const url = `${this.baseUrl}/api/versioner/v1/versions/title-${titleNumber}.json${encodeQuery(query)}`;
    const parsed = await this.#getJson(url, 'versions', VersionsResponse, options);

    const totalPages = parsed.meta?.total_pages ?? null;
    const rows = parsed.content_versions.length;
    const isFiltered = Object.keys(activeFilters).length > 0;

    let truncation: VersionsTruncation | null = null;
    if (isFiltered && rows === VERSIONS_PAGE_SIZE && totalPages === null) {
      truncation = {
        rows,
        filters: activeFilters,
        reason: ecfrVersionsTruncatedMessage(VERSIONS_PAGE_SIZE),
      };
      this.#warn({ kind: 'versions_truncated', url, rows, reason: truncation.reason });
    }

    return {
      versions: parsed.content_versions,
      totalPages,
      page: parsed.meta?.page ?? null,
      totalCount: parsed.meta?.result_count ?? null,
      truncation,
    };
  }

  /** Exposed so callers can log or memoise on the exact URL that was requested. */
  titleXmlUrl(titleNumber: number, date: string, slice: TitleXmlSlice = {}): string {
    assertTitleNumber(titleNumber);
    assertDate(date);
    return (
      `${this.baseUrl}/api/versioner/v1/full/${date}/title-${titleNumber}.xml` +
      encodeQuery({ part: slice.part, section: slice.section })
    );
  }

  // ─── request plumbing ───────────────────────────────────────────────────────

  #headers(accept: string): Record<string, string> {
    return {
      accept,
      // Always requested. The corpus is 810,419,929 B raw against 163,275,960 B gzipped, so
      // this is a 4.96x saving on every fetch. Both Node's undici and the Workers runtime
      // decode the body transparently based on Content-Encoding, regardless of who set this
      // header, so callers still see plain text.
      'accept-encoding': 'gzip',
      'user-agent': this.userAgent,
    };
  }

  #warn(warning: EcfrWarning): void {
    this.#onWarning?.(warning);
  }

  async #httpError(response: Response, url: string): Promise<EcfrHttpError> {
    const body = await readErrorBody(response);
    return new EcfrHttpError(
      response.status,
      url,
      body,
      retryKindForStatus(response.status),
      // Defensive only. The measured behaviour is that eCFR's 429 is a bare nginx page with no
      // Retry-After at all; if that ever changes, honouring it beats guessing.
      parseRetryAfter(response.headers.get('retry-after')),
    );
  }

  /**
   * Turn a thrown transport value into one of ours.
   *
   * The caller's own abort is deliberately NOT retryable: when a sync is being shut down,
   * six polite retries is the wrong answer.
   */
  #wrapTransportError(
    error: unknown,
    url: string,
    didTimeOut: boolean,
    callerSignal: AbortSignal | undefined,
  ): unknown {
    if (error instanceof EcfrHttpError) return error;
    if (error instanceof EcfrContractError) return error;
    if (error instanceof EcfrTooLargeError) return error;
    if (error instanceof EcfrNetworkError) return error;
    if (callerSignal?.aborted) return new EcfrAbortError(url, error);
    const message = error instanceof Error ? error.message : String(error);
    return new EcfrNetworkError(
      didTimeOut ? ecfrRequestTimedOutMessage(message) : ecfrRequestFailedMessage(message),
      url,
      didTimeOut,
      error,
    );
  }

  /** One governed, deadline-bounded attempt. Retries wrap this, so each attempt pays a token. */
  async #attempt<T>(
    url: string,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
    accept: string,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    const armed = armTimeout(timeoutMs, callerSignal);
    try {
      return await this.#governor.run(async () => {
        const response = await this.#fetch(url, {
          method: 'GET',
          headers: this.#headers(accept),
          signal: armed.signal,
        });
        if (!response.ok) throw await this.#httpError(response, url);
        return read(response);
      });
    } catch (error) {
      throw this.#wrapTransportError(error, url, armed.didTimeOut(), callerSignal);
    } finally {
      armed.disarm();
    }
  }

  async #retryLoop<T>(url: string, attempt: () => Promise<T>): Promise<T> {
    let attemptNo = 0;
    for (;;) {
      attemptNo += 1;
      try {
        return await attempt();
      } catch (error) {
        const kind = retryKindOf(error);
        if (kind === null) throw error;
        const budget = this.retry[kind];
        if (attemptNo >= budget.attempts) {
          if (error instanceof EcfrNetworkError || error instanceof EcfrHttpError) {
            error.attempts = attemptNo;
          }
          throw error;
        }
        const suggested = error instanceof EcfrHttpError ? error.retryAfterMs : null;
        const delayMs = suggested ?? fullJitterDelay(budget, attemptNo, this.#random);
        this.#warn({
          kind: 'retry',
          url,
          attempt: attemptNo,
          delayMs,
          status: error instanceof EcfrHttpError ? error.status : null,
          retryKind: kind,
          reason: error instanceof Error ? error.message : String(error),
        });
        await this.#sleep(delayMs);
      }
    }
  }

  async #getJson<T>(
    url: string,
    schemaName: EcfrSchemaName,
    schema: SafeParser<T>,
    options: RequestOptions,
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.#jsonTimeoutMs;
    return this.#retryLoop(url, () =>
      this.#attempt(url, timeoutMs, options.signal, 'application/json', async (response) => {
        const raw: unknown = await response.json();
        const result = schema.safeParse(raw);
        if (!result.success) {
          // Fatal by construction: `retryKindOf` returns null for this class, so the loop
          // rethrows immediately and the scheduled contract test sees the real failure.
          throw new EcfrContractError(schemaName, url, result.error.issues);
        }
        return result.data;
      }),
    );
  }
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
