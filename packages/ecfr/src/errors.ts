/**
 * Error taxonomy for the eCFR boundary.
 *
 * The retry loop and the scheduled contract test both branch on these classes, so the
 * distinctions here are load-bearing rather than cosmetic:
 *
 *   - `EcfrHttpError` carries a `retryKind`. That is the ONLY place the two measured upstream
 *     failure modes are told apart. A 162-byte body from bare nginx is HTTP 429 with no
 *     Retry-After and comes back in ~0.13 s; a 246-byte body is an HTTP 504 arriving at ~50 s
 *     because origin XML generation for a large title timed out. The first needs blind
 *     exponential backoff, the second needs patience — isolated sequential title-49 fetches
 *     failed 2 of 4 times, so a 504 is a coin flip, not an error.
 *   - `EcfrContractError` must never be retried and must never be swallowed. It means eCFR
 *     changed a field the pipeline depends on. The nightly contract test keys on this class,
 *     so widening it into a generic parse error would silently disarm that alarm.
 *   - Everything else that is not one of ours is fatal. A bug in our own code must not be
 *     laundered into six retries and a plausible-looking partial result.
 */

import {
  ecfrAbortedMessage,
  ecfrContractFailedMessage,
  ecfrHttpStatusMessage,
  ecfrPayloadTooLargeMessage,
} from '@ecfr-atlas/core';
import type { EcfrSchemaName } from '@ecfr-atlas/core/ecfr-schemas';
import type { ZodError } from 'zod';

/**
 * Derived from `ZodError` rather than importing a named `ZodIssue`, so a Zod minor release
 * that renames the issue type cannot break this package's public surface.
 */
export type EcfrZodIssue = ZodError['issues'][number];

/** Which retry budget a failure is eligible for. `null` means do not retry. */
export type RetryKind = 'rate_limited' | 'gateway' | 'network';

export class EcfrError extends Error {
  /** The absolute request URL, when the failure happened during a request. */
  readonly url: string | undefined;
  /** Total attempts made before giving up. Filled in by the retry loop. */
  attempts = 1;

  constructor(message: string, url?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EcfrError';
    this.url = url;
  }
}

/**
 * A response arrived and parsed as JSON, but did not match the schema in
 * `@ecfr-atlas/core/ecfr-schemas`.
 *
 * The schemas are deliberately loose about unknown keys, so reaching this class means a field
 * we actually read changed type, went missing, or went null. Writing anything derived from
 * such a response would put a wrong number into a column that claims to hold a measurement.
 */
export class EcfrContractError extends EcfrError {
  readonly schemaName: EcfrSchemaName;
  readonly issues: readonly EcfrZodIssue[];

  constructor(schemaName: EcfrSchemaName, url: string, issues: readonly EcfrZodIssue[]) {
    const head = issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    super(ecfrContractFailedMessage(schemaName, issues.length, head), url);
    this.name = 'EcfrContractError';
    this.schemaName = schemaName;
    this.issues = issues;
  }
}

export class EcfrHttpError extends EcfrError {
  readonly status: number;
  /**
   * Byte length of the error body. Recorded because it is the cheapest reliable signature of
   * which upstream failure this is: 162 bytes is nginx's bare 429 page, 246 bytes is the
   * gateway-timeout page. Operators grep for these.
   */
  readonly bodyBytes: number;
  readonly bodySnippet: string;
  readonly retryKind: RetryKind | null;
  /** Only ever set if eCFR starts sending one; measured behaviour today is that it does not. */
  readonly retryAfterMs: number | null;

  constructor(
    status: number,
    url: string,
    body: string,
    retryKind: RetryKind | null,
    retryAfterMs: number | null,
  ) {
    super(ecfrHttpStatusMessage(status, url), url);
    this.name = 'EcfrHttpError';
    this.status = status;
    this.bodyBytes = body.length;
    this.bodySnippet = body.slice(0, 512);
    this.retryKind = retryKind;
    this.retryAfterMs = retryAfterMs;
  }

  get notFound(): boolean {
    return this.status === 404;
  }
}

/** Transport-level failure: DNS, connection reset, TLS, or our own per-attempt timeout. */
export class EcfrNetworkError extends EcfrError {
  /** True when our timeout fired rather than the peer failing. */
  readonly timedOut: boolean;

  constructor(message: string, url: string, timedOut: boolean, cause?: unknown) {
    super(message, url, { cause });
    this.name = 'EcfrNetworkError';
    this.timedOut = timedOut;
  }
}

/** The caller's own AbortSignal fired. Never retried — the caller asked us to stop. */
export class EcfrAbortError extends EcfrError {
  constructor(url: string, cause?: unknown) {
    super(ecfrAbortedMessage(url), url, { cause });
    this.name = 'EcfrAbortError';
  }
}

/**
 * A payload exceeded an explicit ceiling.
 *
 * Thrown rather than truncated: a truncated title is a smaller, entirely plausible-looking
 * word count, which is exactly the failure this project exists to prevent.
 */
export class EcfrTooLargeError extends EcfrError {
  readonly bytes: number;
  readonly limitBytes: number;

  constructor(bytes: number, limitBytes: number, url?: string) {
    super(ecfrPayloadTooLargeMessage(bytes, limitBytes), url);
    this.name = 'EcfrTooLargeError';
    this.bytes = bytes;
    this.limitBytes = limitBytes;
  }
}

/** XML could not be parsed into a tree at all. */
export class EcfrParseError extends EcfrError {
  constructor(message: string, cause?: unknown) {
    super(message, undefined, { cause });
    this.name = 'EcfrParseError';
  }
}

/** Classify a thrown value for the retry loop. Anything unrecognised is fatal by design. */
export function retryKindOf(error: unknown): RetryKind | null {
  if (error instanceof EcfrHttpError) return error.retryKind;
  if (error instanceof EcfrNetworkError) return 'network';
  return null;
}
