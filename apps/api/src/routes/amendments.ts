/**
 * /v1/amendments — 478,050 rows of "what changed, when".
 *
 * Filtering is on issue_date, never amendment_date. Both are published on every row because
 * they mean different things and both are useful, but only issue_date can be used to fetch
 * content: they differ in 49.7% of rows and 40.4% of amendment_dates predate eCFR's
 * 2017-01-01 full-text horizon. A `diff_url` is offered only where the pair of issue dates
 * actually exists, so a caller cannot follow a link into a comparison that has no old side.
 */

import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { ECFR_FULLTEXT_HORIZON, ecfrDatedSectionUrl } from '../constants/config.js';
import { INVERTED_ISSUE_WINDOW_MESSAGE } from '../constants/messages.js';
import { getAdjacentIssueDates, listAmendments } from '../db/amendments.js';
import type { AppEnv } from '../env.js';
import { badRequest } from '../errors.js';
import { AmendmentOut, AmendmentQuerySchema, paginated } from '../schemas.js';
import { asBool } from '../wire.js';
import { clampLimit, commonErrors, pageMeta } from './shared.js';

const AmendmentListOut = paginated(AmendmentOut);

const route = createRoute({
  method: 'get',
  path: '/amendments',
  tags: ['Amendments'],
  summary: 'Section-level amendment history',
  description:
    'Ordered newest first by issue_date. eCFR publishes on business days only — 57 issue dates ' +
    'in an 84-day window, zero weekends, median 48 changed sections per day — so a date range ' +
    'that looks sparse probably is not.',
  request: { query: AmendmentQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: AmendmentListOut } },
      description: 'A page of amendments.',
    },
    ...commonErrors,
  },
});

export function registerAmendmentRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const query = c.req.valid('query');
    const limit = clampLimit(query.limit, c.get('principal').tier);

    if (
      query.issue_date_from &&
      query.issue_date_to &&
      query.issue_date_from > query.issue_date_to
    ) {
      throw badRequest(INVERTED_ISSUE_WINDOW_MESSAGE, {
        issue_date_from: query.issue_date_from,
        issue_date_to: query.issue_date_to,
      });
    }

    const { rows, total } = await listAmendments(c.env.DB, {
      limit,
      offset: query.offset,
      ...(query.title !== undefined ? { title: query.title } : {}),
      ...(query.part ? { part: query.part } : {}),
      ...(query.section ? { section: query.section } : {}),
      ...(query.issue_date_from ? { issueDateFrom: query.issue_date_from } : {}),
      ...(query.issue_date_to ? { issueDateTo: query.issue_date_to } : {}),
      substantiveOnly: query.substantive_only === 'true',
      includeRemoved: query.include_removed === 'true',
    });

    // Only when the caller has narrowed to one section: resolving the previous issue date for
    // every row on a 200-row page would be 200 extra queries to decorate a link.
    let previousIssue: string | null = null;
    if (query.section && query.title !== undefined) {
      const adjacent = await getAdjacentIssueDates(
        c.env.DB,
        query.title,
        query.section,
        query.issue_date_to,
      );
      previousIssue = adjacent.previous;
    }

    return c.json(
      {
        data: rows.map((row) => ({
          title: row.title_number,
          section: row.section_identifier,
          amendment_date: row.amendment_date,
          issue_date: row.issue_date,
          part: row.part,
          subpart: row.subpart,
          name: row.name,
          removed: asBool(row.removed),
          substantive: asBool(row.substantive),
          ecfr_url: ecfrDatedSectionUrl(row.issue_date, row.title_number, row.section_identifier),
          diff_url: diffUrl(
            row.title_number,
            row.section_identifier,
            previousIssue,
            row.issue_date,
          ),
        })),
        page: pageMeta(limit, query.offset, total),
      },
      200,
    );
  });
}

/**
 * A diff link, or null.
 *
 * Null whenever there is no earlier issue to compare against, or the earlier issue predates
 * eCFR's full-text horizon. Offering the link anyway would produce a request whose old side
 * cannot exist, and the honest rendering of that — "unavailable" — is a worse experience than
 * simply not offering a link that was never going to work.
 */
function diffUrl(title: number, section: string, from: string | null, to: string): string | null {
  if (!from || from >= to || from < ECFR_FULLTEXT_HORIZON) return null;
  const params = new URLSearchParams({ title: String(title), section, from, to });
  return `/v1/diff?${params.toString()}`;
}
