/**
 * Cross-cutting response headers: request id, security, CORS, provenance.
 */

import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { ECFR_BASE_URL } from '../constants/config.js';
import { getAppMeta } from '../db/meta.js';
import type { AppEnv } from '../env.js';

/**
 * Attach a request id before anything can fail.
 *
 * Every error body repeats it, and it is the join key between a user's bug report and the
 * observability trace. Honours an inbound `X-Request-Id` so a caller's own correlation id
 * survives — length-capped and character-filtered, because it is echoed into a response
 * header and untrusted input does not belong in one unvalidated.
 */
export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const inbound = c.req.header('x-request-id');
  const id = inbound && /^[A-Za-z0-9._:-]{1,128}$/.test(inbound) ? inbound : crypto.randomUUID();
  c.set('requestId', id);
  await next();
  c.res.headers.set('X-Request-Id', id);
});

/**
 * Security headers.
 *
 * Most of these are belt-and-braces on a JSON API — there is no DOM to protect — but /docs is
 * served from this same Worker and is a real HTML page, so the policy has to be real too.
 * `frame-ancestors 'none'` and `X-Frame-Options` are the pair that actually matter: nobody
 * should be able to frame the docs page and harvest a key someone pastes into the "try it"
 * box.
 */
export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  h.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
  // HSTS is safe to set unconditionally: this Worker is only reachable over TLS.
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (!h.has('Content-Security-Policy')) {
    // Default for JSON responses: nothing may load or execute. /docs overrides this with a
    // policy that permits its own renderer.
    h.set(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  }
});

/**
 * Every non-safelisted header the data routes attach, and therefore every one a browser is
 * allowed to read back.
 *
 * A header that is set but not listed here is invisible to cross-origin JavaScript — it is
 * still on the wire, so it looks correct in curl and in the Network tab, and only the fetch()
 * caller sees nothing. That is how `X-Ecfr-Source` sat unreadable: `provenanceHeaders` stamps
 * provenance on every data response *so that consumers can cite it*, and the one consumer
 * class that has to ask permission could not read it.
 *
 * apps/api/test/api.test.ts drives a real response and asserts this list covers what the
 * middleware actually set, so adding a header without adding it here fails the suite rather
 * than shipping a header only some clients can see.
 */
export const DATA_EXPOSED_HEADERS = [
  'X-Request-Id',
  'X-Api-Tier',
  'X-Ecfr-Source',
  'X-Ecfr-Source-Date',
  'X-Ecfr-Published-Run',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'RateLimit-Policy',
  'Retry-After',
  // Set only by /v1/diff, but exposeHeaders is one list for the whole data surface.
  'X-Diff-Cache',
] as const;

/**
 * CORS for the read-only data routes.
 *
 * Wide open on purpose: the whole point of an open atlas is that a researcher can fetch it
 * from a notebook, an Observable cell, or a static page they wrote in an afternoon.
 * Credentials are off — authentication is a bearer header, never a cookie — so `*` cannot be
 * used to ride someone's ambient session, because there isn't one.
 */
export const dataCors = cors({
  origin: '*',
  allowMethods: ['GET', 'HEAD', 'OPTIONS'],
  allowHeaders: ['Authorization', 'X-Api-Key', 'Content-Type', 'X-Request-Id'],
  exposeHeaders: [...DATA_EXPOSED_HEADERS],
  maxAge: 86400,
});

/**
 * CORS for account management — deliberately narrow.
 *
 * These routes mint and revoke credentials. Allowing `*` would let any page a user visits
 * script key creation if it ever got hold of a key, so the browser-callable surface is
 * restricted to our own site; server-side callers are unaffected because CORS is a browser
 * mechanism and a curl request has no Origin to check.
 */
export function accountCors(siteOrigin: string) {
  return cors({
    origin: (origin) => (origin && origin === siteOrigin ? origin : siteOrigin),
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'X-Api-Key', 'Content-Type'],
    maxAge: 600,
  });
}

/**
 * Stamp eCFR provenance on every data response.
 *
 * The site and the API both exist to be cited. A consumer who saves a JSON file should be able
 * to answer "as of when?" from the response itself rather than from the moment they happened
 * to run the request — those differ, and eCFR publishes on business days only.
 */
export const provenanceHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  const meta = await getAppMeta(c.env.DB);
  if (meta.source_date) c.res.headers.set('X-Ecfr-Source-Date', meta.source_date);
  if (meta.published_run_id !== null) {
    c.res.headers.set('X-Ecfr-Published-Run', String(meta.published_run_id));
  }
  c.res.headers.set('X-Ecfr-Source', ECFR_BASE_URL);
});
