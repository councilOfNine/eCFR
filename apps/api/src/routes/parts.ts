/**
 * /v1/parts/{citation} — part metadata plus a pointer to its rendered text in R2.
 *
 * The text itself is NOT in D1 and never will be: six sections exceed D1's 2,000,000-byte row
 * cap (largest 50 CFR 17.95 at 5,010,215 B) and 36 parts do too, the largest being 26 CFR
 * Part 1 at 69,598,633 B. Body text lives in R2; this endpoint hands back the key.
 */

import { displayCitation, ecfrUrl, type Scope, scopeContains } from '@ecfr-atlas/core';
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { publicContentUrl } from '../constants/config.js';
import { PART_CITATION_FORMAT_MESSAGE, partNotFoundMessage } from '../constants/messages.js';
import { getPart, getPartChildCounts, getReferencesForTitle } from '../db/titles.js';
import type { AppEnv } from '../env.js';
import { badRequest, notFound } from '../errors.js';
import { PartCitationParam, PartOut } from '../schemas.js';
import { asBool, nodeWordCount } from '../wire.js';
import { withNotFound } from './shared.js';

const route = createRoute({
  method: 'get',
  path: '/parts/{citation}',
  tags: ['Parts'],
  summary: 'One CFR part',
  description:
    'Addressed by the compact `{title}-{part}` form, e.g. `40-60` for 40 CFR Part 60. The full ' +
    'ancestry citation comes back on the response for walking the structure. `agencies` lists ' +
    'every agency whose CFR reference COVERS this part, resolved by scope containment: a ' +
    'chapter-level reference covers every part beneath it.',
  request: { params: PartCitationParam },
  responses: {
    200: { content: { 'application/json': { schema: PartOut } }, description: 'The part.' },
    ...withNotFound,
  },
});

export function registerPartRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const { citation } = c.req.valid('param');

    // The param regex already guarantees this splits into exactly two pieces.
    const separator = citation.indexOf('-');
    const titleNumber = Number.parseInt(citation.slice(0, separator), 10);
    const partId = citation.slice(separator + 1);
    if (!Number.isInteger(titleNumber)) {
      throw badRequest(PART_CITATION_FORMAT_MESSAGE, { citation });
    }

    const node = await getPart(c.env.DB, titleNumber, partId);
    if (!node) {
      throw notFound(partNotFoundMessage(titleNumber, partId), {
        title: titleNumber,
        part: partId,
      });
    }

    const [counts, refs] = await Promise.all([
      getPartChildCounts(c.env.DB, node.citation),
      getReferencesForTitle(c.env.DB, titleNumber),
    ]);

    const partScope: Scope = {
      title: titleNumber,
      ...(node.subtitle_id ? { subtitle: node.subtitle_id } : {}),
      ...(node.chapter_id ? { chapter: node.chapter_id } : {}),
      ...(node.subchapter_id ? { subchapter: node.subchapter_id } : {}),
      part: partId,
    };

    // Containment, not equality. An agency whose reference is `title-40/chapter-I` is
    // responsible for 40 CFR Part 60; matching ref_key strings would miss it entirely, and
    // matching on `chapter` while ignoring a narrower `part` on the same reference is the
    // 12.7x over-credit going the other way. `scopeContains` is the contract's answer.
    const seen = new Set<string>();
    const agencies: { slug: string; display_name: string }[] = [];
    for (const ref of refs) {
      const refScope: Scope = {
        title: titleNumber,
        ...(ref.subtitle_id ? { subtitle: ref.subtitle_id } : {}),
        ...(ref.chapter_id ? { chapter: ref.chapter_id } : {}),
        ...(ref.subchapter_id ? { subchapter: ref.subchapter_id } : {}),
        ...(ref.part_id ? { part: ref.part_id } : {}),
      };
      if (!scopeContains(refScope, partScope)) continue;
      if (seen.has(ref.agency_slug)) continue;
      seen.add(ref.agency_slug);
      agencies.push({ slug: ref.agency_slug, display_name: ref.display_name });
    }

    return c.json(
      {
        citation: node.citation,
        title: titleNumber,
        part: partId,
        label: node.label,
        reserved: asBool(node.reserved),
        subtitle: node.subtitle_id,
        chapter: node.chapter_id,
        subchapter: node.subchapter_id,
        display: displayCitation(partScope),
        ecfr_url: ecfrUrl(partScope),
        word_count: nodeWordCount(node),
        xml_bytes: node.xml_bytes,
        sections_count: counts.sections,
        subparts_count: counts.subparts,
        agencies,
        content: {
          key: node.content_key,
          // `content_key` is written only after a verified PUT, so a non-null key always
          // resolves. `publicContentUrl` returns null when no public base is configured, and a
          // URL we cannot guarantee is better omitted than served broken.
          url: node.content_key
            ? publicContentUrl(c.env.PUBLIC_CONTENT_BASE_URL, node.content_key)
            : null,
        },
      },
      200,
    );
  });
}
