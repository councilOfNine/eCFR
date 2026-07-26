/**
 * /docs — the rendered API reference.
 *
 * The docs page is the product's front door for developers, which is why the anonymous tier
 * has a real quota rather than a token one: every example on this page must run for a first-
 * time visitor who has not signed up for anything.
 *
 * The Scalar renderer is SELF-HOSTED, from this origin, and no external host appears anywhere
 * on this page.
 *
 * It used to be `<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference">` — no
 * version, no integrity hash — with that host allowlisted in `script-src`. Whatever the CDN
 * decided that package name meant on any given day executed in every reader's browser, on a
 * public endpoint of an API that mints credentials, and nothing on the page could have
 * noticed. Pinning a version with an SRI hash would have closed the tampering hole and left
 * the availability one; serving the bundle ourselves closes both, and Workers Static Assets
 * cost nothing and do not count against the Worker's script size.
 *
 * The bundle is copied out of node_modules by scripts/vendor-scalar.ts, from the version
 * pinned in pnpm-lock.yaml, and is not committed. See that file for why.
 *
 * The page still degrades to a readable static explanation with a link to the raw spec if the
 * script does not load, so a locked-down network — or a deploy where the vendor step was
 * skipped — gets something usable rather than a blank page.
 */

import { ECFR_BASE_URL, TIERS } from './constants/config.js';

/**
 * The pinned @scalar/api-reference version.
 *
 * Only used to bust caches: the asset is served with `immutable` for a year (public/_headers),
 * so the query string is what makes an upgrade visible to a returning reader. test/docs.test.ts
 * asserts this matches the devDependency in package.json, so a bump cannot half-land.
 */
export const SCALAR_VERSION = '1.63.0';

/**
 * Path of the vendored bundle, relative to this origin.
 *
 * Written by scripts/vendor-scalar.ts into apps/api/public/dist/, which wrangler.jsonc
 * publishes as static assets. `dist` because it is build output and because that is the
 * segment the repository's ignore lists already cover — see the note in that script.
 */
export const SCALAR_ASSET_PATH = '/dist/scalar-api-reference.js';

/**
 * CSP for the docs page specifically.
 *
 * `script-src` is `'self'` plus a nonce for the inline configuration block, and NOTHING else —
 * there is no host to allowlist any more. `unsafe-inline` for style is required by the
 * renderer, which injects its own stylesheet; that is a far smaller surface than executable
 * code from a third party, and `default-src 'none'` keeps everything not named here blocked.
 * Fonts are limited to this origin and data: URIs, so the renderer falls back to system fonts
 * rather than reaching Google Fonts.
 */
export function docsCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data:",
    // The "try it" panel calls this API and nothing else.
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export function docsPage(nonce: string, specUrl: string): string {
  const tierRows = Object.values(TIERS)
    .map(
      (tier) =>
        `<tr><td><code>${tier.tier}</code></td><td>${tier.dailyQuota.toLocaleString('en-US')}/day</td><td>${tier.burstPerMinute}/min</td><td>${escapeHtml(tier.description)}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>eCFR Atlas API</title>
<link rel="alternate" type="application/json" href="${escapeHtml(specUrl)}" title="OpenAPI specification">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  noscript .fallback, .fallback { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem; }
  table { border-collapse: collapse; margin: 1rem 0; width: 100%; }
  th, td { text-align: left; padding: 0.4rem 0.75rem; border-bottom: 1px solid rgba(128,128,128,0.3); vertical-align: top; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .warn { border-left: 3px solid #c2410c; padding-left: 1rem; }
</style>
</head>
<body>
<div class="fallback" id="fallback">
  <h1>eCFR Atlas API</h1>
  <p>An open, measured atlas of the US Code of Federal Regulations. Machine-readable
     specification: <a href="${escapeHtml(specUrl)}"><code>${escapeHtml(specUrl)}</code></a>.</p>

  <h2 class="warn">Read this before you sum anything</h2>
  <p>No word count in this API is a bare number. Every one arrives as
     <code>{ "words": …, "status": …, "reason": …, "method": … }</code>, and
     <code>words: null</code> means <strong>unknown</strong> — it does not mean zero. Filter on
     <code>status</code> before any arithmetic. Aggregates also carry a
     <code>coverage</code> fraction; a total at 0.6 coverage is a lower bound, not a
     measurement.</p>
  <p>Two totals are published for every agency and both are labelled.
     <em>Attributed</em> counts a scope in full for every agency that claims it, which answers
     "what is this agency responsible for?" — those figures do not sum to the corpus.
     <em>Deduplicated</em> splits shared scopes evenly so the corpus total is conserved. 17 of
     the 487 CFR references are shared by 2–6 agencies; see <code>/v1/overlap</code>.</p>

  <h2>Rate limits</h2>
  <table>
    <thead><tr><th>Tier</th><th>Daily quota</th><th>Burst</th><th></th></tr></thead>
    <tbody>${tierRows}</tbody>
  </table>
  <p>No key needed to start. Send one as <code>Authorization: Bearer ecfr_…</code> once you
     have it. Every response carries <code>RateLimit-Limit</code>,
     <code>RateLimit-Remaining</code> and <code>RateLimit-Reset</code>.</p>

  <h2>Attribution</h2>
  <p>Source data is the <a href="${escapeHtml(ECFR_BASE_URL)}">Electronic Code of Federal
     Regulations</a>. Every resource links back to its canonical eCFR URL and every response
     carries an <code>X-Ecfr-Source-Date</code> header giving eCFR's own snapshot date — which
     is what you should cite, not the time you made the request.</p>
</div>

<script id="api-reference" data-url="${escapeHtml(specUrl)}" nonce="${nonce}"></script>
<script nonce="${nonce}">
  // Hide the static fallback only once the renderer has actually loaded, so a page whose
  // script was blocked — or a deploy where the vendor step was skipped — stays readable
  // rather than going blank.
  window.addEventListener('load', function () {
    if (document.querySelector('.scalar-app, [data-v-app]')) {
      var el = document.getElementById('fallback');
      if (el) el.hidden = true;
    }
  });
</script>
<!-- Served from this origin as a Workers static asset. No third-party host, by design. -->
<script src="${SCALAR_ASSET_PATH}?v=${encodeURIComponent(SCALAR_VERSION)}"></script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
