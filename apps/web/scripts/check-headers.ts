/**
 * Verify the security headers against the real build output.
 *
 * A CSP is the one piece of this app that is invisible until it is wrong: nothing in the source
 * fails, nothing in the build fails, and then the theme toggle silently stops working for every
 * reader because a hash moved. So the policy is checked against the pages it will actually be
 * served with, on every build.
 *
 * What is asserted, and why each one:
 *
 *   - the `/*` rule exists and carries every header we claim to ship;
 *   - the build-time hash placeholder is gone;
 *   - EVERY inline script in the output is allowed by a hash in `script-src`, so the theme
 *     toggle, the part table of contents and the agency table's filter/sort keep working;
 *   - `script-src` contains neither 'unsafe-inline' nor 'unsafe-eval', which would make the
 *     hashes decorative;
 *   - no HTML uses an inline event-handler attribute, which no hash can cover and which would
 *     therefore be dead code under this policy;
 *   - every external script and stylesheet is same-origin, so `'self'` is sufficient;
 *   - the adapter's immutable-cache rule for /_astro/* survived the substitution.
 */
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';

import { collectInlineScripts, DIST, HEADERS_FILE, listHtml } from './lib/built-html.ts';

const problems: string[] = [];
const fail = (message: string): void => {
  problems.push(message);
};

// ── parse _headers ──────────────────────────────────────────────────────────

/** Header name (lowercased) → value, for one URL pattern in the `_headers` file. */
type HeaderMap = Map<string, string>;
/** URL pattern → its headers. The Cloudflare `_headers` format, parsed just enough to assert on. */
type HeaderRules = Map<string, HeaderMap>;

const raw = await readFile(HEADERS_FILE, 'utf8');

const rules: HeaderRules = new Map();
let current: HeaderMap | null = null;
for (const line of raw.split('\n')) {
  if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
  if (!/^\s/.test(line)) {
    current = new Map();
    rules.set(line.trim(), current);
    continue;
  }
  const separator = line.indexOf(':');
  if (separator === -1 || current === null) continue;
  current.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
}

const global = rules.get('/*');
if (global === undefined) {
  fail('dist/client/_headers has no `/*` rule, so no page gets a security header at all');
}

if (!rules.has('/_astro/*')) {
  fail(
    'the /_astro/* immutable-cache rule is missing — @astrojs/cloudflare appends it to ' +
      '_headers, so something overwrote the file after the adapter wrote it',
  );
}

for (const header of [
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
  'strict-transport-security',
  'x-frame-options',
  'permissions-policy',
]) {
  if (global && !global.has(header)) fail(`the /* rule is missing ${header}`);
}

if (global?.get('x-content-type-options') !== 'nosniff') {
  fail("X-Content-Type-Options must be exactly 'nosniff'");
}

// ── the CSP ─────────────────────────────────────────────────────────────────

const csp = global?.get('content-security-policy') ?? '';

if (csp.includes('{{')) {
  fail(
    'the CSP still contains a build-time placeholder — scripts/build-headers.ts did not run, ' +
      'or ran before astro build',
  );
}

const directive = (name: string): string[] | null => {
  const found = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return found === undefined ? null : found.slice(name.length).trim().split(/\s+/).filter(Boolean);
};

const scriptSrc = directive('script-src') ?? [];
if (scriptSrc.length === 0) fail('the CSP has no script-src directive');
for (const unsafe of ["'unsafe-inline'", "'unsafe-eval'"]) {
  if (scriptSrc.includes(unsafe)) {
    fail(`script-src contains ${unsafe}, which makes the inline-script hashes pointless`);
  }
}
if ((directive('default-src') ?? []).join(' ') !== "'none'") {
  fail("default-src should be 'none' — this site fetches nothing that is not enumerated");
}
if (!(directive('frame-ancestors') ?? []).includes("'none'")) {
  fail("frame-ancestors should be 'none'");
}
if (!(directive('object-src') ?? []).includes("'none'")) {
  fail("object-src should be 'none'");
}

// Rule 4, enforced by the browser rather than by convention: nothing on the read path may reach
// ecfr.gov. connect-src 'self' is what makes that true of the deployed site.
const connectSrc = directive('connect-src') ?? [];
if (connectSrc.join(' ') !== "'self'") {
  fail(
    `connect-src is "${connectSrc.join(' ')}" — it must be exactly 'self' so a reader's browser ` +
      'cannot be made to fetch ecfr.gov from this site',
  );
}

// ── every inline script is covered ──────────────────────────────────────────

const { hashes, byHash } = await collectInlineScripts();
const allowed = new Set(scriptSrc.filter((s) => s.startsWith("'sha")).map((s) => s.slice(1, -1)));

for (const hash of hashes) {
  if (!allowed.has(hash)) {
    const where = byHash.get(hash);
    fail(
      `an inline script in ${where?.page} is not allowed by the CSP. Add '${hash}' to ` +
        'script-src, or re-run scripts/build-headers.ts.',
    );
  }
}
for (const hash of allowed) {
  if (!byHash.has(hash)) {
    fail(`script-src allows '${hash}', which no page in this build emits — stale hash`);
  }
}

// ── nothing in the HTML needs a source the CSP does not grant ───────────────

const pages = await listHtml();
for (const page of pages) {
  const html = await readFile(page, 'utf8');
  const rel = relative(DIST, page);

  // Inline handlers are unhashable. Under this policy they would simply never fire, so their
  // presence means a feature is broken rather than that the policy is wrong.
  const handler = /\s(on[a-z]+)\s*=\s*["']/i.exec(html);
  if (handler) {
    fail(`${rel}: uses the inline event handler ${handler[1]}=, which this CSP blocks`);
  }

  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    const src = match[1] ?? '';
    if (!src.startsWith('/') || src.startsWith('//')) {
      fail(`${rel}: loads a script from ${src}; script-src only grants 'self'`);
    }
  }
  for (const match of html.matchAll(
    /<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*\bhref\s*=\s*["']([^"']+)["']/gi,
  )) {
    const href = match[1] ?? '';
    if (!href.startsWith('/') || href.startsWith('//')) {
      fail(`${rel}: loads a stylesheet from ${href}; style-src only grants 'self'`);
    }
  }
}

if (problems.length > 0) {
  console.error(`headers check: FAIL — ${problems.length} problem(s)\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(
  `headers check: /* rule covers ${pages.length} pages; ${hashes.length} inline script(s) hashed.`,
);
