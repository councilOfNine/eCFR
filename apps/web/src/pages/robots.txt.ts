/**
 * robots.txt generated from the same `site` value as every canonical URL and the sitemap.
 *
 * This used to be a static file in public/ with the sitemap URL written out by hand — and it
 * shipped pointing at a domain this site was never deployed to, so crawlers were told to fetch
 * the sitemap from a dead origin. Deriving the URL here makes that class of drift impossible.
 *
 * In production Cloudflare prepends its zone-managed content-signals block (AI-crawler
 * directives) to whatever this emits; both parts are served, and search crawling stays allowed.
 */
import type { APIRoute } from 'astro';
import { SITE } from '../constants/site';

export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL(SITE.canonicalOrigin)).origin;

  const body = `User-agent: *
Allow: /

Sitemap: ${origin}/sitemap.xml
`;

  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
