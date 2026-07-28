/**
 * /v1/meta — the freshness and provenance endpoint.
 *
 * Anyone citing a figure from this API in a rulemaking comment needs three things: what the
 * number is, when the government published the underlying text, and how complete our
 * measurement of it was. The first two are `source_date` and `published_run_id`; the third is
 * `unknown_by_status`, which is the data-quality ledger published rather than hidden.
 *
 * `published_run_id` only advances when a sync run passes the publish gate, so a failed sync
 * shows up here as an unchanged date — stale but correct — instead of as missing rows.
 */

import { unavailable } from '@ecfr-atlas/core';
import type { WordCount } from '@ecfr-atlas/core/api-schemas';
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { ECFR_BASE_URL, TIERS } from '../constants/config.js';
import {
  corpusAgenciesUncountedReason,
  corpusUnknownReason,
  NO_AGENCIES_REASON,
} from '../constants/messages.js';
import { getAppMeta, getCorpusCounts, getUnknownNodeBreakdown } from '../db/meta.js';
import { API_TIERS, CountMethod, WordCountStatus } from '../enums.js';
import type { AppEnv } from '../env.js';
import { MetaOut } from '../schemas.js';
import { toWordCount } from '../wire.js';
import { commonErrors } from './shared.js';

interface SyncRunRow {
  id: number;
  kind: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  source_date: string | null;
  titles_touched: number;
  fetch_failures: number;
  parse_failures: number;
}

const route = createRoute({
  method: 'get',
  path: '/meta',
  tags: ['Meta'],
  summary: 'Freshness, corpus totals, and tier limits',
  description:
    "Call this first. `source_date` is eCFR's own snapshot date for the published data — not " +
    'the time you made the request, and not the time we fetched. eCFR publishes on business ' +
    'days only, so an unchanged date over a weekend is expected.',
  responses: {
    200: {
      content: { 'application/json': { schema: MetaOut } },
      description: 'Publication state and corpus counters.',
    },
    ...commonErrors,
  },
});

/**
 * A corpus total, explained at corpus altitude.
 *
 * The per-agency helper in wire.ts reasons about one agency's claimed scopes. These figures sum
 * over agencies, so an unknown here means "some agency has no measured total", never "this
 * agency claims nothing".
 */
function corpusRollup(words: number | null, unknownAgencies: number, agencies: number): WordCount {
  if (words !== null) {
    return toWordCount({
      known: true,
      words,
      status: WordCountStatus.RolledUp,
      method: CountMethod.DescendantSum,
    });
  }
  return toWordCount(
    unavailable(
      WordCountStatus.NotComputed,
      agencies === 0
        ? NO_AGENCIES_REASON
        : corpusAgenciesUncountedReason(unknownAgencies, agencies),
    ),
  );
}

export function registerMetaRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const [meta, counts, unknownByStatus] = await Promise.all([
      getAppMeta(c.env.DB),
      getCorpusCounts(c.env.DB),
      getUnknownNodeBreakdown(c.env.DB),
    ]);

    const lastRun =
      meta.published_run_id === null
        ? null
        : await c.env.DB.prepare(
            `SELECT id, kind, status, started_at, finished_at, source_date,
                    titles_touched, fetch_failures, parse_failures
               FROM sync_run WHERE id = ?`,
          )
            .bind(meta.published_run_id)
            .first<SyncRunRow>();

    const corpusWords =
      counts.corpus_words === null
        ? toWordCount(
            unavailable(
              WordCountStatus.NotComputed,
              corpusUnknownReason(counts.corpus_titles_unknown, counts.titles),
            ),
          )
        : toWordCount({
            known: true,
            words: counts.corpus_words,
            status: WordCountStatus.RolledUp,
            method: CountMethod.DescendantSum,
          });

    return c.json(
      {
        published_run_id: meta.published_run_id,
        published_at: meta.published_at,
        source_date: meta.source_date,
        schema_version: meta.schema_version,
        source: ECFR_BASE_URL,
        corpus: {
          agencies: counts.agencies,
          titles: counts.titles,
          titles_reserved: counts.titles_reserved,
          parts: counts.parts,
          chapters: counts.chapters,
          sections: counts.sections,
          cfr_references: counts.cfr_references,
          shared_scopes: counts.shared_scopes,
          structure_nodes: counts.structure_nodes,
          amendments: counts.amendments,
          nodes_with_unknown_counts: counts.nodes_with_unknown_counts,
          // The bare nullable integers core's MetaResponse declares, kept for compatibility…
          total_words_attributed: counts.attributed_words,
          total_words_deduplicated: counts.deduplicated_words,
          // …and the same figures with the status this API guarantees on every number.
          total_words: corpusWords,
          // NOT rollupWordCount: that derives its reason from ONE AGENCY's scope counters and
          // says "this agency claims no CFR scopes", which is the wrong noun for a figure summed
          // across every agency. An empty database made that visible on the live endpoint.
          total_words_attributed_status: corpusRollup(
            counts.attributed_words,
            counts.attributed_unknown,
            counts.agencies,
          ),
          total_words_deduplicated_status: corpusRollup(
            counts.deduplicated_words,
            counts.deduplicated_unknown,
            counts.agencies,
          ),
          unknown_by_status: unknownByStatus,
        },
        last_run: lastRun,
        tiers: API_TIERS.map((tier) => ({
          tier,
          daily_quota: TIERS[tier].dailyQuota,
          burst_per_minute: TIERS[tier].burstPerMinute,
          max_page_size: TIERS[tier].maxPageSize,
          description: TIERS[tier].description,
        })),
      },
      200,
    );
  });
}
