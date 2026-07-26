/**
 * /v1/diff — the one route permitted to touch ecfr.gov, and only on a cache miss.
 *
 * Everything dangerous about this endpoint is handled before the handler body runs:
 *
 *   - `section` is validated against a strict allowlist, not escaped. The predecessor
 *     interpolated `?sections=` into `new RegExp` after escaping only `.`, which was an
 *     unauthenticated ReDoS burning 2,462 ms of CPU on a 1,600-character input.
 *   - `from`/`to` must be issue dates at or after eCFR's 2017-01-01 full-text horizon.
 *     amendment_date differs from issue_date in 49.7% of rows and 40.4% of amendment_dates
 *     predate that horizon, so accepting one would produce an empty old side.
 *   - `from`/`to` must furthermore be dates eCFR ACTUALLY ISSUED, checked against the
 *     `amendment` table before anything is fetched or written. Shape validation alone left
 *     every one of the ~3,500 calendar days since the horizon as a guaranteed cache miss, and
 *     a cache miss is two upstream fetches plus a permanent R2 object. That is an
 *     unauthenticated amplifier pointed at an origin that rate-limits with a token bucket, and
 *     at our own storage bill.
 *   - The old side failing to fetch renders as `unavailable`. It is never rendered as
 *     "section added".
 *   - Anonymous callers are served from the R2 memo but may not spend an upstream fetch.
 *     Rule 4 says user-facing traffic does not reach ecfr.gov; this route is the exception,
 *     and an exception with an open door is not one.
 */

import { createRoute, type OpenAPIHono, type z } from '@hono/zod-openapi';
import {
  DIFF_CACHE_CONTROL,
  DIFF_UNAVAILABLE_CACHE_CONTROL,
  ecfrUserAgent,
  TIERS,
} from '../constants/config.js';
import {
  DIFF_COMPUTE_FORBIDDEN_MESSAGE,
  DIFF_REGISTER_HINT,
  FROM_NOT_BEFORE_TO_MESSAGE,
  ISSUE_DATES_HINT,
  unknownIssueDatesMessage,
} from '../constants/messages.js';
import { knownIssueDates } from '../db/amendments.js';
import { assertIssueDate, assertSectionId, assertTitleNumber } from '../diff/section-id.js';
import { type DiffBody, getDiff } from '../diff/service.js';
import { assertNever, DiffOutcome, DiffStatus, ErrorCode } from '../enums.js';
import type { AppEnv } from '../env.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { DiffOut, DiffQuery, ErrorOut } from '../schemas.js';
import { commonErrors } from './shared.js';

const route = createRoute({
  method: 'get',
  path: '/diff',
  tags: ['Diff'],
  summary: 'Compare one CFR section between two eCFR issue dates',
  description:
    'Both dates must be ISSUE dates that eCFR actually published — take them from ' +
    '/v1/amendments, field `issue_date`. eCFR does not issue one per calendar day (57 issue ' +
    'dates in a recent 84-day window, none on a weekend), and a date it never issued is a 404 ' +
    'here rather than a wasted round trip. They must also be at or after 2017-01-01, ' +
    "eCFR's full-text horizon.\n\n" +
    'Results are memoised permanently, so the first caller for a given comparison pays for it ' +
    'and everyone after is served from cache.\n\n' +
    'If a side cannot be retrieved the response is `status: "unavailable"` with `hunks: []`. ' +
    'That is NOT a statement that the section changed, and it is never reported as an addition.\n\n' +
    'Sections above the inline line cap return `status: "too_large"` with both sides linked.\n\n' +
    'Computing an uncached diff requires a registered key; anonymous callers get cached results ' +
    'and a 403 otherwise.',
  request: { query: DiffQuery },
  responses: {
    200: {
      content: { 'application/json': { schema: DiffOut } },
      description: 'The comparison, cached or freshly computed.',
    },
    403: {
      content: { 'application/json': { schema: ErrorOut } },
      description:
        'This comparison is not cached and your tier may not trigger an upstream fetch. Register for a free key.',
    },
    404: {
      content: { 'application/json': { schema: ErrorOut } },
      description:
        '`from` or `to` is not a date eCFR issued. `error.details.unknown_dates` names which; ' +
        'list the real ones with /v1/amendments.',
    },
    ...commonErrors,
  },
});

export function registerDiffRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const query = c.req.valid('query');

    // Validated again here rather than only in the zod schema. The zod layer bounds the shape;
    // these functions are the allowlist, and they are the same ones the cache key is built
    // from, so there is exactly one definition of "acceptable" between the request and R2.
    const title = assertTitleNumber(query.title);
    const section = assertSectionId(query.section);
    const from = assertIssueDate(query.from, 'from');
    const to = assertIssueDate(query.to, 'to');

    if (from >= to) {
      throw badRequest(FROM_NOT_BEFORE_TO_MESSAGE, { from, to });
    }

    // BEFORE the bucket, before any fetch, before anything is written. See the note at the top
    // of this file: shape validation alone made every arbitrary date a guaranteed cache miss.
    await assertPublishedIssueDates(c.env.DB, from, to);

    const principal = c.get('principal');
    const result = await getDiff(
      { title, section, from, to },
      {
        bucket: c.env.CONTENT,
        mayCompute: TIERS[principal.tier].mayComputeDiff,
        userAgent: ecfrUserAgent(c.env.ECFR_USER_AGENT),
      },
    );

    switch (result.outcome) {
      case DiffOutcome.ComputeNotAllowed:
        throw new ApiError({
          status: 403,
          code: ErrorCode.Forbidden,
          message: DIFF_COMPUTE_FORBIDDEN_MESSAGE,
          details: {
            title,
            section,
            from,
            to,
            how_to_raise: DIFF_REGISTER_HINT,
          },
        });

      case DiffOutcome.Served: {
        // A resolved diff is a pure function of (title, section, from, to), so it is immutable
        // and can be cached hard at the edge. An `unavailable` result is not: it is a transient
        // upstream failure, and the negative memo in R2 already bounds how often we retry.
        c.header(
          'Cache-Control',
          result.body.status === DiffStatus.Unavailable
            ? DIFF_UNAVAILABLE_CACHE_CONTROL
            : DIFF_CACHE_CONTROL,
        );
        c.header('X-Diff-Cache', result.body.cached ? 'hit' : 'miss');

        return c.json(toWire(result.body), 200);
      }

      default:
        return assertNever(result, 'DiffResult');
    }
  });
}

/**
 * Reject any date eCFR did not issue, with one indexed D1 read and nothing else spent.
 *
 * This is the amplification gate. `assertIssueDate` checks shape, calendar validity and the
 * 2017-01-01 horizon — all of which `2019-04-31`-style nonsense fails, and all of which
 * `2019-04-30` passes even though eCFR issued nothing that day. Every such date was a
 * guaranteed miss: two upstream fetches of up to 5 MB against an origin that rate-limits with
 * a token bucket, and a permanent R2 object, per distinct date pair, from any caller holding
 * a free key.
 *
 * The check is against the whole `amendment` table rather than against (title, section):
 * comparing a section that did NOT change between two real issue dates is a legitimate and
 * common query, and answering it "404" would be wrong. What is being validated is the DATE,
 * not the section's history at it.
 *
 * A date eCFR never issued is a 404 rather than a 400: the request is well-formed, the
 * resource simply does not exist. `details` names exactly which side is at fault, because
 * "one of your two dates is wrong" is a maddening error to receive.
 */
async function assertPublishedIssueDates(db: D1Database, from: string, to: string): Promise<void> {
  const published = await knownIssueDates(db, [from, to]);
  const unknown = [
    ...(published.has(from) ? [] : [{ field: 'from', value: from }]),
    ...(published.has(to) ? [] : [{ field: 'to', value: to }]),
  ];
  if (unknown.length === 0) return;

  const which = unknown.map((u) => `\`${u.field}\` (${u.value})`).join(' and ');
  throw notFound(unknownIssueDatesMessage(which, unknown.length), {
    unknown_dates: unknown,
    how_to_find_dates: ISSUE_DATES_HINT,
  });
}

/**
 * Internal camelCase -> wire snake_case.
 *
 * The diff engine uses JavaScript conventions internally; every other field in this API is
 * snake_case, and a response that mixed the two would be a permanent papercut for consumers.
 * Converting here keeps the boundary in one visible place rather than leaking naming style
 * from the algorithm into the contract.
 */
function toWire(body: DiffBody): z.infer<typeof DiffOut> {
  return {
    ...body,
    hunks: body.hunks.map((hunk) => ({
      old_start: hunk.oldStart,
      old_lines: hunk.oldLines,
      new_start: hunk.newStart,
      new_lines: hunk.newLines,
      lines: hunk.lines.map((line) => ({
        type: line.type,
        text: line.text,
        old_line: line.oldLine,
        new_line: line.newLine,
      })),
    })),
  };
}
