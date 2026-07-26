/**
 * /v1/word-counts — the published figures, with their provenance attached.
 *
 * This is the endpoint the project exists for, and it is the one where the predecessor lied.
 * Three properties are non-negotiable here:
 *
 *   1. Every number arrives inside a `WordCount` with a status. There is no field on this
 *      response that is a bare integer word count.
 *   2. Both totals are published and both are labelled. Attributed counts a shared scope in
 *      full per claimant; deduplicated splits it. Neither is "the" answer.
 *   3. Coverage travels with every row. A total at 0.6 coverage is a lower bound and the
 *      response says so in the data, not in prose a client will not read.
 */

import { fromRow, unavailable } from '@ecfr-atlas/core';
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { corpusTotalUnstatedReason, titleLabel } from '../constants/messages.js';
import { listAgencies } from '../db/agencies.js';
import { getCorpusCounts } from '../db/meta.js';
import { listTitles } from '../db/titles.js';
import { CountMethod, WordCountGroup, WordCountStatus } from '../enums.js';
import type { AppEnv } from '../env.js';
import { WordCountOut, WordCountQuery } from '../schemas.js';
import { rollupWordCount, toWordCount } from '../wire.js';
import { clampLimit, commonErrors, pageMeta } from './shared.js';

const route = createRoute({
  method: 'get',
  path: '/word-counts',
  tags: ['Word counts'],
  summary: 'Published word counts, attributed and deduplicated',
  description:
    'Every figure carries a status. `words: null` means the value is UNKNOWN, not zero — check ' +
    '`status` and `reason` before any arithmetic. `totals.corpus` is the sum over the 49 ' +
    'non-reserved title nodes and is unknown unless every one of them is measured, because a ' +
    'partial sum under-reports and an under-report looks like a plausible number.',
  request: { query: WordCountQuery },
  responses: {
    200: {
      content: { 'application/json': { schema: WordCountOut } },
      description: 'A page of figures, plus corpus totals.',
    },
    ...commonErrors,
  },
});

export function registerWordCountRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const { limit: requested, offset, group, sort } = c.req.valid('query');
    const limit = clampLimit(requested, c.get('principal').tier);
    const counts = await getCorpusCounts(c.env.DB);

    const totals = {
      corpus:
        counts.corpus_words === null
          ? toWordCount(
              unavailable(
                WordCountStatus.NotComputed,
                corpusTotalUnstatedReason(counts.corpus_titles_unknown, counts.titles),
              ),
            )
          : toWordCount({
              known: true,
              words: counts.corpus_words,
              status: WordCountStatus.RolledUp,
              method: CountMethod.DescendantSum,
            }),
      attributed: rollupWordCount(
        counts.attributed_words,
        counts.agencies - counts.attributed_unknown,
        counts.agencies,
      ),
      deduplicated: rollupWordCount(
        counts.deduplicated_words,
        counts.agencies - counts.deduplicated_unknown,
        counts.agencies,
      ),
    };

    if (group === WordCountGroup.Title) {
      const titles = await listTitles(c.env.DB);
      const page = titles.slice(offset, offset + limit);

      return c.json(
        {
          data: page.map((row) => {
            const measurement = fromRow(row);
            const words = toWordCount(measurement);
            return {
              group: WordCountGroup.Title,
              id: String(row.number),
              label: titleLabel(row.number, row.name),
              // A title has no notion of shared jurisdiction: it is the physical corpus, not
              // an attribution of it. The two figures are therefore identical here, and
              // saying so explicitly is better than omitting one and leaving a client to
              // guess whether the omission meant zero.
              attributed: words,
              deduplicated: words,
              coverage: {
                refs_total: 1,
                refs_counted: measurement.known ? 1 : 0,
                pct: measurement.known ? 1 : 0,
              },
              href: `/v1/titles/${row.number}/structure`,
            };
          }),
          page: pageMeta(limit, offset, titles.length),
          totals,
        },
        200,
      );
    }

    // Every value the query schema allows is also a valid agency sort key, so this passes
    // straight through — the allowlist lives in db/agencies.ts and nowhere else.
    const { rows, total } = await listAgencies(c.env.DB, { limit, offset, sort });

    return c.json(
      {
        data: rows.map((row) => {
          const refsTotal = row.refs_total ?? 0;
          const refsCounted = row.refs_counted ?? 0;
          return {
            group: WordCountGroup.Agency,
            id: row.slug,
            label: row.display_name,
            attributed: rollupWordCount(row.attributed_word_count, refsCounted, refsTotal),
            deduplicated: rollupWordCount(row.deduplicated_word_count, refsCounted, refsTotal),
            coverage: {
              refs_total: refsTotal,
              refs_counted: refsCounted,
              pct: row.coverage_pct ?? 0,
            },
            href: `/v1/agencies/${row.slug}`,
          };
        }),
        page: pageMeta(limit, offset, total),
        totals,
      },
      200,
    );
  });
}
