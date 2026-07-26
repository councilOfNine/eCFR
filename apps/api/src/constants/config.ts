/**
 * Every tunable number and deployment-varying literal in the API, in one block.
 *
 * The brief asked for the tier limits to be trivially adjustable; the rest of the constants
 * are here for the same reason. If a value governs how much work a request may cause, or
 * would change when this API is deployed under a different name, it belongs in this file and
 * nowhere else. Closed vocabularies (the tier union itself) live in src/enums.ts; strings
 * shown to humans live in src/constants/messages.ts.
 */

import { ApiTier } from '../enums.js';

export interface TierConfig {
  tier: ApiTier;
  /**
   * Requests per UTC day. Enforced by the atomic D1 counter in api_usage_day — that counter,
   * not the rate-limiting binding, is the quota. See src/auth/quota.ts.
   */
  dailyQuota: number;
  /**
   * Requests per 60s, enforced by the Cloudflare rate-limiting binding. Per-location and
   * explicitly not an accounting system, so this is abuse protection and nothing else.
   * MUST equal the matching `simple.limit` in wrangler.jsonc; test/config.test.ts asserts it.
   */
  burstPerMinute: number;
  /** Name of the binding on Env carrying `burstPerMinute`. */
  burstBinding: 'BURST_ANON' | 'BURST_REGISTERED' | 'BURST_ELEVATED';
  /** Page size ceiling. Anonymous callers cannot ask for 200-row pages 500 times a day. */
  maxPageSize: number;
  /** Whether this tier may spend a live ecfr.gov fetch on an uncached /v1/diff. */
  mayComputeDiff: boolean;
  description: string;
}

/**
 * Anonymous is deliberately usable, not decorative: the OpenAPI docs are the product's front
 * door and a reader who has to sign up before the first example runs mostly does not run it.
 * 500/day is roughly a full afternoon of exploring at human speed and nowhere near enough to
 * mirror the corpus, which is what /v1 bulk exports are for.
 */
export const TIERS: Record<ApiTier, TierConfig> = {
  anonymous: {
    tier: ApiTier.Anonymous,
    dailyQuota: 500,
    burstPerMinute: 30,
    burstBinding: 'BURST_ANON',
    maxPageSize: 100,
    // An uncached diff costs two ecfr.gov fetches of up to 5 MB each. Anonymous callers are
    // served from the R2 memo and may not spend our upstream budget; rule 4's whole point is
    // that user-facing traffic does not reach ecfr.gov.
    mayComputeDiff: false,
    description: 'No API key. Enough to explore the docs and run every example on this page.',
  },
  registered: {
    tier: ApiTier.Registered,
    dailyQuota: 25_000,
    burstPerMinute: 120,
    burstBinding: 'BURST_REGISTERED',
    maxPageSize: 200,
    mayComputeDiff: true,
    description: 'Verified email. Enough to build and run an application against the corpus.',
  },
  elevated: {
    tier: ApiTier.Elevated,
    dailyQuota: 500_000,
    burstPerMinute: 600,
    burstBinding: 'BURST_ELEVATED',
    maxPageSize: 500,
    mayComputeDiff: true,
    description: 'Granted on request for research and bulk analysis. Email us.',
  },
};

// ─── pagination ──────────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 50;
/** Absolute ceiling regardless of tier; a tier may cap lower, never higher. */
export const ABSOLUTE_MAX_PAGE_SIZE = 500;

// ─── structure endpoint ──────────────────────────────────────────────────────

/**
 * Title 40 alone has tens of thousands of nodes and the corpus has 275,271. Serving a whole
 * title's section-level tree in one response is a self-inflicted denial of service, so the
 * default stops above sections and the caller opts in per subtree.
 */
export const STRUCTURE_MAX_NODES = 5_000;
export const STRUCTURE_DEFAULT_INCLUDES_SECTIONS = false;

// ─── keys ────────────────────────────────────────────────────────────────────

export const KEY_PREFIX = 'ecfr';
/** Bytes of entropy in the secret half of a key. 32 bytes = 256 bits. */
export const KEY_SECRET_BYTES = 32;
/** Bytes of entropy in a verification token. */
export const VERIFY_TOKEN_BYTES = 32;
/** How long an emailed verification token stays usable. */
export const VERIFY_TOKEN_TTL_SECONDS = 24 * 60 * 60;
/** Refuse to mint key number N+1; stops a compromised account creating unbounded principals. */
export const MAX_KEYS_PER_ACCOUNT = 10;

// ─── usage retention ─────────────────────────────────────────────────────────

/** The nightly cron drops api_usage_day rows older than this. Quota is daily; history is not. */
export const USAGE_RETENTION_DAYS = 90;

// ─── diff ────────────────────────────────────────────────────────────────────

/**
 * Per-section line cap.
 *
 * The predecessor used an O(m*n) LCS table and needed 15.95 GB for 26 CFR 1.72-9 (46,119
 * lines) — a V8 heap abort, which is not a catchable error, which is why the cap is a hard
 * precondition here rather than a try/catch. Myers linear-space diff makes 5,000 lines cheap;
 * the cap exists to bound worst-case CPU on a shared Worker, not to avoid a crash.
 */
export const DIFF_MAX_LINES = 5_000;
/** Lines of unchanged context kept around each change. */
export const DIFF_CONTEXT_LINES = 3;
/**
 * Refuse to even download a side above this. The largest single section in the corpus is
 * 50 CFR 17.95 at 5,010,215 B; two of those plus parse overhead is still well inside a
 * 128 MB isolate, but a pathological future section should not be the thing that finds out.
 */
export const DIFF_MAX_BYTES_PER_SIDE = 8 * 1024 * 1024;
/** eCFR's full-text horizon. Before this, an old side simply does not exist to fetch. */
export const ECFR_FULLTEXT_HORIZON = '2017-01-01';
/** Negative cache TTL for a failed diff, in seconds. Short: 504s here are a coin flip. */
export const DIFF_NEGATIVE_TTL_SECONDS = 15 * 60;
/** R2 prefix for the permanent diff memos. */
export const DIFF_R2_PREFIX = 'diff/v1';

// ─── upstream fetch (only /v1/diff) ──────────────────────────────────────────

/**
 * eCFR rate limiting is a token bucket, not a concurrency gate, and it fails two distinct
 * ways that need different handling:
 *
 *   162-byte body = HTTP 429 from bare nginx, no Retry-After, back in ~0.13s. Blind
 *     exponential backoff with jitter is the only option.
 *   246-byte body = HTTP 504, the origin's XML generation timed out on a large title. Isolated
 *     sequential title-49 fetches failed 2 of 4 times, so this is a coin flip, not an error.
 *     Retry with a longer ceiling.
 */
export const ECFR_BASE_URL = 'https://www.ecfr.gov';
export const ECFR_RETRY_429 = { attempts: 3, baseDelayMs: 250, maxDelayMs: 2_000 };
export const ECFR_RETRY_504 = { attempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000 };
/** Wall-clock ceiling for one upstream fetch. The origin's own 504 lands at ~50s. */
export const ECFR_FETCH_TIMEOUT_MS = 55_000;

// ─── response caching ────────────────────────────────────────────────────────

/**
 * Published data changes at most once a business day (57 issue dates in 84 days, zero
 * weekends), so a minute of edge cache is free correctness-wise and removes most repeat D1
 * reads. `stale-while-revalidate` keeps a slow D1 read off the critical path.
 */
export const DATA_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=600';
/** A resolved diff is immutable: it is a function of (title, section, from, to). */
export const DIFF_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';
/** An `unavailable` diff is transient; the R2 negative memo already bounds retries. */
export const DIFF_UNAVAILABLE_CACHE_CONTROL = 'public, max-age=60';
/** Anything principal-specific must never land in a shared cache. */
export const PRIVATE_CACHE_CONTROL = 'private, no-store';
/** The /docs HTML shell. The bundle behind it is cached immutably via public/_headers. */
export const DOCS_CACHE_CONTROL = 'public, max-age=300';

/** How long the isolate memoises app_meta. Bounded staleness on a once-a-day-changing row. */
export const APP_META_TTL_MS = 60_000;

// ─── deployment-varying literals ─────────────────────────────────────────────
//
// Everything below would change if this API were deployed under another name or domain.
// Wherever an override makes sense the value is env-sourced — the wrangler.jsonc `vars`
// block (per environment) is the override point, and apps/api/.dev.vars.example documents
// the local-development equivalents. The constants here are the in-repo fallbacks, so a
// misconfigured deployment degrades to something true rather than to a broken link.

/** Where this Worker serves its own rendered reference. Path, not URL: always valid. */
export const DOCS_PATH = '/docs';
/** The machine-readable spec, referenced from error bodies and the docs shell. */
export const OPENAPI_SPEC_PATH = '/openapi.json';

/**
 * The `docs` link stamped into every error body. `DOCS_URL` (plain var, wrangler.jsonc) names
 * the public docs origin; the path fallback keeps the link working on previews and local dev
 * where no public hostname exists yet.
 */
export function docsUrl(configured: string | undefined): string {
  return configured || DOCS_PATH;
}

/**
 * A human-facing eCFR link pinned to an ISSUE date.
 *
 * Distinct from core's `ecfrUrl`, which addresses `/current` and therefore says nothing about
 * when. Everything this API publishes is dated, so an amendment row and a diff side both link
 * to the text as it stood, not to whatever is live when the link is clicked.
 */
export function ecfrDatedSectionUrl(issueDate: string, title: number, section: string): string {
  return `${ECFR_BASE_URL}/on/${issueDate}/title-${title}/section-${section}`;
}

/** Source repository. Appears in the OpenAPI `externalDocs` and the default User-Agent. */
export const REPO_URL = 'https://github.com/ecfr-atlas/ecfr-atlas';

/**
 * Operator contact, as embedded in the default User-Agent below. A real deployment overrides
 * the whole User-Agent string via the `ECFR_USER_AGENT` var rather than this address alone —
 * eCFR wants one descriptive string, not components.
 */
export const CONTACT_EMAIL_PLACEHOLDER = 'ops@ecfr-atlas.org';

/**
 * eCFR asks for a descriptive User-Agent with a contact URL, and rate-limits harder without
 * one. `ECFR_USER_AGENT` (plain var) is the per-deployment value; this fallback keeps a
 * deployment that forgot the var polite upstream instead of anonymous.
 */
export const DEFAULT_ECFR_USER_AGENT = `ecfr-atlas/0.1 (+${REPO_URL}; contact: ${CONTACT_EMAIL_PLACEHOLDER})`;

export function ecfrUserAgent(configured: string | undefined): string {
  return configured || DEFAULT_ECFR_USER_AGENT;
}

/**
 * Path on the public site (SITE_ORIGIN, plain var) that consumes a verification token. Null
 * when no site origin is configured: an email with no clickable link is honest, an email with
 * a dead one is not.
 */
export const SITE_VERIFY_PATH = '/api/verify';

export function verifyUrl(siteOrigin: string | undefined, token: string): string | null {
  if (!siteOrigin) return null;
  return `${siteOrigin.replace(/\/$/, '')}${SITE_VERIFY_PATH}?token=${encodeURIComponent(token)}`;
}

/**
 * Public URL for an R2-hosted content object. `PUBLIC_CONTENT_BASE_URL` (plain var) is empty
 * until an R2 public route is configured, and the API then returns `url: null` rather than a
 * URL that 404s — a link we cannot guarantee is better omitted than served broken.
 */
export function publicContentUrl(base: string | undefined, key: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/${key}`;
}
