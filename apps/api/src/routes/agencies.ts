/**
 * /v1/agencies — the list every "which agency writes the most regulation?" question starts at.
 *
 * Both totals are published side by side and both are labelled, because which one is correct
 * depends on the question. Attributed answers "what is this agency responsible for?" and
 * counts a shared scope in full for every claimant. Deduplicated answers "how does the CFR
 * divide up?" and splits shared scopes evenly so the corpus total is conserved. The
 * predecessor summed the first kind into a corpus figure and published a CFR larger than
 * the CFR.
 */

import { displayCitation, ecfrUrl, fromRow, parseRefKey } from '@ecfr-atlas/core';
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { agencyNotFoundMessage } from '../constants/messages.js';
import {
  type AgencyRollupRow,
  type AgencyScopeRow,
  getAgency,
  getAgencyChildren,
  getAgencyHistory,
  getAgencyNames,
  getAgencyScopes,
  listAgencies,
} from '../db/agencies.js';
import { parseAgencySlugs } from '../db/overlap.js';
import type { HierarchyLevel } from '../enums.js';
import type { AppEnv } from '../env.js';
import { notFound } from '../errors.js';
import {
  AgencyDetail,
  AgencyListQuery,
  AgencySlugParam,
  AgencySummary,
  paginated,
} from '../schemas.js';
import {
  rollupWordCount,
  subtreeRollupWordCount,
  toWordCount,
  unresolvedScopeWordCount,
} from '../wire.js';
import { clampLimit, commonErrors, pageMeta, withNotFound } from './shared.js';

const AgencyListOut = paginated(AgencySummary);

const listRoute = createRoute({
  method: 'get',
  path: '/agencies',
  tags: ['Agencies'],
  summary: 'List agencies with their word-count rollups',
  description:
    'Every agency eCFR knows about, with both totals and the coverage fraction behind them. ' +
    'Read `coverage.pct` before quoting either number: it is `refs_counted / refs_total`, and ' +
    'a total at 0.6 coverage is a lower bound, not a measurement.',
  request: { query: AgencyListQuery },
  responses: {
    200: {
      content: { 'application/json': { schema: AgencyListOut } },
      description: 'A page of agencies.',
    },
    ...commonErrors,
  },
});

const detailRoute = createRoute({
  method: 'get',
  path: '/agencies/{slug}',
  tags: ['Agencies'],
  summary: 'One agency, with every scope it claims',
  description:
    'Includes the full list of CFR scopes, each resolved to the structure node it names and ' +
    'flagged when another agency claims the same scope. `shared_jurisdiction` is the ' +
    "interesting part: 17 of the corpus's 487 scopes are claimed by 2-6 agencies.",
  request: { params: AgencySlugParam },
  responses: {
    200: {
      content: { 'application/json': { schema: AgencyDetail } },
      description: 'The agency.',
    },
    ...withNotFound,
  },
});

export function registerAgencyRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listRoute, async (c) => {
    const { limit: requested, offset, sort, parent, title, q } = c.req.valid('query');
    const limit = clampLimit(requested, c.get('principal').tier);

    const { rows, total } = await listAgencies(c.env.DB, {
      limit,
      offset,
      sort,
      // `root` is the wire spelling of "no parent"; an empty string in a query param is too
      // easy to send by accident to mean something this specific.
      ...(parent === 'root' ? { parent: null } : parent ? { parent } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(q ? { q } : {}),
    });

    return c.json({ data: rows.map(toAgencySummary), page: pageMeta(limit, offset, total) }, 200);
  });

  app.openapi(detailRoute, async (c) => {
    const { slug } = c.req.valid('param');

    const agency = await getAgency(c.env.DB, slug);
    if (!agency) {
      throw notFound(agencyNotFoundMessage(slug), { slug });
    }

    const [scopes, children, history] = await Promise.all([
      getAgencyScopes(c.env.DB, slug),
      getAgencyChildren(c.env.DB, slug),
      getAgencyHistory(c.env.DB, slug),
    ]);

    // Resolve every co-claimant's display name in one query rather than per scope. 17 shared
    // scopes corpus-wide with up to 6 claimants each, so this is a handful of slugs.
    const coClaimants = new Set<string>();
    for (const scope of scopes) {
      for (const other of parseAgencySlugs(scope.agency_slugs)) {
        if (other !== slug) coClaimants.add(other);
      }
    }
    const names = await getAgencyNames(c.env.DB, [...coClaimants]);

    const scopeOut = scopes.map((scope) => toScope(scope));
    const shared = scopes
      .filter((scope) => (scope.agency_count ?? 1) > 1)
      .map((scope) => ({
        ref_key: scope.ref_key,
        display: displayCitation(parseRefKey(scope.ref_key)),
        word_count: scopeWordCount(scope),
        agencies: parseAgencySlugs(scope.agency_slugs).map((other) => ({
          slug: other,
          name: other === slug ? agency.display_name : (names.get(other) ?? other),
        })),
      }));

    return c.json(
      {
        ...toAgencySummary(agency),
        sortable_name: agency.sortable_name,
        scopes: scopeOut,
        children: children.map(toAgencySummary),
        shared_jurisdiction: shared,
        history: history.map((row) => ({
          snapshot_date: row.snapshot_date,
          attributed: row.attributed_word_count,
          deduplicated: row.deduplicated_word_count,
          coverage_pct: row.coverage_pct,
        })),
      },
      200,
    );
  });
}

export function toAgencySummary(row: AgencyRollupRow) {
  const refsTotal = row.refs_total ?? 0;
  const refsCounted = row.refs_counted ?? 0;
  const childrenCount = row.children_count ?? 0;
  return {
    slug: row.slug,
    name: row.name,
    short_name: row.short_name,
    display_name: row.display_name,
    parent_slug: row.parent_slug,
    children_count: childrenCount,
    attributed: rollupWordCount(row.attributed_word_count, refsCounted, refsTotal),
    deduplicated: rollupWordCount(row.deduplicated_word_count, refsCounted, refsTotal),
    // The subtree columns get their own derivation. Their unknown-ness comes from descendants,
    // not from this agency's own references, so the plain rollup reason would name the wrong
    // cause — see the note on `subtreeRollupWordCount`.
    subtree_attributed: subtreeRollupWordCount(row.subtree_attributed, {
      childrenCount,
      refsCounted,
      refsTotal,
    }),
    subtree_deduplicated: subtreeRollupWordCount(row.subtree_deduplicated, {
      childrenCount,
      refsCounted,
      refsTotal,
    }),
    coverage: {
      refs_total: refsTotal,
      refs_counted: refsCounted,
      pct: row.coverage_pct ?? 0,
    },
    shared_refs: row.shared_refs ?? 0,
  };
}

/**
 * A scope's word count comes from the node it resolved to. When it resolved to nothing — eCFR
 * keeps references to scopes that have been removed from the structure — the answer is "we
 * cannot measure this", with the ref_key named so a reader can check it themselves.
 */
function scopeWordCount(row: AgencyScopeRow) {
  if (row.node_citation === null) return unresolvedScopeWordCount(row.ref_key);
  return toWordCount(fromRow(row));
}

function toScope(row: AgencyScopeRow) {
  const scope = parseRefKey(row.ref_key);
  return {
    ref_key: row.ref_key,
    title: row.title_number,
    subtitle: row.subtitle_id,
    chapter: row.chapter_id,
    subchapter: row.subchapter_id,
    part: row.part_id,
    // Stored, not recomputed: `narrowest_level` is written by the sync pipeline from the same
    // `narrowestLevel()` the site uses, and honouring it is what stops a chapter-level read of
    // a reference that also names a part — the mistake that over-credited one agency 12.7x.
    // The cast is the D1 TEXT column meeting its CHECK constraint, which is the scope
    // vocabulary and not the wider structure-tree one.
    narrowest_level: row.narrowest_level as HierarchyLevel,
    display: displayCitation(scope),
    ecfr_url: ecfrUrl(scope),
    word_count: scopeWordCount(row),
  };
}
