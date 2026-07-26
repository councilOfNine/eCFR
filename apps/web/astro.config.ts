import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

import { SITE } from './src/constants/site';

/**
 * Prerender-first, and in this app that means prerender-only.
 *
 * The predecessor SPA scored 87 on mobile PageSpeed with a 3,081 ms LCP because every page
 * booted a bundle and then fetched its own data. The identical content as static HTML measured
 * 795 ms / 100. So there is no `export const prerender = false` anywhere in src/pages: every
 * figure on every page is resolved in Node at build time by src/data, and the browser receives
 * finished HTML.
 *
 * The Cloudflare adapter is still configured. It costs nothing while all routes are static, and
 * it means adding a genuinely dynamic route later is a one-line change in that route rather
 * than a platform migration. The dynamic surface of this project — /diff, the API keys, the
 * OpenAPI document — lives in apps/api, a separately deployed Worker.
 */
export default defineConfig({
  // Overridable per deployment via PUBLIC_SITE_URL; src/constants/site.ts reads process.env
  // here (the config runs in plain Node) and import.meta.env inside the Vite-built pages.
  site: SITE.canonicalOrigin,
  output: 'static',

  adapter: cloudflare({
    // No sharp, no runtime image resizing, no image CDN. The site has no raster images on any
    // critical path; charts are HTML and CSS. Passthrough keeps the build dependency-free.
    imageService: 'passthrough',

    // REQUIRED, and the reason is not obvious. @astrojs/cloudflare 14 defaults to running the
    // prerender pass inside workerd so that prerendered pages see the same runtime as
    // on-demand ones. This app's data layer reads a snapshot directory or a local D1 sqlite
    // file off disk during the build — `node:fs/promises` and `node:sqlite` — and workerd has
    // neither, so the default fails at `getStaticPaths` with `No such module "node:fs"`.
    // Prerendering in Node is correct here regardless: the build is an offline data-processing
    // job, not a request, and nothing it does will ever run in a Worker.
    prerenderEnvironment: 'node',
  }),

  // Canonical URLs have no trailing slash; `format: 'directory'` still emits
  // `about/index.html`, which Workers Static Assets resolves for `/about` under the default
  // `auto-trailing-slash` handling. One HTML file per page either way — and file count is a
  // hard constraint here (18,000 CI ceiling against a 20,000 platform cap).
  trailingSlash: 'never',
  build: { format: 'directory' },

  // Astro's prefetch script is deliberately not enabled. It is client JS on every page for a
  // navigation win we do not need when documents are this small and cached at the edge.
  prefetch: false,

  compressHTML: true,

  vite: {
    plugins: [tailwindcss()],
    // @ecfr-atlas/core resolves to raw .ts via its exports map. Both flags keep Vite treating
    // it as first-party source instead of trying to pre-bundle a workspace symlink.
    optimizeDeps: { exclude: ['@ecfr-atlas/core'] },
    ssr: { noExternal: ['@ecfr-atlas/core'] },
  },
});
