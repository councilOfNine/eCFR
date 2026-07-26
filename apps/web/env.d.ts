/// <reference types="astro/client" />

/**
 * Build-time configuration. Every one of these is read in Node during `astro build`, never in
 * a Worker at request time — rule 4 (no user-facing route calls out to ecfr.gov, and by
 * extension no page reads a database on the request path) depends on all data resolution
 * happening here.
 */
declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * Directory holding the JSON snapshot emitted by scripts/sync. Preferred source: it is the
     * only one that can carry regulation body text, because the text lives in R2 and D1 stores
     * nothing but a pointer to it.
     */
    ECFR_SNAPSHOT_DIR?: string;
    /**
     * Path to a local D1 sqlite file (`.wrangler/state/v3/d1/**\/*.sqlite`). Used when no
     * snapshot is present. Produces every figure the schema can answer; part body text comes
     * back null, and the reader page says so rather than rendering an empty page.
     */
    ECFR_D1_SQLITE?: string;
    /**
     * Set to `1` to force the committed fixture even when one of the above is present.
     * Useful for reproducing a UI bug without a database.
     */
    ECFR_USE_FIXTURE?: string;
    /** Public origin of the API worker, linked from /api and the export controls. */
    PUBLIC_API_ORIGIN?: string;
    /** Deployment-identity overrides consumed by src/constants/site.ts; see .env.example. */
    PUBLIC_SITE_NAME?: string;
    PUBLIC_SITE_TAGLINE?: string;
    PUBLIC_SITE_URL?: string;
    PUBLIC_REPO_URL?: string;
    PUBLIC_CONTACT_EMAIL?: string;
  }
}
