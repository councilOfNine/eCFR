/**
 * /docs must not load code from anybody else.
 *
 * THE HOLE THIS CLOSES: the page used to carry
 * `<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference">` — no version, no
 * integrity hash — and `docsCsp()` allowlisted that host in `script-src`. Whatever the CDN
 * resolved that package name to on any given day executed in every reader's browser, on a
 * public endpoint of an API that mints credentials, and nothing on the page could have
 * detected a substitution.
 *
 * The renderer is now served from this origin as a Workers static asset, copied out of
 * node_modules by scripts/vendor-scalar.ts from the version pinned in pnpm-lock.yaml. These
 * tests are what stop a CDN URL reappearing — in the markup, or quietly in the CSP.
 */

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { docsCsp, docsPage, SCALAR_ASSET_PATH, SCALAR_VERSION } from '../src/docs.js';

const NONCE = 'abcdef0123456789abcdef0123456789';

/** Everything that can name an external origin, as a directive map. */
function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name ?? '', values];
    }),
  );
}

describe('the docs page carries no third-party code', () => {
  const page = docsPage(NONCE, '/openapi.json');

  it('loads the renderer from this origin', () => {
    expect(page).toContain(`src="${SCALAR_ASSET_PATH}?v=${SCALAR_VERSION}"`);
  });

  it('has no absolute script, style, or font URL anywhere in the markup', () => {
    // Deliberately broader than "no jsdelivr": any scheme-relative or absolute src/href that
    // is not a link in the prose would be the same class of problem.
    const loaders = [...page.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1] ?? '');
    const external = loaders.filter((url) => /^(?:https?:)?\/\//.test(url));

    // The only absolute URLs on the page are prose links to ecfr.gov, which are anchors and
    // load nothing.
    for (const url of external) {
      expect(url, `${url} is loaded by the docs page`).toMatch(/^https:\/\/www\.ecfr\.gov/);
    }
    expect(page).not.toContain('cdn.jsdelivr.net');
    expect(page).not.toContain('unpkg.com');
  });

  it('does not put a nonce on the loader tag', () => {
    // A nonce there would let the tag run whatever it pointed at, defeating 'self' being the
    // only host source in script-src.
    const start = page.indexOf(`<script src="${SCALAR_ASSET_PATH}`);
    expect(start).toBeGreaterThan(-1);
    const tag = page.slice(start, page.indexOf('>', start) + 1);
    expect(tag).not.toContain('nonce');
  });
});

describe('the docs Content-Security-Policy', () => {
  const csp = directives(docsCsp(NONCE));

  it('allows scripts only from this origin and the nonced inline block', () => {
    expect(csp.get('script-src')).toEqual(["'self'", `'nonce-${NONCE}'`]);
  });

  it('names no external host in any directive', () => {
    for (const [name, values] of csp) {
      for (const value of values) {
        expect(value, `${name} allows ${value}`).not.toMatch(/^(?:https?:)?\/\//);
      }
    }
  });

  it('still denies everything not explicitly granted', () => {
    expect(csp.get('default-src')).toEqual(["'none'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'none'"]);
    expect(csp.get('form-action')).toEqual(["'none'"]);
    // The "try it" panel calls this API and nothing else.
    expect(csp.get('connect-src')).toEqual(["'self'"]);
  });

  it('does not allow inline script or eval', () => {
    const scriptSrc = csp.get('script-src') ?? [];
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });
});

describe('the vendored bundle pin', () => {
  it('matches the version this package actually depends on', async () => {
    // A bump in one place and not the other ships a stale cache-busting query, or worse, a
    // path that does not exist. Same idea as test/config.test.ts parsing wrangler.jsonc.
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { devDependencies: Record<string, string> };

    const pinned = manifest.devDependencies['@scalar/api-reference'];
    expect(
      pinned,
      '@scalar/api-reference must be an exact version, not a range: the bundle is served ' +
        'immutably for a year and SCALAR_VERSION is the only thing that busts that cache.',
    ).toBe(SCALAR_VERSION);
  });

  it('is written to the path the page asks for', async () => {
    const script = await readFile(new URL('../scripts/vendor-scalar.ts', import.meta.url), 'utf8');
    const filename = SCALAR_ASSET_PATH.split('/').pop() ?? '';
    expect(filename).not.toBe('');
    expect(
      script,
      'scripts/vendor-scalar.ts writes a different filename from the one docs.ts requests',
    ).toContain(`'${filename}'`);
    // The asset must live under public/, which is what wrangler.jsonc serves.
    expect(script).toContain("'public'");
  });

  it('is served from a directory wrangler is configured to publish', async () => {
    const wrangler = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    // Comment-tolerant: the assets block is the only place "directory" appears.
    expect(wrangler).toMatch(/"assets"\s*:\s*\{[^}]*"directory"\s*:\s*"public"/);
  });
});
