/**
 * Deployment identity — the handful of values that change when someone stands up their own
 * instance of this site, separated from STRINGS (which changes when the COPY changes).
 *
 * Every override is a `PUBLIC_`-prefixed environment variable, documented in apps/web/.env.example.
 * Defaults are the canonical deployment, so a bare checkout builds something truthful.
 */

/**
 * `import.meta.env` exists wherever Vite processed the module (all of src during `astro build`);
 * astro.config.ts evaluates in plain Node, where only `process.env` exists. Falling through lets
 * this be the single source for both, so the canonical origin cannot drift between the
 * `site` config and the pages that build canonical URLs from it.
 */
const env: Record<string, string | undefined> =
  import.meta.env ?? (typeof process === 'undefined' ? {} : process.env);

export const SITE = {
  /** Shown in the header brand, the tab title suffix and citations. */
  name: env.PUBLIC_SITE_NAME ?? 'eCFR Atlas',
  /** The one-line description beside the brand in the header. */
  tagline: env.PUBLIC_SITE_TAGLINE ?? 'a measured map of federal regulation',
  /** Canonical origin for `<link rel="canonical">`, og:url and the sitemap. No trailing slash. */
  canonicalOrigin: env.PUBLIC_SITE_URL ?? 'https://ecfr-atlas.org',
  /** Public origin of the API Worker (apps/api), linked from /api. Never fetched at runtime. */
  apiOrigin: env.PUBLIC_API_ORIGIN ?? 'https://api.ecfr-atlas.org',
  /** Where the source lives, for attribution and contributing links. */
  repoUrl: env.PUBLIC_REPO_URL ?? 'https://github.com/councilOfNine/eCFR',
  /** Contact for the deployment operator. Null renders no contact affordance. */
  contactEmail: env.PUBLIC_CONTACT_EMAIL ?? null,
  /**
   * The official eCFR home. Not deployment-varying, but centralised here because rule 4 (link
   * to ecfr.gov, never fetch it) makes every occurrence of this URL a link — one constant keeps
   * a typo from quietly pointing a disclaimer at the wrong place.
   */
  ecfrHomeUrl: 'https://www.ecfr.gov',
} as const;
