/**
 * The single place a user-facing route may reach ecfr.gov.
 *
 * RULE 4: no read path fetches upstream. /v1/diff is the one carve-out, and it is only a
 * carve-out on a cache miss — every result is memoised to R2 permanently, so the first viewer
 * of a given (title, section, from, to) pays and nobody else ever does.
 *
 * Rate limiting upstream is a TOKEN BUCKET, not a concurrency gate, so being serial does not
 * help. Sustained <=8 req/s is clean at any parallelism; ~10 req/s is where it starts. There
 * are two distinct failures and they need different handling:
 *
 *   162-byte body — HTTP 429 from bare nginx. No Retry-After header, comes back in ~0.13 s.
 *     Nothing to read, so: blind exponential backoff with jitter.
 *
 *   246-byte body — HTTP 504 at roughly 50 s. The origin's XML generation timed out on a
 *     large title. Isolated sequential title-49 fetches failed 2 of 4 times, so this is a
 *     coin flip rather than an error condition. Retry, with a longer ceiling.
 *
 * Always request gzip (the corpus compresses 4.96x). Always send a descriptive User-Agent
 * with a contact URL. NEVER scrape ecfr.gov HTML — automated clients get 302'd to a CAPTCHA.
 */

import {
  DIFF_MAX_BYTES_PER_SIDE,
  ECFR_BASE_URL,
  ECFR_FETCH_TIMEOUT_MS,
  ECFR_RETRY_429,
  ECFR_RETRY_504,
  ecfrDatedSectionUrl,
} from '../constants/config.js';
import {
  declaredSizeOverCeilingReason,
  decodedSizeOverCeilingReason,
  gatewayErrorPersistedReason,
  NO_ATTEMPT_REASON,
  networkErrorReason,
  RATE_LIMIT_PERSISTED_REASON,
  upstreamHttpErrorReason,
} from '../constants/messages.js';
import { FetchOutcomeKind } from '../enums.js';

export type FetchOutcome =
  | { kind: typeof FetchOutcomeKind.Ok; xml: string; bytes: number }
  /** eCFR says this section does not exist at this date. A fact, not a failure. */
  | { kind: typeof FetchOutcomeKind.Absent }
  /** Anything we could not resolve. NEVER interpreted as an addition or a deletion. */
  | { kind: typeof FetchOutcomeKind.Failed; reason: string; status: number | null };

export interface FetchDeps {
  userAgent: string;
  /** Injected so tests can drive every branch without a network. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function sectionXmlUrl(title: number, section: string, issueDate: string): string {
  const url = new URL(`/api/versioner/v1/full/${issueDate}/title-${title}.xml`, ECFR_BASE_URL);
  // `?section=` genuinely slices. `?chapter=` and `?subtitle=` validate and return the ENTIRE
  // title — the upstream behaviour at the root of the predecessor's fabricated counts.
  url.searchParams.set('section', section);
  return url.toString();
}

/** Human-facing link to the same content on eCFR. Required by the attribution policy. */
export function sectionHumanUrl(title: number, section: string, issueDate: string): string {
  return ecfrDatedSectionUrl(issueDate, title, section);
}

export async function fetchSectionXml(
  title: number,
  section: string,
  issueDate: string,
  deps: FetchDeps,
): Promise<FetchOutcome> {
  const url = sectionXmlUrl(title, section, issueDate);
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;

  let attempt429 = 0;
  let attempt504 = 0;
  let lastReason: string = NO_ATTEMPT_REASON;
  let lastStatus: number | null = null;

  // One loop for both retry budgets: a request can bounce between 429 and 504, and giving
  // each its own loop would let a pathological alternation retry forever.
  const maxAttempts = ECFR_RETRY_429.attempts + ECFR_RETRY_504.attempts;

  for (let i = 0; i < maxAttempts; i++) {
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: {
          // Descriptive UA with a contact URL, as eCFR asks for.
          'User-Agent': deps.userAgent,
          Accept: 'application/xml',
          'Accept-Encoding': 'gzip',
        },
        signal: AbortSignal.timeout(ECFR_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      lastReason = networkErrorReason(error instanceof Error ? error.message : null);
      lastStatus = null;
      if (attempt504 < ECFR_RETRY_504.attempts) {
        await sleep(backoff(ECFR_RETRY_504, attempt504++));
        continue;
      }
      break;
    }

    lastStatus = response.status;

    if (response.status === 429) {
      if (attempt429 < ECFR_RETRY_429.attempts) {
        await sleep(backoff(ECFR_RETRY_429, attempt429++));
        continue;
      }
      lastReason = RATE_LIMIT_PERSISTED_REASON;
      break;
    }

    if (response.status === 504 || response.status === 502 || response.status === 503) {
      if (attempt504 < ECFR_RETRY_504.attempts) {
        await sleep(backoff(ECFR_RETRY_504, attempt504++));
        continue;
      }
      lastReason = gatewayErrorPersistedReason(response.status);
      break;
    }

    if (response.status === 404) {
      // eCFR is telling us the section did not exist in that issue. This is the ONLY status
      // that may be reported as an absence; everything else is "we do not know".
      return { kind: FetchOutcomeKind.Absent };
    }

    if (!response.ok) {
      lastReason = upstreamHttpErrorReason(response.status);
      break;
    }

    // Refuse to buffer something pathological. The largest real section is 50 CFR 17.95 at
    // 5,010,215 B; the ceiling is above that with room, and a side over it is reported as a
    // failure rather than being allowed to decide how much of the isolate it gets.
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > DIFF_MAX_BYTES_PER_SIDE) {
      return {
        kind: FetchOutcomeKind.Failed,
        reason: declaredSizeOverCeilingReason(declared, DIFF_MAX_BYTES_PER_SIDE),
        status: response.status,
      };
    }

    const xml = await response.text();
    if (xml.length > DIFF_MAX_BYTES_PER_SIDE) {
      return {
        kind: FetchOutcomeKind.Failed,
        reason: decodedSizeOverCeilingReason(xml.length),
        status: response.status,
      };
    }

    return { kind: FetchOutcomeKind.Ok, xml, bytes: xml.length };
  }

  return { kind: FetchOutcomeKind.Failed, reason: lastReason, status: lastStatus };
}

interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter rather than a fixed multiplier because the 429 is a shared token bucket: if
 * every retrying client waits the same computed interval they re-collide, and the bucket
 * never gets a chance to refill.
 */
function backoff(policy: RetryPolicy, attempt: number): number {
  const ceiling = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
  return Math.floor(Math.random() * ceiling);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
