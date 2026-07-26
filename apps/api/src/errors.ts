/**
 * One error shape for the whole API.
 *
 * Every failure path — thrown, validated, or unhandled — funnels through here so a client can
 * write one error branch. The response body matches `ApiError` from @ecfr-atlas/core/api-schemas
 * and every error carries the request id that also appears in the `X-Request-Id` header, so a
 * bug report can be joined to a trace.
 */

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { docsUrl } from './constants/config.js';
import {
  INTERNAL_ERROR_MESSAGE,
  routeNotFoundMessage,
  validationFailedMessage,
} from './constants/messages.js';
import { ErrorCode } from './enums.js';
import type { AppEnv } from './env.js';

export { ErrorCode };

export interface ApiErrorInit {
  status: ContentfulStatusCode;
  code: ErrorCode;
  message: string;
  /** Machine-readable specifics. Must never contain a secret, a raw IP, or a key. */
  details?: Record<string, unknown>;
  /** Extra response headers, e.g. Retry-After on a 429. */
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.headers = init.headers;
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError({ status: 400, code: ErrorCode.BadRequest, message, details });

export const notFound = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError({ status: 404, code: ErrorCode.NotFound, message, details });

export const unauthorized = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError({ status: 401, code: ErrorCode.Unauthorized, message, details });

export const forbidden = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError({ status: 403, code: ErrorCode.Forbidden, message, details });

export const upstreamUnavailable = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError({ status: 503, code: ErrorCode.UpstreamUnavailable, message, details });

interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details: Record<string, unknown> | null;
    request_id: string;
    docs: string;
  };
}

function body(
  code: ErrorCode,
  message: string,
  requestId: string,
  docsUrl: string,
  details?: Record<string, unknown>,
): ErrorBody {
  return {
    error: { code, message, details: details ?? null, request_id: requestId, docs: docsUrl },
  };
}

/**
 * Hono's `onError`. Three cases, in order of how much we know about the failure.
 *
 * The last case deliberately does NOT put `err.message` in the response: an unexpected throw
 * from D1 or the R2 SDK can carry a query fragment or a bucket path, and a public API is not
 * the place to find that out. The message goes to the log with the request id attached.
 */
export function onError(err: Error, c: Context<AppEnv>): Response {
  const requestId = c.get('requestId') ?? 'unknown';
  const docs = docsUrl(c.env.DOCS_URL);

  if (err instanceof ApiError) {
    const res = c.json(body(err.code, err.message, requestId, docs, err.details), err.status);
    for (const [k, v] of Object.entries(err.headers ?? {})) res.headers.set(k, v);
    return res;
  }

  if (err instanceof HTTPException) {
    // Raised by Hono itself (malformed JSON body, unsupported method). The status is
    // meaningful; the message is framework text and safe to pass through.
    const code: ErrorCode = err.status === 404 ? ErrorCode.NotFound : ErrorCode.BadRequest;
    return c.json(body(code, err.message, requestId, docs), err.status);
  }

  console.error(
    JSON.stringify({
      level: 'error',
      request_id: requestId,
      path: new URL(c.req.url).pathname,
      message: err.message,
      stack: err.stack,
    }),
  );

  return c.json(body(ErrorCode.InternalError, INTERNAL_ERROR_MESSAGE, requestId, docs), 500);
}

export function onNotFound(c: Context<AppEnv>): Response {
  return c.json(
    body(
      ErrorCode.NotFound,
      routeNotFoundMessage(c.req.method, new URL(c.req.url).pathname),
      c.get('requestId') ?? 'unknown',
      docsUrl(c.env.DOCS_URL),
    ),
    404,
  );
}

/**
 * `defaultHook` for @hono/zod-openapi: turns a request-validation failure into the same
 * envelope as everything else, with the offending field paths spelled out. Without this the
 * framework emits a raw ZodError dump, which is both ugly and a different shape from every
 * other error the API can return.
 */
export function validationHook(
  result: { success: boolean; error?: unknown; target?: string },
  // Unused: throwing lets `onError` build the envelope, which keeps the request id and header
  // handling in exactly one place. The parameter stays because the framework passes it and
  // the signature has to match.
  _c: Context<AppEnv>,
): Response | undefined {
  if (result.success) return undefined;

  const issues = extractIssues(result.error);
  throw new ApiError({
    status: 400,
    code: ErrorCode.BadRequest,
    message: validationFailedMessage(
      result.target ?? 'request',
      issues.length === 1 && issues[0] ? issues[0] : null,
    ),
    details: { issues },
  });
}

interface Issue {
  path: string;
  message: string;
}

/**
 * Pull `{path, message}` out of a ZodError without importing zod's error type, which differs
 * between zod majors and is not worth coupling the error handler to.
 */
function extractIssues(error: unknown): Issue[] {
  if (typeof error !== 'object' || error === null) return [];
  const candidate = (error as { issues?: unknown }).issues;
  if (!Array.isArray(candidate)) return [];
  return candidate.slice(0, 20).map((raw): Issue => {
    const issue = raw as { path?: unknown; message?: unknown };
    const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
    return { path, message: typeof issue.message === 'string' ? issue.message : 'invalid' };
  });
}
