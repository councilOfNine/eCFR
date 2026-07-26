/**
 * /docs, served by the real Worker, carries no third-party script and the CSP to prove it.
 *
 * test/docs.test.ts checks `docsPage()` and `docsCsp()` as pure functions. This file checks
 * that index.ts actually wires them together on the response — a page with a perfect CSP
 * string that never reaches a header is not protected by anything.
 *
 * WHAT THIS CANNOT CHECK: that the vendored bundle is really served at /vendor/…. `SELF` in
 * this pool is a service binding straight to the Worker's entrypoint, so it bypasses the
 * static-asset router that sits in front of the Worker in production; asserting a 200 there
 * would fail against a correct deployment. The asset wiring is covered as configuration in
 * test/docs.test.ts (the path the page requests, the path the vendor script writes, and the
 * directory wrangler publishes must all agree) and by `wrangler deploy --dry-run`.
 */

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { SCALAR_ASSET_PATH, SCALAR_VERSION } from '../../src/docs.js';

const BASE = 'https://api.test';

describe('/docs loads its renderer from this origin', () => {
  it('points its script tag at the vendored asset, not at a CDN', async () => {
    const response = await SELF.fetch(`${BASE}/docs`);
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain(`src="${SCALAR_ASSET_PATH}?v=${SCALAR_VERSION}"`);
    expect(html).not.toContain('cdn.jsdelivr.net');
    // If the renderer never loads, the static explanation stays visible rather than the page
    // going blank — which is what makes removing the CDN safe.
    expect(html).toContain('id="fallback"');
  });

  it('sends a Content-Security-Policy that names no external host', async () => {
    const response = await SELF.fetch(`${BASE}/docs`);
    const csp = response.headers.get('Content-Security-Policy') ?? '';

    expect(csp, '/docs served without a CSP').not.toBe('');
    expect(csp).toMatch(/script-src 'self' 'nonce-[0-9a-f]{32}'/);
    // No scheme-relative or absolute origin anywhere in the policy.
    expect(csp).not.toMatch(/(?:https?:)?\/\//);
  });

  it('gives every response a fresh nonce', async () => {
    // A nonce reused across responses is a nonce that a cached copy of the page can smuggle
    // an inline script past.
    const nonces = await Promise.all(
      [1, 2].map(async () => {
        const response = await SELF.fetch(`${BASE}/docs`);
        return /'nonce-([0-9a-f]+)'/.exec(
          response.headers.get('Content-Security-Policy') ?? '',
        )?.[1];
      }),
    );
    expect(nonces[0]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);
  });
});
