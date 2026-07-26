/**
 * Structural audit of every built page.
 *
 * These are the guarantees this app makes that nothing else enforces. Types cannot express "no
 * page scrolls sideways on a phone" or "an unknown never renders as 0", and a reviewer will not
 * open 11,100 pages. So they are asserted here, over the real output, on every build.
 *
 * Each rule below exists because of a specific measured failure in the predecessor or a specific
 * commitment made in this rewrite — none of them is a generic lint.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/client/', import.meta.url));

const pages: string[] = [];

async function walk(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith('.html')) pages.push(full);
  }
}

await walk(DIST);

/** One rule violation on one built page. */
interface Finding {
  /** DIST-relative page path, so the message is copy-pasteable into an editor. */
  page: string;
  message: string;
}

const findings: Finding[] = [];

/**
 * A wide element must scroll inside its own container, never widen the document. The wrapper is
 * `.table-wrap` (overflow-x: auto); tables injected into regulation prose are covered by the
 * `.reg-prose table { display: block; overflow-x: auto }` rule instead.
 */
function tablesAreContained(html: string): number[] {
  const offenders: number[] = [];
  for (const match of html.matchAll(/<table[\s>]/g)) {
    const preceding = html.slice(Math.max(0, match.index - 400), match.index);
    if (!/\btable-wrap\b/.test(preceding) && !/\breg-prose\b/.test(preceding)) {
      offenders.push(match.index);
    }
  }
  return offenders;
}

for (const page of pages) {
  const html = await readFile(page, 'utf8');
  const rel = relative(DIST, page);
  const fail = (message: string): void => {
    findings.push({ page: rel, message });
  };

  // ── the project's central rule ──
  // Anchored on the `data-unmeasured` marker that WordCount.astro emits, not on a class name:
  // `badge-unknown` and `callout-unknown` are unrelated styling hooks and matching them by
  // substring produced false positives.
  //
  // The figure slot of an unmeasured value must open with an em dash. A digit there means
  // something upstream reintroduced `?? 0`, which is the precise defect this rewrite exists to
  // prevent — the predecessor's `formatNumber(null)` returned "0".
  const digitInFigure = /data-unmeasured[^>]*>\s*(?:<span[^>]*>)?\s*\d/.exec(html);
  if (digitInFigure) {
    fail(
      'a value marked unmeasured rendered a digit in its figure slot — see src/components/WordCount.astro',
    );
  }

  // Every unmeasured value carries the phrase exactly once, either as its visible label (large
  // figures) or as visually-hidden text (table cells). A mismatch means a screen reader would
  // hear a bare dash with no explanation.
  const marks = (html.match(/data-unmeasured/g) ?? []).length;
  const phrases = (html.match(/Not measured/g) ?? []).length;
  if (marks !== phrases) {
    fail(
      `${marks} unmeasured values but ${phrases} "Not measured" labels — every em dash must say why`,
    );
  }

  // ── layout stability ──
  const offenders = tablesAreContained(html);
  if (offenders.length > 0) {
    fail(`${offenders.length} table(s) outside a .table-wrap scroll container`);
  }
  // Skeletons are what produced the predecessor's 0.112 CLS. There are none in this design
  // because the HTML arrives complete; this makes that a rule rather than a habit.
  if (/\b(skeleton|placeholder-shimmer|animate-pulse)\b/.test(html)) {
    fail('contains a loading skeleton — this site ships complete HTML, nothing swaps in');
  }

  // ── accessibility commitments ──
  for (const [needle, label] of [
    ['<main', 'a <main> landmark'],
    ['<footer', 'a <footer> landmark'],
    ['class="skip-link"', 'a skip link'],
    ['aria-label="Primary"', 'a labelled primary nav'],
    ['<html lang="en"', 'a language declaration'],
  ] as const) {
    if (!html.includes(needle)) fail(`missing ${label}`);
  }

  const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;
  if (h1Count !== 1) fail(`${h1Count} <h1> elements, expected exactly 1`);

  if (!/<title>[^<]+<\/title>/.test(html)) fail('missing or empty <title>');
  if (!/<meta name="description" content="[^"]+"/.test(html)) fail('missing meta description');

  // ── rule 4: no user-facing route may call ecfr.gov ──
  // Links out are required by the attribution policy; a fetch is not. Anything that would issue
  // a request to ecfr.gov at page load is a violation.
  if (/(?:src|action)=["']https?:\/\/(?:www\.)?ecfr\.gov/.test(html)) {
    fail('embeds a subresource from ecfr.gov — link to it, never fetch it on the read path');
  }
  if (/fetch\(\s*["'`]https?:\/\/(?:www\.)?ecfr\.gov/.test(html)) {
    fail('contains client-side code that fetches ecfr.gov');
  }
}

if (findings.length > 0) {
  console.error(`html check: FAIL — ${findings.length} problem(s) across ${pages.length} pages\n`);
  for (const finding of findings.slice(0, 50))
    console.error(`  ${finding.page}: ${finding.message}`);
  if (findings.length > 50) console.error(`  … and ${findings.length - 50} more`);
  process.exit(1);
}

console.log(`html check: ${pages.length} pages, no problems`);
