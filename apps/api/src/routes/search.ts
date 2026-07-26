/**
 * /v1/search — one box, two questions.
 *
 * A citation ("40 CFR 60") is resolved exactly. A name ("environmental protection") is a
 * substring search. Both go through parameterised SQL with LIKE metacharacters escaped; the
 * citation patterns are static, anchored, and length-bounded, and nothing in the path builds a
 * regular expression out of the query.
 */

import { displayCitation, ecfrUrl, fromRow, type Scope } from '@ecfr-atlas/core';
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { titleLabel } from '../constants/messages.js';
import {
  type NodeHitRow,
  parseCitationQuery,
  resolveCitation,
  searchAgencies,
  searchNodes,
  searchTitles,
} from '../db/search.js';
import { SEARCHABLE_NODE_TYPES, SearchHitKind, SearchKind, StructureNodeType } from '../enums.js';
import type { AppEnv } from '../env.js';
import { SearchOut, SearchQuery } from '../schemas.js';
import { rollupWordCount, toWordCount } from '../wire.js';
import { commonErrors } from './shared.js';

const route = createRoute({
  method: 'get',
  path: '/search',
  tags: ['Search'],
  summary: 'Find an agency, title, chapter, or part by name or citation',
  description:
    'Recognised citation forms: `40 CFR 60.1`, `40 CFR Part 60`, `40 CFR 60`, `40 CFR Chapter I`, ' +
    '`title 40`, and the canonical `title-40/chapter-I/part-60`. Anything else is treated as a ' +
    'name and matched as a substring. When the query parses as a citation, `interpreted_as` ' +
    'shows exactly how it was read.',
  request: { query: SearchQuery },
  responses: {
    200: { content: { 'application/json': { schema: SearchOut } }, description: 'Ranked hits.' },
    ...commonErrors,
  },
});

type Hit = {
  kind: SearchHitKind;
  id: string;
  display: string;
  label: string | null;
  title: number | null;
  href: string;
  ecfr_url: string | null;
  word_count: ReturnType<typeof toWordCount> | null;
};

export function registerSearchRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const { q, limit, kind } = c.req.valid('query');
    const parsed = parseCitationQuery(q);
    const hits: Hit[] = [];

    // A recognised citation goes first and unconditionally: somebody who typed a citation
    // knows what they want, and burying the exact node under fuzzy name matches is the kind
    // of "helpful" that costs a researcher a minute every time.
    if (parsed && kind !== SearchKind.Agency) {
      const node = await resolveCitation(c.env.DB, parsed);
      if (node) hits.push(nodeHit(node));
    }

    if (kind === SearchKind.All || kind === SearchKind.Agency) {
      for (const row of await searchAgencies(c.env.DB, q, limit)) {
        hits.push({
          kind: SearchHitKind.Agency,
          id: row.slug,
          display: row.display_name,
          label: row.name,
          title: null,
          href: `/v1/agencies/${row.slug}`,
          ecfr_url: null,
          word_count: rollupWordCount(
            row.deduplicated_word_count,
            row.refs_counted ?? 0,
            row.refs_total ?? 0,
          ),
        });
      }
    }

    if (kind === SearchKind.All || kind === SearchKind.Title) {
      for (const row of await searchTitles(c.env.DB, q, limit)) {
        hits.push({
          kind: SearchHitKind.Title,
          id: String(row.number),
          display: titleLabel(row.number, row.name),
          label: row.name,
          title: row.number,
          href: `/v1/titles/${row.number}/structure`,
          ecfr_url: ecfrUrl({ title: row.number }),
          word_count: null,
        });
      }
    }

    if (kind === SearchKind.All || kind === SearchKind.Node) {
      for (const row of await searchNodes(c.env.DB, q, limit)) {
        // Skip the node the citation parser already returned, so an exact hit is not listed
        // twice with different ranking.
        if (hits.some((h) => h.id === row.citation)) continue;
        hits.push(nodeHit(row));
      }
    }

    return c.json(
      {
        query: q,
        interpreted_as: parsed
          ? {
              title: parsed.title,
              subtitle: parsed.subtitle ?? null,
              chapter: parsed.chapter ?? null,
              subchapter: parsed.subchapter ?? null,
              part: parsed.part ?? null,
              section: parsed.section ?? null,
            }
          : null,
        data: hits.slice(0, limit),
      },
      200,
    );
  });
}

function nodeHit(row: NodeHitRow): Hit {
  const scope = scopeForNode(row);

  return {
    kind: hitKindForNode(row.node_type),
    id: row.citation,
    display: displayCitation(scope),
    label: row.label,
    title: row.title_number,
    href:
      row.node_type === StructureNodeType.Part && row.identifier
        ? `/v1/parts/${row.title_number}-${row.identifier}`
        : `/v1/titles/${row.title_number}/structure?parent=${encodeURIComponent(row.citation)}`,
    ecfr_url: ecfrUrl(scope),
    word_count: toWordCount(fromRow(row)),
  };
}

/**
 * The published `kind` for a structure-node hit.
 *
 * `node_type` arrives from D1 as an arbitrary TEXT column, so this is a membership test rather
 * than an exhaustive mapping: a level a newer snapshot introduces is reported at title level
 * instead of throwing. See `scopeForNode` for why that is the right direction to fail.
 */
function hitKindForNode(nodeType: string): SearchHitKind {
  return SEARCHABLE_NODE_TYPES.find((type): boolean => type === nodeType) ?? SearchHitKind.Title;
}

/**
 * Build a `Scope` from a hit row.
 *
 * The search queries select `identifier` rather than the denormalised ancestry columns, so the
 * scope carries only this node's own level. That is sufficient for `displayCitation` and
 * `ecfrUrl`, both of which key on the narrowest level present — the same rule the sync
 * pipeline applies, and the reason a chapter-level reference is never read as if it were the
 * whole title.
 *
 * DELIBERATELY NOT `assertNever` in the default. `node_type` is a TEXT column with a CHECK
 * constraint in D1, not a union the compiler can see, and this API is read against snapshots
 * the sync pipeline writes — including snapshots produced by a newer pipeline than this
 * Worker. An unrecognised level therefore has to degrade to the coarsest scope that is still
 * TRUE (the title the node is in), because a coarser citation is a less precise fact, whereas
 * a thrown `assertNever` here would take /v1/search down for the whole corpus on the day a
 * level is added. The `StructureNodeType.*` cases are the same frozen strings the CHECK
 * constraint enumerates; only the spelling at the call site changed.
 */
function scopeForNode(row: NodeHitRow): Scope {
  const id = row.identifier ?? '';
  switch (row.node_type) {
    case StructureNodeType.Part:
      return { title: row.title_number, part: id };
    case StructureNodeType.Subchapter:
      return { title: row.title_number, subchapter: id };
    case StructureNodeType.Chapter:
      return { title: row.title_number, chapter: id };
    case StructureNodeType.Subtitle:
      return { title: row.title_number, subtitle: id };
    default:
      return { title: row.title_number };
  }
}
