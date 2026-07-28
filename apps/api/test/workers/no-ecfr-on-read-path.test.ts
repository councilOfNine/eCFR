/**
 * RULE 4, encoded in CI: no user-facing route makes an outbound call to ecfr.gov.
 *
 * This is the entire thesis of the rewrite expressed as one assertion. The predecessor fetched
 * upstream on the read path, so every page view was a request to an origin that rate-limits
 * with a token bucket and 504s on large titles about half the time. Data the site serves is
 * synced ahead of time by a Node pipeline in GitHub Actions; the Worker reads D1 and R2 and
 * nothing else.
 *
 * WHY THE ROUTE LIST IS NOT WRITTEN DOWN HERE: it is read from the Worker's own OpenAPI
 * document at request time. A hand-maintained list would be complete on the day it was written
 * and stale on the day someone adds a route — which is precisely the day this test needs to
 * fire. Adding a route to the API adds it to this sweep automatically.
 *
 * `/v1/diff` is the one documented exception. It is excluded here BY NAME, and the exclusion is
 * asserted to match exactly one route, so a future `/v1/diff-all` cannot inherit the carve-out
 * by accident. Its own guarantees are tested in diff-memoisation.test.ts.
 */

import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

interface TestEnv {
  DB: D1Database;
  __SEED: string[];
}

const testEnv = env as unknown as TestEnv;

const BASE = 'https://api.test';

/** The single documented carve-out. */
const UPSTREAM_ALLOWED = new Set(['/v1/diff']);

// ─── outbound interception ───────────────────────────────────────────────────

const realFetch = globalThis.fetch;

interface Outbound {
  url: string;
  from: string;
}

let outbound: Outbound[] = [];
let currentRoute = '(none)';

/**
 * Replace the global `fetch` for the duration of the sweep.
 *
 * The pool runs the Worker under test in the same isolate as this file, so patching the global
 * here reaches the Worker's own `fetch` calls. That is the level the assertion has to be made
 * at: intercepting a module boundary would only prove that one module was not used, while
 * this proves that no request left the isolate, however it was made.
 *
 * The stub THROWS rather than returning an error response, because a route that swallows a
 * failed upstream fetch and serves a degraded answer is still violating the rule.
 */
beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      host = '';
    }

    if (host === 'ecfr.gov' || host.endsWith('.ecfr.gov')) {
      outbound.push({ url, from: currentRoute });
      throw new Error(
        `RULE 4 VIOLATION: ${currentRoute} fetched ${url}. ` +
          'User-facing routes read D1 and R2; only /v1/diff may reach eCFR, and only on a ' +
          'cache miss.',
      );
    }

    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});

afterEach(() => {
  outbound = [];
  currentRoute = '(none)';
});

// ─── fixture data ────────────────────────────────────────────────────────────

/**
 * Load the committed fixture so routes return 200 rather than 404.
 *
 * A sweep over empty tables would exercise routing and validation and stop short of the
 * handler bodies — which is where a fetch would live. Real rows make the handlers actually run.
 */
beforeEach(async () => {
  await testEnv.DB.batch(testEnv.__SEED.map((sql) => testEnv.DB.prepare(sql)));
});

// ─── route discovery ─────────────────────────────────────────────────────────

interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
}

/**
 * Plausible values for every path parameter the API declares.
 *
 * Drawn from the fixture, so each substitution resolves to a real row. A parameter with no
 * entry here fails the sweep loudly rather than being skipped — an unreachable route is an
 * untested route, and this test's whole value is that it covers everything.
 */
const PATH_PARAMS: Record<string, string> = {
  slug: 'administrative-conference-of-the-united-states',
  number: '1',
  title: '1',
  id: 'title-1/chapter-I',
  // `{title}-{part}`, not the full ancestry citation — /v1/parts takes the compact form.
  // 1 CFR Part 1 is in the fixture and has rendered content, so the handler runs its R2
  // pointer branch as well as its D1 reads.
  citation: '1-1',
  chapter: 'I',
  part: '1',
  n: '1',
  keyId: '00000000-0000-4000-8000-000000000000',
  token: 'not-a-real-token',
};

/** Query parameters that make a route return data instead of a 400. */
const QUERY_DEFAULTS: Record<string, Record<string, string>> = {
  '/v1/search': { q: 'commission' },
  '/v1/amendments': { title: '1' },
  '/v1/word-counts': { title: '1' },
};

function fillPath(template: string): string {
  return template.replaceAll(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = PATH_PARAMS[name];
    if (value === undefined) {
      throw new Error(
        `no fixture value for path parameter {${name}} in ${template}. ` +
          'Add one to PATH_PARAMS so the route is actually exercised.',
      );
    }
    return encodeURIComponent(value).replaceAll('%2F', '/');
  });
}

async function loadRoutes(): Promise<{ method: string; path: string }[]> {
  const response = await SELF.fetch(`${BASE}/openapi.json`);
  expect(
    response.status,
    'the Worker must serve its own OpenAPI document; the sweep is derived from it',
  ).toBe(200);

  const doc = (await response.json()) as OpenApiDoc;
  const routes: { method: string; path: string }[] = [];
  for (const [routePath, operations] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(operations)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      routes.push({ method: method.toUpperCase(), path: routePath });
    }
  }
  return routes;
}

// ─── the sweep ───────────────────────────────────────────────────────────────

describe('no user-facing route reaches ecfr.gov', () => {
  it('the OpenAPI document lists the routes to sweep', async () => {
    const routes = await loadRoutes();
    // A doc that suddenly lists two routes would make every assertion below vacuous.
    expect(routes.length).toBeGreaterThanOrEqual(8);

    const paths = new Set(routes.map((r) => r.path));
    for (const allowed of UPSTREAM_ALLOWED) {
      expect(
        paths.has(allowed),
        `${allowed} is excluded from the sweep but is not a route. Remove the exclusion, or ` +
          'fix the path — an exclusion that matches nothing silently protects nothing.',
      ).toBe(true);
    }
  });

  it('sweeps every GET route with no outbound request', async () => {
    const routes = (await loadRoutes()).filter(
      (route) => route.method === 'GET' && !UPSTREAM_ALLOWED.has(route.path),
    );
    expect(routes.length).toBeGreaterThanOrEqual(8);

    const failures: string[] = [];
    const notOk: string[] = [];

    for (const route of routes) {
      const url = new URL(fillPath(route.path), BASE);
      for (const [key, value] of Object.entries(QUERY_DEFAULTS[route.path] ?? {})) {
        url.searchParams.set(key, value);
      }
      currentRoute = `GET ${route.path}`;

      let response: Response;
      try {
        response = await SELF.fetch(url.toString(), {
          headers: { 'CF-Connecting-IP': '203.0.113.7' },
        });
      } catch (error) {
        failures.push(`${currentRoute} threw: ${(error as Error).message}`);
        continue;
      }

      // A 5xx means the handler blew up, which usually means it did something it should not
      // have.
      if (response.status >= 500) {
        failures.push(`${currentRoute} -> HTTP ${response.status}: ${await response.text()}`);
      } else if (response.status !== 200) {
        notOk.push(`${currentRoute} -> HTTP ${response.status}`);
      }
    }

    expect(outbound, 'these routes reached eCFR').toEqual([]);
    expect(failures).toEqual([]);

    // Every data route must actually SERVE, not merely fail politely. A sweep where each
    // request 404s before reaching the handler would report "no outbound calls" while proving
    // nothing about the handlers — which is where a fetch would live.
    //
    // `/v1/account/keys` is the exception and is expected to 401: listing keys requires one.
    expect(notOk).toEqual(['GET /v1/account/keys -> HTTP 401']);
  });

  it('sweeps every mutating route with no outbound request', async () => {
    // POST/DELETE routes are account management. They are swept with deliberately empty
    // bodies: the interesting property is not that they succeed, it is that nothing on the
    // path from the edge to the validator touches eCFR.
    const routes = (await loadRoutes()).filter(
      (route) => route.method !== 'GET' && !UPSTREAM_ALLOWED.has(route.path),
    );

    for (const route of routes) {
      currentRoute = `${route.method} ${route.path}`;
      const response = await SELF.fetch(new URL(fillPath(route.path), BASE).toString(), {
        method: route.method,
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://ecfr.fixit.works',
          'CF-Connecting-IP': '203.0.113.8',
        },
        body: route.method === 'DELETE' ? undefined : '{}',
      });
      expect(response.status).toBeLessThan(500);
    }

    expect(outbound, 'these routes reached eCFR').toEqual([]);
  });

  it('sweeps the unversioned routes too', async () => {
    // /docs, /health and / are not in the OpenAPI paths object but are still served, and /docs
    // renders a spec viewer — historically a place where somebody adds a CDN script tag.
    for (const path of ['/', '/health', '/docs', '/openapi.json']) {
      currentRoute = `GET ${path}`;
      const response = await SELF.fetch(`${BASE}${path}`, { redirect: 'manual' });
      expect(response.status, `${path} -> ${response.status}`).toBeLessThan(500);
    }
    expect(outbound).toEqual([]);
  });

  it('the interceptor actually works', () => {
    // Guards the guard. If the stub were installed wrongly — wrong global, wrong isolate — the
    // sweep above would pass by doing nothing at all.
    currentRoute = 'self-test';
    expect(() => globalThis.fetch('https://www.ecfr.gov/api/versioner/v1/titles.json')).toThrow(
      /RULE 4 VIOLATION/,
    );
    expect(outbound).toHaveLength(1);
    outbound = [];
  });
});

describe('the read path has no upstream dependency at all', () => {
  it('serves data with the eCFR host unreachable', async () => {
    // The sweep proves no request was made. This proves the stronger property a reader
    // actually cares about: if eCFR were down for a week, the site would keep serving.
    currentRoute = 'GET /v1/agencies';
    const response = await SELF.fetch(`${BASE}/v1/agencies?limit=5`, {
      headers: { 'CF-Connecting-IP': '203.0.113.9' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(outbound).toEqual([]);
  });

  it('stamps eCFR provenance from stored data rather than a live check', async () => {
    // Every response carries eCFR's own snapshot date. It comes from app_meta, written by the
    // sync — asking eCFR for it at request time is the obvious wrong way to produce it.
    currentRoute = 'GET /v1/meta';
    const response = await SELF.fetch(`${BASE}/v1/meta`, {
      headers: { 'CF-Connecting-IP': '203.0.113.10' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Ecfr-Source-Date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(outbound).toEqual([]);
  });
});
