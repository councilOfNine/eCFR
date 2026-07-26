/**
 * Finish dist/client/_headers by substituting the real inline-script hashes into the CSP.
 *
 * public/_headers ships the policy with a `{{INLINE_SCRIPT_HASHES}}` placeholder because the
 * hashes are a property of the BUILD, not of the source: Astro inlines the bundled component
 * scripts, so the theme toggle's and the part-TOC's hashes change whenever those components do.
 * Computing them here, from the HTML that is about to be uploaded, is the only arrangement where
 * the header and the page cannot disagree.
 *
 * Runs after `astro build` and before scripts/check-headers.ts, which verifies the result.
 */
import { readFile, writeFile } from 'node:fs/promises';

import { collectInlineScripts, HEADERS_FILE } from './lib/built-html.ts';

const PLACEHOLDER = '{{INLINE_SCRIPT_HASHES}}';

let headers: string;
try {
  headers = await readFile(HEADERS_FILE, 'utf8');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error(
      `build-headers: ${HEADERS_FILE} does not exist. public/_headers should have been copied ` +
        'into the build output — has the public directory or the adapter changed?',
    );
  }
  throw error;
}

/**
 * Substitution is scoped to the Content-Security-Policy header LINE, not done over the whole
 * file. public/_headers documents the placeholder in its comment block, and a naive
 * `String.replace` hits that comment first and leaves the real policy untouched — a build that
 * reports success while shipping a CSP that blocks every inline script. Anchoring on the header
 * line makes the comment unable to interfere no matter how it is worded.
 */
const isCspLine = (line: string): boolean =>
  /^\s/.test(line) && /^\s*content-security-policy\s*:/i.test(line);

const lines = headers.split('\n');
const cspLines = lines.filter(isCspLine);
const cspLine = cspLines[0];

if (cspLines.length !== 1 || cspLine === undefined) {
  throw new Error(
    `build-headers: expected exactly one Content-Security-Policy line in dist/client/_headers, ` +
      `found ${cspLines.length}.`,
  );
}
if (!cspLine.includes(PLACEHOLDER)) {
  throw new Error(
    `build-headers: the Content-Security-Policy line does not contain ${PLACEHOLDER}. Either ` +
      'public/_headers no longer carries the placeholder, or this script has already run over a ' +
      'stale build directory.',
  );
}

const { hashes } = await collectInlineScripts();

if (hashes.length === 0) {
  throw new Error(
    'build-headers: the build contains no inline scripts at all. That is not impossible — it ' +
      'would mean Astro stopped inlining and the theme script vanished — but it is far more ' +
      'likely that the HTML scan broke. Fix scripts/lib/built-html.ts rather than shipping a ' +
      'CSP that was derived from nothing.',
  );
}

const allowList = hashes.map((h) => `'${h}'`).join(' ');
const substituted = lines
  .map((line) => (isCspLine(line) ? line.replace(PLACEHOLDER, allowList) : line))
  .join('\n');

await writeFile(HEADERS_FILE, substituted, 'utf8');

console.log(`build-headers: CSP allows ${hashes.length} inline script(s) by hash.`);
