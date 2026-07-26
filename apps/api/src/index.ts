/**
 * The eCFR Atlas public API Worker.
 *
 * Deployed separately from the site: the Astro app is ~11,100 prerendered pages served as
 * Workers Static Assets and has no business sharing a deployment with something that holds
 * D1 and R2 bindings and mints credentials.
 *
 * Middleware order matters and is not arbitrary:
 *   requestId      — first, so every subsequent failure has an id to report
 *   securityHeaders— wraps everything including error responses
 *   dataCors       — before auth, so a preflight never consumes quota
 *   authenticate   — identifies the principal and meters it
 *   provenance     — needs a successful response to stamp
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import { createMiddleware } from 'hono/factory';
import { pruneUsage, utcDay } from './auth/quota.js';
import {
  DATA_CACHE_CONTROL,
  DOCS_CACHE_CONTROL,
  DOCS_PATH,
  ECFR_BASE_URL,
  OPENAPI_SPEC_PATH,
  PRIVATE_CACHE_CONTROL,
  REPO_URL,
  TIERS,
  USAGE_RETENTION_DAYS,
} from './constants/config.js';
import { clearAppMetaCache } from './db/meta.js';
import { docsCsp, docsPage } from './docs.js';
import { API_TIERS, DeployEnvironment } from './enums.js';
import type { AppEnv, Env } from './env.js';
import { onError, onNotFound, validationHook } from './errors.js';
import { LoggingMailer } from './mailer.js';
import { authenticate, requireKey } from './middleware/auth.js';
import {
  accountCors,
  dataCors,
  provenanceHeaders,
  requestId,
  securityHeaders,
} from './middleware/headers.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerAgencyRoutes } from './routes/agencies.js';
import { registerAmendmentRoutes } from './routes/amendments.js';
import { registerDiffRoutes } from './routes/diff.js';
import { registerMetaRoutes } from './routes/meta.js';
import { registerOverlapRoutes } from './routes/overlap.js';
import { registerPartRoutes } from './routes/parts.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerTitleRoutes } from './routes/titles.js';
import { registerWordCountRoutes } from './routes/word-counts.js';

/**
 * "Anonymous works, a key raises your limits."
 *
 * An empty requirement object alongside the named scheme is how OpenAPI spells optional
 * authentication. Without the empty entry, the try-it panel demands a credential before a
 * visitor's first request — which defeats the reason the anonymous tier has a real quota.
 */
const OPTIONAL_AUTH: Record<string, string[]>[] = [{}, { ApiKeyAuth: [] }];

const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

app.onError(onError);
app.notFound(onNotFound);

app.use('*', requestId);
app.use('*', securityHeaders);

// ─── the versioned API ───────────────────────────────────────────────────────

const v1 = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

/** Account routes are mounted into `v1` and need different CORS and caching to the data routes. */
const isAccountRoute = (path: string): boolean => path.startsWith('/v1/account');

/**
 * One CORS middleware that picks its policy by path, rather than two registrations.
 *
 * Registering a second `use('*')` on the mounted account sub-app would run BOTH — Hono merges
 * a routed sub-app's wildcard middleware into the parent router, it does not replace it. That
 * is not merely untidy: the same mistake with `authenticate` charged two quota units and did
 * two D1 writes for every account request, which is the sort of thing that is invisible until
 * somebody's quota runs out twice as fast as the docs promise.
 */
v1.use(
  '*',
  createMiddleware<AppEnv>((c, next) => {
    const policy = isAccountRoute(new URL(c.req.url).pathname)
      ? accountCors(c.env.SITE_ORIGIN)
      : dataCors;
    return policy(c, next);
  }),
);

// Registered exactly once, for the whole of /v1. See the note above.
v1.use('*', authenticate);
v1.use('*', provenanceHeaders);

v1.use('*', async (c, next) => {
  await next();
  if (isAccountRoute(new URL(c.req.url).pathname)) {
    // Key material and key lists must never enter a shared cache. A CDN that decided to cache
    // a 201 containing a secret would be an incident.
    c.res.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL);
    return;
  }
  // Published data changes at most once a business day (57 eCFR issue dates in 84 days, zero
  // weekends), so a minute of shared cache is free correctness-wise and removes most repeat
  // D1 reads. A route that already set its own policy keeps it.
  if (c.req.method === 'GET' && !c.res.headers.has('Cache-Control')) {
    c.res.headers.set('Cache-Control', DATA_CACHE_CONTROL);
  }
});

registerMetaRoutes(v1);
registerAgencyRoutes(v1);
registerTitleRoutes(v1);
registerPartRoutes(v1);
registerSearchRoutes(v1);
registerOverlapRoutes(v1);
registerAmendmentRoutes(v1);
registerWordCountRoutes(v1);
registerDiffRoutes(v1);

// ─── account management ──────────────────────────────────────────────────────

const account = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

// CORS, authentication, quota and caching all come from `v1` above — deliberately NOT
// re-registered here. Only the key requirement is specific to these paths: registration and
// verification are, by definition, reached without a key; everything else under /account needs
// one.
account.use('/account/keys', requireKey);
account.use('/account/keys/*', requireKey);

/**
 * The mailer.
 *
 * `LoggingMailer` does not send anything. Swapping this one line for a Cloudflare Email
 * Service implementation is the entire remaining work — see src/mailer.ts.
 */
// Hard-coded rather than read from `env.ENVIRONMENT`: bindings do not exist at module scope in
// a Worker, and the safe default for a mailer that logs tokens is the environment that logs
// the least.
registerAccountRoutes(account, new LoggingMailer(DeployEnvironment.Production));

v1.route('/', account);
app.route('/v1', v1);

// ─── spec and docs ───────────────────────────────────────────────────────────

/**
 * The OpenAPI document.
 *
 * `security` is declared globally as optional (an empty requirement alongside the key scheme),
 * which is the correct encoding of "anonymous works, a key raises your limits" — and it means
 * the try-it panel does not demand a credential before a visitor's first request.
 */
app.doc31(OPENAPI_SPEC_PATH, (c) => ({
  openapi: '3.1.0',
  info: {
    title: 'eCFR Atlas API',
    version: '1.0.0',
    description: [
      'An open, measured atlas of the US Code of Federal Regulations.',
      '',
      '## Word counts are never bare numbers',
      '',
      'Every count is `{ words, status, reason, method }`. `words: null` means UNKNOWN, not zero.',
      'Filter on `status` before any arithmetic. Aggregates also carry `coverage`; a total at 0.6',
      'coverage is a lower bound, not a measurement.',
      '',
      '## Two totals, both labelled',
      '',
      '`attributed` counts a scope in full for every agency claiming it — those figures do not sum',
      'to the corpus. `deduplicated` splits shared scopes evenly so the corpus total is conserved.',
      '17 of the 487 CFR references are claimed by 2-6 agencies; `/v1/overlap` lists them.',
      '',
      '## Dates',
      '',
      'Content is addressable by eCFR ISSUE date, not amendment date. The two differ in 49.7% of',
      "amendment rows and 40.4% of amendment dates predate eCFR's 2017-01-01 full-text horizon.",
      '',
      '## Rate limits',
      '',
      API_TIERS.map(
        (t) =>
          `- \`${t}\`: ${TIERS[t].dailyQuota.toLocaleString('en-US')} requests/day, ${TIERS[t].burstPerMinute}/minute. ${TIERS[t].description}`,
      ).join('\n'),
      '',
      'No key is needed to start. `POST /v1/account/register` to raise your limits.',
      '',
      '## Attribution',
      '',
      `Source data: the Electronic Code of Federal Regulations, ${ECFR_BASE_URL}. Every`,
      "response carries `X-Ecfr-Source-Date` with eCFR's own snapshot date — cite that, not the",
      'time of your request.',
    ].join('\n'),
    license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
  },
  servers: [{ url: new URL(c.req.url).origin, description: 'This deployment' }],
  externalDocs: { description: 'Source and data pipeline', url: REPO_URL },
  security: OPTIONAL_AUTH,
}));

app.openAPIRegistry.registerComponent('securitySchemes', 'ApiKeyAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'ecfr_<key id>_<secret>',
  description:
    'Send your key as `Authorization: Bearer ecfr_...`. `X-Api-Key` is also accepted for clients ' +
    'that cannot set an Authorization header. Keys are never accepted in a query string — those ' +
    'end up in access logs and browser history.',
});

app.get(DOCS_PATH, (c) => {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return c.html(docsPage(nonce, OPENAPI_SPEC_PATH), 200, {
    'Content-Security-Policy': docsCsp(nonce),
    'Cache-Control': DOCS_CACHE_CONTROL,
  });
});

app.get('/', (c) => c.redirect(DOCS_PATH, 302));

/**
 * Liveness. Deliberately does not touch D1: a health check that fails when the database is
 * slow tells you the Worker is down when it is not, and the thing you actually want to know
 * about the data is `/v1/meta`.
 */
app.get('/health', (c) => c.json({ status: 'ok', environment: c.env.ENVIRONMENT }, 200));

export default {
  fetch: app.fetch,

  /**
   * Nightly retention sweep.
   *
   * Quota is a daily window; usage history is not forever. This is the only scheduled work in
   * the Worker — the corpus sync is a Node pipeline in GitHub Actions, because title 40's XML
   * is 156,946,999 bytes and title 26 decodes to ~174 MB as a V8 two-byte string, both of
   * which exceed a Worker's 128 MB per-isolate limit.
   *
   * Not `async`: the whole body is handed to `ctx.waitUntil`, which is what keeps the isolate
   * alive for the sweep. Awaiting it here as well would add nothing and would delay the
   * handler's return for no benefit.
   */
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(
      (async () => {
        const cutoff = new Date();
        cutoff.setUTCDate(cutoff.getUTCDate() - USAGE_RETENTION_DAYS);
        const deleted = await pruneUsage(env.DB, utcDay(cutoff));
        clearAppMetaCache();
        console.log(
          JSON.stringify({
            level: 'info',
            event: 'usage_retention_sweep',
            cutoff_day: utcDay(cutoff),
            rows_deleted: deleted,
          }),
        );
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
