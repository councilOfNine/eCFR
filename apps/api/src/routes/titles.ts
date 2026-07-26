/**
 * /v1/titles and /v1/titles/{n}/structure.
 *
 * The structure endpoint reads the table of contents out of D1. It never calls ecfr.gov, and
 * that is a correctness constraint before it is a performance one: eCFR's `?chapter=` and
 * `?subtitle=` query parameters VALIDATE but DO NOT SLICE — they return the entire title —
 * so a route that fetched a subtree live would be building on the exact upstream behaviour
 * whose misreading produced the predecessor's fabricated word counts.
 */

import { ecfrUrl } from '@ecfr-atlas/core';
import { createRoute, type OpenAPIHono, type z } from '@hono/zod-openapi';
import { STRUCTURE_MAX_NODES } from '../constants/config.js';
import { parentOutsideTitleMessage, titleNotFoundMessage } from '../constants/messages.js';
import {
  getTitle,
  listTitles,
  queryStructure,
  type StructureRow,
  type TitleRow,
} from '../db/titles.js';
import type { AppEnv } from '../env.js';
import { notFound } from '../errors.js';
import {
  StructureOut,
  StructureQuery,
  TitleListOut,
  TitleNumberParam,
  type TitleOut,
} from '../schemas.js';
import { asBool, nodeWordCount } from '../wire.js';
import { commonErrors, withNotFound } from './shared.js';

const listRoute = createRoute({
  method: 'get',
  path: '/titles',
  tags: ['Titles'],
  summary: 'All 50 CFR titles',
  description:
    'Title 35 is reserved: its three date fields are null and it has no content. Every other ' +
    'title carries the measured word count of its own structure node.',
  responses: {
    200: { content: { 'application/json': { schema: TitleListOut } }, description: 'All titles.' },
    ...commonErrors,
  },
});

const structureRoute = createRoute({
  method: 'get',
  path: '/titles/{n}/structure',
  tags: ['Titles'],
  summary: 'The table of contents for a title',
  description:
    'Served entirely from our database — this endpoint never calls eCFR. Sections are excluded ' +
    "by default because 227,558 of the corpus's 275,271 nodes are sections; scope with " +
    '`parent` first, then set `include_sections=true` on the subtree you care about.',
  request: { params: TitleNumberParam, query: StructureQuery },
  responses: {
    200: {
      content: { 'application/json': { schema: StructureOut } },
      description: 'A forest of nodes, each with its children inlined.',
    },
    ...withNotFound,
  },
});

export function registerTitleRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listRoute, async (c) => {
    const rows = await listTitles(c.env.DB);
    return c.json({ data: rows.map(toTitleOut) }, 200);
  });

  app.openapi(structureRoute, async (c) => {
    const { n } = c.req.valid('param');
    const { parent, include_sections, limit } = c.req.valid('query');

    const title = await getTitle(c.env.DB, n);
    if (!title) throw notFound(titleNotFoundMessage(n), { title: n });

    // `parent` is checked against the title so a caller cannot page through title 40's tree
    // via a title-1 URL and get a confusingly empty result.
    if (parent && !parent.startsWith(`title-${n}`)) {
      throw notFound(parentOutsideTitleMessage(n, parent), { title: n, parent });
    }

    const { rows, truncated } = await queryStructure(c.env.DB, {
      title: n,
      ...(parent ? { parent } : {}),
      includeSections: include_sections === 'true',
      limit: Math.min(limit, STRUCTURE_MAX_NODES),
    });

    return c.json(
      {
        title: n,
        nodes: buildForest(rows),
        node_count: rows.length,
        truncated,
      },
      200,
    );
  });
}

function toTitleOut(row: TitleRow): z.infer<typeof TitleOut> {
  return {
    number: row.number,
    name: row.name,
    // Null for reserved title 35, and for nothing else. Callers must null-guard; this is the
    // one place in the API where that is guaranteed to be visible in the type.
    latest_amended_on: row.latest_amended_on,
    latest_issue_date: row.latest_issue_date,
    up_to_date_as_of: row.up_to_date_as_of,
    reserved: asBool(row.reserved),
    word_count: nodeWordCount(row),
    parts_count: row.parts_count,
    sections_count: row.sections_count,
    ecfr_url: ecfrUrl({ title: row.number }),
  };
}

interface ForestNode {
  citation: string;
  node_type: string;
  identifier: string | null;
  label: string | null;
  reserved: boolean;
  word_count: ReturnType<typeof nodeWordCount>;
  ecfr_url: string;
  children: ForestNode[];
}

/**
 * Rebuild the tree from the flat, citation-ordered rows.
 *
 * A node's citation contains its parent's as a prefix, so ordering by citation is already a
 * pre-order traversal: a parent is always seen before its children, and one pass suffices. A
 * node whose parent is not in the result set (because `parent` scoped the query, or because
 * the limit truncated) becomes a root of the returned forest rather than being dropped.
 */
function buildForest(rows: readonly StructureRow[]): ForestNode[] {
  const byCitation = new Map<string, ForestNode>();
  const roots: ForestNode[] = [];

  for (const row of rows) {
    const node: ForestNode = {
      citation: row.citation,
      node_type: row.node_type,
      identifier: row.identifier,
      label: row.label,
      reserved: asBool(row.reserved),
      word_count: nodeWordCount(row),
      ecfr_url: nodeEcfrUrl(row),
      children: [],
    };
    byCitation.set(row.citation, node);

    const parent = row.parent_citation ? byCitation.get(row.parent_citation) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

/**
 * Link a node back to eCFR.
 *
 * Built from the denormalised ancestry columns rather than by re-parsing the citation, so a
 * node type this API does not model (subject_group, appendix) still links to the nearest
 * addressable ancestor instead of producing a URL that 404s.
 */
function nodeEcfrUrl(row: StructureRow): string {
  return ecfrUrl({
    title: row.title_number,
    ...(row.subtitle_id ? { subtitle: row.subtitle_id } : {}),
    ...(row.chapter_id ? { chapter: row.chapter_id } : {}),
    ...(row.subchapter_id ? { subchapter: row.subchapter_id } : {}),
    ...(row.part_id ? { part: row.part_id } : {}),
  });
}
