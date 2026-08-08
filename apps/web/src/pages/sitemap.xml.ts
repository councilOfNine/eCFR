/**
 * Sitemap generated from the same route index the build uses.
 *
 * Written by hand rather than pulled in as an integration for one reason: this way it is
 * physically impossible for it to list a URL that was not emitted, because both come from
 * `routes()`. A sitemap that advertises 404s is worse than no sitemap for a reference tool that
 * people reach through search.
 *
 * The reverse direction — a page that was emitted but is missing from the static list below —
 * is asserted by scripts/check-html.ts against the built output, because it has already
 * happened: the glossary and FAQ shipped as new .astro files with no entry here, and the
 * site's two newest pages were invisible to search until the check existed.
 *
 * ~10,650 URLs, comfortably inside the 50,000-URL / 50 MB per-file limit, so no index file.
 */
import type { APIRoute } from 'astro';
import { SITE } from '../constants/site';
import { atlas } from '../data/load';
import * as route from '../data/routes';

const escapeXml = (value: string): string =>
  value.replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      default:
        return '&quot;';
    }
  });

export const GET: APIRoute = async ({ site }) => {
  const origin = (site ?? new URL(SITE.canonicalOrigin)).origin;
  const data = await atlas();
  const routes = await data.routes();

  const paths: string[] = [
    route.home(),
    route.agencyIndex(),
    route.titleIndex(),
    route.sharedJurisdiction(),
    route.methodology(),
    route.glossary(),
    route.faq(),
    route.dataQuality(),
    route.apiPage(),
    route.about(),
    ...routes.agencies.map((slug) => route.agency(slug)),
    ...routes.titles.map((number) => route.title(number)),
    ...routes.chapters.map((c) => route.chapter(c.title, c.chapter)),
    ...routes.parts.map((p) => route.part(p.title, p.part, p.subpart)),
  ];

  // The source date is the last time any of this content could have changed, so it is the
  // honest lastmod for every URL. Per-page lastmod would need per-node change tracking that the
  // structure fingerprint gives us for parts but not for aggregate pages.
  const lastmod = data.manifest.source_date;

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths
  .map(
    (path) =>
      `  <url><loc>${escapeXml(origin + path)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`,
  )
  .join('\n')}
</urlset>
`;

  return new Response(body, {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
};
