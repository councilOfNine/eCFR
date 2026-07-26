/**
 * /v1/overlap — shared jurisdiction, as a first-class resource.
 *
 * 17 of the corpus's 487 CFR references name a scope that another agency also names, some by
 * as many as six agencies. That is a finding, not an inconvenience: someone researching who
 * they need to petition to change 42 CFR I needs to know it is jointly run by IHS and PHS.
 *
 * It is also the arithmetic that broke the predecessor, which counted each shared scope in
 * full for every claimant and then summed the per-agency totals into a corpus figure. Here the
 * even split is published explicitly, per scope, so anyone can check the deduplicated total
 * rather than take it on trust.
 */

import { displayCitation, ecfrUrl, parseRefKey, unavailable } from '@ecfr-atlas/core';
import type { WordCount } from '@ecfr-atlas/core/api-schemas';
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { scopeUnmeasuredReason } from '../constants/messages.js';
import { getAgencyNames } from '../db/agencies.js';
import { listOverlaps, parseAgencySlugs } from '../db/overlap.js';
import { CountMethod, WordCountStatus } from '../enums.js';
import type { AppEnv } from '../env.js';
import { OverlapOut, OverlapQuerySchema, paginated } from '../schemas.js';
import { scopeShares, toWordCount } from '../wire.js';
import { clampLimit, commonErrors, pageMeta } from './shared.js';

const OverlapListOut = paginated(OverlapOut);

const route = createRoute({
  method: 'get',
  path: '/overlap',
  tags: ['Shared jurisdiction'],
  summary: 'CFR scopes claimed by more than one agency',
  description:
    'Each row is one scope and every agency that claims it, in the canonical order the split ' +
    'uses. Each claimant carries the `share` that went into its own deduplicated total: ' +
    'floor(words / claimants), with the remainder distributed one word each to the first few ' +
    "claimants in that order, so the shares sum to exactly the scope's `word_count` — sum " +
    'them and check. A share is a full measurement envelope like every other count here: when ' +
    'the scope itself is unmeasured, every share is `words: null` with a reason, because a ' +
    'share of an unknown is an unknown.',
  request: { query: OverlapQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: OverlapListOut } },
      description: 'A page of shared scopes.',
    },
    ...commonErrors,
  },
});

export function registerOverlapRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const { limit: requested, offset, title, min_agencies, sort } = c.req.valid('query');
    const limit = clampLimit(requested, c.get('principal').tier);

    const { rows, total } = await listOverlaps(c.env.DB, {
      limit,
      offset,
      sort,
      ...(title !== undefined ? { title } : {}),
      ...(min_agencies !== undefined ? { minAgencies: min_agencies } : {}),
    });

    // Resolve every slug on the page in one round trip.
    const slugs = new Set<string>();
    for (const row of rows) for (const slug of parseAgencySlugs(row.agency_slugs)) slugs.add(slug);
    const names = await getAgencyNames(c.env.DB, [...slugs]);

    return c.json(
      {
        data: rows.map((row) => {
          const scope = parseRefKey(row.ref_key);
          // `agency_slugs` is stored in the canonical order the pipeline split the scope in
          // (sortable_name, then slug), so share i belongs to claimant i. `scopeShares`
          // refuses to attribute anything if that array and `agency_count` disagree.
          const claimants = parseAgencySlugs(row.agency_slugs);
          const shares = scopeShares(row.word_count, claimants, row.agency_count);
          return {
            ref_key: row.ref_key,
            title: row.title_number,
            display: displayCitation(scope),
            ecfr_url: ecfrUrl(scope),
            agency_count: row.agency_count,
            agencies: claimants.map((slug, index) => ({
              slug,
              display_name: names.get(slug) ?? slug,
              share: shares[index] as WordCount,
            })),
            word_count:
              row.word_count === null
                ? toWordCount(
                    unavailable(WordCountStatus.NotComputed, scopeUnmeasuredReason(row.ref_key)),
                  )
                : toWordCount({
                    known: true,
                    words: row.word_count,
                    status: WordCountStatus.RolledUp,
                    method: CountMethod.DescendantSum,
                  }),
          };
        }),
        page: pageMeta(limit, offset, total),
      },
      200,
    );
  });
}
