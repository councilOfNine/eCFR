/**
 * A grep, promoted to a test.
 *
 * This is not how one normally tests software, and it is here anyway, because the defect it
 * guards against is the reason this repository was rewritten rather than patched. The
 * predecessor's line was:
 *
 *     chapterText = fullText.substring(0, estimatedWords * 6);
 *
 * Every behavioural test in this suite checks that today's code does not do that. None of them
 * can stop tomorrow's code from doing it again, because a proportional estimate produces a
 * plausible number and plausible numbers pass assertions. So the shape of the mistake is
 * banned at the source level, in the two places a word count is produced or persisted:
 * `packages/ecfr` and `scripts/sync`.
 *
 * WHAT THIS IS NOT: a security scanner or a general lint rule. It is narrow on purpose. A rule
 * that fires often gets suppressed, and a suppressed rule guards nothing. Each pattern below
 * has to be defensible as "there is no legitimate reason for this to appear in code that
 * produces a word count".
 *
 * The scan reads the .ts SOURCE rather than the build output. Source is what a reviewer reads,
 * what a diff shows, and what exists before anything is compiled — a guard that only runs
 * after a successful build is a guard that does not run on the commit that breaks it.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Directories whose code can put a number into the `word_count` column.
 *
 * apps/api and apps/web are deliberately absent: they read counts, they do not produce them,
 * and both go through `@ecfr-atlas/core`'s constructors to serialise. Widening the scan to
 * them would add noise (`slice(0, limit)` on a page of results is fine) without adding cover.
 */
const SCANNED_ROOTS = ['packages/ecfr/src', 'packages/core/src', 'scripts/sync'];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'probe', 'test', '__tests__']);

interface SourceFile {
  /** Repo-relative, POSIX separators, so failure messages are copy-pasteable. */
  rel: string;
  lines: string[];
}

async function collectSources(): Promise<SourceFile[]> {
  const out: SourceFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // A scanned root that does not exist yet is not a pass. `it('scans something')` below
      // fails on an empty result, so a typo in SCANNED_ROOTS cannot silently disable this file.
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!/\.(ts|mts|mjs|js)$/.test(entry.name)) continue;
      if (/\.(test|spec)\.[cm]?[jt]s$/.test(entry.name)) continue;
      const content = await readFile(full, 'utf8');
      out.push({
        rel: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
        lines: content.split('\n'),
      });
    }
  }

  for (const root of SCANNED_ROOTS) await walk(path.join(REPO_ROOT, root));
  return out;
}

const sources = await collectSources();

/**
 * Strip comments before matching.
 *
 * Every file in this repository documents the bug it is avoiding, quoting the offending line
 * verbatim — including, at the top of this one, `substring(0, estimatedWords * 6)`. Matching
 * against comments would make the guard fire on the explanation of why the guard exists, and
 * the only way to keep CI green would be to delete the explanation. So: comments out, code in.
 *
 * A block comment nested inside a string literal would confuse this, and no file here has one.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let quote: string | null = null;

  while (i < source.length) {
    const char = source[i] as string;
    const next = source[i + 1];

    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        i += 2;
        continue;
      }
      // Newlines are preserved so reported line numbers stay accurate.
      if (char === '\n') out += char;
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (char === '\\') {
        out += char + (next ?? '');
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      out += char;
      i += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      inLine = true;
      i += 2;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    }
    out += char;
    i += 1;
  }

  return out;
}

interface BannedPattern {
  name: string;
  /**
   * Literal, never built from input. Rule 3 forbids `new RegExp(userInput)` and this file has
   * no input to build one from, but the property is worth being obvious about in a file whose
   * whole job is banning shapes of code.
   */
  test: RegExp;
  why: string;
}

const BANNED: BannedPattern[] = [
  {
    name: 'bytes-per-word constant',
    // The literal `* 6` from the original line, in any spacing, and its `/ 6` inverse — the
    // same assumption run backwards to turn a byte count into a word count.
    test: /[*/]\s*6(?![.\d_])/,
    why:
      'six bytes per word is the magic number from `substring(0, estimatedWords * 6)`. ' +
      'There is no measured constant relating bytes to words; the corpus average of 6.33 ' +
      'is an average, not a conversion factor.',
  },
  {
    name: 'substring/slice from zero on document text',
    // `substring(0, n)` and `slice(0, n)` are ordinary operations — on an ARRAY. On text that
    // is about to be counted they are the estimate. The pattern therefore requires a
    // text-flavoured receiver rather than firing on every truncation in the tree.
    //
    // `body` and `content` are deliberately NOT in the receiver list. Both are HTTP words
    // before they are document words, and the honest uses (truncating a 429's response body
    // into an error snippet, capping a log line) outnumber the dishonest ones. A guard that
    // fires on `body.slice(0, 512)` in an error constructor is a guard somebody deletes.
    test: /\b(?:\w*(?:text|xml|html|prose|chars?)\w*)\s*\.\s*(?:substring|substr|slice)\s*\(\s*0\s*,/i,
    why:
      'truncating document text and counting the result is the original defect. If a node is ' +
      'too big to process, the answer is unavailable("unavailable_too_large"), which the ' +
      'caller can roll up from children — not a prefix of it.',
  },
  {
    name: 'estimate identifier on a count',
    // Names betray intent earlier than logic does. `estimatedWords` was the variable that
    // carried the guess into the database.
    //
    // Scoped to identifiers that estimate a WORD or a COUNT, not to the word "estimate" as
    // such. `estimatedBytes` in the render planner is legitimate and load-bearing: it is
    // eCFR's own additive subtree `size`, used to decide how to split a part below
    // Cloudflare's 25 MiB per-file asset cap. Estimating a file layout is fine. Estimating a
    // measurement is the bug.
    test: /\b(?:\w*(?:estimat|approx|guess|fudge)\w*(?:word|count|total)\w*|\w*(?:word|count|total)\w*(?:estimat|approx|guess)\w*)\s*[=:(]/i,
    why:
      'an identifier naming an estimated word count. @ecfr-atlas/core deliberately has no ' +
      'estimate() constructor; if the value cannot be measured, it is unavailable() with a ' +
      'reason.',
  },
  {
    name: 'estimate() constructor',
    // The constructor core refuses to provide. If one appears, it was added somewhere else.
    test: /\bestimate[A-Za-z]*\s*\(\s*(?:\d|words|count)/i,
    why:
      'there is no estimate() in the Measurement API and adding one anywhere else routes ' +
      'around the reason it is missing.',
  },
  {
    name: 'proportional scaling of a count',
    // `words * ratio`, `count * fraction`, `wordCount * pct` — apportioning a measured total
    // across children by size. Plausible, and unmeasured.
    test: /\b\w*(?:word|count|total)\w*\s*[*]\s*\w*(?:ratio|fraction|pct|percent|share|proportion|factor)\w*/i,
    why:
      'scaling a measured total by a ratio invents a number for the part from a number for ' +
      'the whole. Measure the children and roll up.',
  },
];

describe('no proportional-estimate pattern in code that produces a word count', () => {
  it('scans something', () => {
    // Guards the guard. If a refactor moves the counter and nobody updates SCANNED_ROOTS,
    // every assertion below passes vacuously; this is the one that notices.
    expect(sources.length).toBeGreaterThan(5);
    const scanned = sources.map((file) => file.rel);
    expect(scanned).toContain('packages/ecfr/src/wordcount.ts');
    expect(scanned.some((rel) => rel.startsWith('scripts/sync/'))).toBe(true);
  });

  it.each(BANNED)('bans the $name', ({ test: pattern, why }) => {
    const hits: string[] = [];

    for (const file of sources) {
      const code = stripComments(file.lines.join('\n')).split('\n');
      code.forEach((line, index) => {
        if (pattern.test(line)) {
          // Report the ORIGINAL line, not the comment-stripped one, so the message shows what
          // the author actually wrote.
          hits.push(`${file.rel}:${index + 1}  ${(file.lines[index] ?? '').trim()}`);
        }
      });
    }

    expect(hits, `${why}\n\nOffending lines:\n${hits.join('\n')}`).toEqual([]);
  });

  it('catches the original line if it is ever reintroduced', () => {
    // Proves the patterns match the thing they claim to match. Without this, a typo in a regex
    // would make the whole file a no-op that reports success.
    const reintroduced = [
      'const chapterText = fullText.substring(0, estimatedWords * 6);',
      'let estimatedWords = ratio * titleWords;',
      'const bodyText = xmlText.slice(0, 1000);',
      'const words = wordCount * sizeRatio;',
      'const approxWordCount = bytes / 6;',
      'const wordEstimate = share * parentWords;',
      'return estimate(4200);',
    ];

    for (const line of reintroduced) {
      expect(
        BANNED.some((pattern) => pattern.test.test(line)),
        `no banned pattern matched: ${line}`,
      ).toBe(true);
    }
  });

  it('does not fire on legitimate code', () => {
    // The other half of calibration. A guard that also rejects ordinary code gets deleted the
    // first time it blocks a release, so these have to keep passing.
    const legitimate = [
      'const page = rows.slice(0, limit);',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: deliberate — this is a source-code FIXTURE the guard test scans, not a template mistake
      'return unavailable("unavailable_too_large", `over the ${maxChars}-character ceiling`);',
      'const shareOfScope = words / agencyCount;',
      'if (xmlBytes > 32 * 1024 * 1024) return null;',
      'const day = now.toISOString().slice(0, 10);',
      'const suffix = secret.slice(-4);',
      'for (let k = -d; k <= d; k += 2) {',
      'const half = Math.ceil(max / 2);',
      'const level = Math.min(baseLevel + structureDepth, 6);',
      // The render planner's asset-size arithmetic, which must stay legal.
      'estimatedBytes: group.reduce((sum, n) => sum + (n.xmlBytes ?? 0), 0),',
      'plan.oversized.push({ citation: parent.citation, estimatedBytes: parent.xmlBytes ?? 0 });',
      // Error plumbing that truncates an upstream response body for a log line.
      'this.bodySnippet = body.slice(0, 512);',
    ];

    for (const line of legitimate) {
      const matched = BANNED.filter((pattern) => pattern.test.test(line)).map((p) => p.name);
      expect(matched, `false positive on: ${line}`).toEqual([]);
    }
  });
});

describe('the Measurement contract cannot be bypassed', () => {
  it('nothing outside @ecfr-atlas/core constructs a Measurement object literally', () => {
    // `{ known: true, words: n, ... }` written by hand is a Measurement that skipped the
    // constructors and therefore skipped every invariant they enforce. The type system permits
    // it; this does not.
    const literal = /\bknown\s*:\s*true\b/;
    const hits: string[] = [];

    for (const file of sources) {
      if (file.rel.startsWith('packages/core/src/')) continue;
      const code = stripComments(file.lines.join('\n')).split('\n');
      code.forEach((line, index) => {
        if (literal.test(line))
          hits.push(`${file.rel}:${index + 1}  ${(file.lines[index] ?? '').trim()}`);
      });
    }

    expect(
      hits,
      'construct measurements with counted() / rolledUp() / reservedEmpty() / unavailable() ' +
        `from @ecfr-atlas/core.\n\nOffending lines:\n${hits.join('\n')}`,
    ).toEqual([]);
  });

  it('nothing suppresses a type error in code that produces a word count', () => {
    // `@ts-expect-error` over a Measurement is how the discriminated union stops being load-bearing.
    // Rule 6 bans it repo-wide; here it is enforced rather than asked for.
    const hits: string[] = [];
    for (const file of sources) {
      file.lines.forEach((line, index) => {
        if (/@ts-(?:ignore|nocheck)\b/.test(line)) {
          hits.push(`${file.rel}:${index + 1}  ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
