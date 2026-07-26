/**
 * Live measurement harness. NOT a CI test — see `vitest.config.ts` in this directory.
 *
 * It exists to answer questions that only real eCFR XML can answer, and it is the thing to run
 * before changing the exclusion list, the block-element set, or the HTML allowlist. Three
 * properties it checks, each of which caught a real defect while this module was written:
 *
 *   1. COMPOSITION. `measureNode(parent)` must equal `measureOwnText(parent)` plus the roll-up
 *      of its structure children. It does NOT equal the roll-up alone: 29 CFR 1910 holds 146
 *      words directly under the part, 21 CFR 201 holds 15, 26 CFR 20 holds 5. A pipeline that
 *      composes parents from children only under-reports those silently.
 *
 *   2. RENDER SAFETY. No `<img>`, no `src`, no `href`, no `on*` handler, no `<script>`, no raw
 *      DIVn, and balanced tags. The predecessor shipped 10,386 lowercase `<br>` and 101
 *      `<img>` into `dangerouslySetInnerHTML`.
 *
 *   3. VOCABULARY COVERAGE. Any element present in real XML that the renderer neither maps nor
 *      excludes is reported. Unmapped elements default to inline, so an unmapped BLOCK merges
 *      the last word of one paragraph into the first word of the next. This census is how
 *      EXAMPLE, P-2, FL-2, LDRFIG, BOXTXT, SCOL2, FRP, LDRWK, HED1 and SECAUTH were found, and
 *      how DIV9 appendices were found to be missing from the structure vocabulary entirely.
 *
 * The seven parts below are chosen for coverage, not size: tables and equations (40),
 * appendices (7, 12, 29), subject groups instead of subparts (26), the part containing the
 * largest section in the corpus (50), and worked examples (26).
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rollUp } from '@ecfr-atlas/core';
import { test } from 'vitest';
import type { XmlNode } from '../src/index.js';
import {
  childStructureNodes,
  EcfrClient,
  EXCLUDED_FROM_COUNT,
  findAllNodes,
  findNode,
  isElement,
  measureNode,
  measureOwnText,
  nodeTypeOf,
  parseXml,
  toHtml,
} from '../src/index.js';

/** Mirrors the renderer's allowlist. Kept here so a divergence surfaces as a census entry. */
const MAPPED = new Set([
  'P',
  'PSPACE',
  'FP',
  'FP1',
  'FP2',
  'FP-1',
  'FP-2',
  'FP1-2',
  'FP-DASH',
  'FLUSHTEXT',
  'HED',
  'HED1',
  'P-1',
  'P-2',
  'FL-1',
  'FL-2',
  'FRP',
  'EXAMPLE',
  'BOXTXT',
  'SCOL2',
  'LDRFIG',
  'LDRWK',
  'SECAUTH',
  'FTREF',
  'AC',
  'SECTNO',
  'SUBJECT',
  'EXTRACT',
  'NOTE',
  'NOTES',
  'EDNOTE',
  'EFFDNOT',
  'AUTH',
  'SOURCE',
  'CITA',
  'APPRO',
  'FTNT',
  'LI',
  'ITEM',
  'E',
  'EM',
  'I',
  'B',
  'STRONG',
  'SU',
  'SUP',
  'SUB',
  'FR',
  'BR',
  'HR',
  'IMG',
  'MATH',
  'TCAP',
  'BCAP',
  'XREF',
  'PRTPAGE',
  'TABLE',
  'CAPTION',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TH',
  'TD',
  'GPOTABLE',
  'TTITLE',
  'BOXHD',
  'CHED',
  'ROW',
  'ENT',
  'CONTENTS',
  'EAR',
  'HEAD',
  'HD1',
  'HD2',
  'HD3',
]);

const VOID_HTML = new Set(['br', 'hr']);

/** Sufficient because the renderer never emits a self-closing non-void tag. */
function unbalancedTags(html: string): string[] {
  const stack: string[] = [];
  const problems: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g)) {
    const name = match[2]!.toLowerCase();
    if (VOID_HTML.has(name)) continue;
    if (match[1] === '/') {
      if (stack.pop() !== name) problems.push(`unexpected </${name}>`);
    } else {
      stack.push(name);
    }
  }
  if (stack.length > 0) problems.push(`unclosed: ${stack.slice(0, 5).join(', ')}`);
  return problems;
}

const SAMPLES: readonly (readonly [number, string])[] = [
  [40, '60'],
  [7, '210'],
  [12, '1026'],
  [21, '201'],
  [26, '20'],
  [50, '17'],
  [29, '1910'],
];

test('live: composition, render safety, and vocabulary coverage', async () => {
  const lines: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
  };

  const client = new EcfrClient({ onWarning: (w) => say(`WARN ${JSON.stringify(w)}`) });
  const titles = (await client.fetchTitles()).titles;
  const unmapped = new Map<string, number>();

  for (const [titleNumber, partId] of SAMPLES) {
    const date = titles.find((t) => t.number === titleNumber)?.up_to_date_as_of;
    if (!date) {
      say(`${titleNumber} CFR ${partId}: no up_to_date_as_of, skipped`);
      continue;
    }

    let xml: string;
    try {
      xml = await client.fetchTitleXml(titleNumber, date, { part: partId });
    } catch (error) {
      say(`${titleNumber} CFR ${partId}: FETCH FAILED ${(error as Error).message}`);
      continue;
    }

    const root = parseXml(xml);
    const part = findNode(root, { type: 'part', identifier: partId });
    if (!part) {
      say(`${titleNumber} CFR ${partId}: part node NOT FOUND in ${xml.length} chars`);
      continue;
    }

    const whole = measureNode(part);
    const children = childStructureNodes(part);
    const rolled = rollUp(children.map((child) => measureNode(child)));
    const own = measureOwnText(part);
    const composed = (own.words ?? 0) + (rolled.words ?? 0);

    const kinds = new Map<string, number>();
    for (const node of findAllNodes(root, {})) {
      const kind = nodeTypeOf(node) ?? '?';
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }

    say(
      `${titleNumber} CFR ${partId}: xml=${xml.length} whole=${whole.words} ` +
        `children=${children.length} rollUp=${rolled.words} own=${own.words} ` +
        `composed=${composed} IDENTITY=${composed === whole.words ? 'HOLDS' : 'BROKEN'} ` +
        `kinds=${JSON.stringify(Object.fromEntries(kinds))}`,
    );

    let brokenChildren = 0;
    for (const child of children) {
      const grandchildren = childStructureNodes(child);
      if (grandchildren.length === 0) continue;
      const expected = measureNode(child).words;
      const actual =
        (measureOwnText(child).words ?? 0) +
        (rollUp(grandchildren.map((g) => measureNode(g))).words ?? 0);
      if (expected !== actual) brokenChildren += 1;
    }
    say(
      `   identity one level down: ${brokenChildren === 0 ? 'HOLDS' : `${brokenChildren} BROKEN`}`,
    );

    const html = toHtml(part).html;
    const problems = unbalancedTags(html);
    say(
      `   html=${html.length} balanced=${problems.length === 0 ? 'yes' : problems.join('|')} ` +
        `img=${/<img/i.test(html)} src=${/src=/i.test(html)} href=${/href=/i.test(html)} ` +
        `on*=${/\son[a-z]+\s*=/i.test(html)} script=${/<script/i.test(html)} ` +
        `rawDIVn=${/<DIV\d/i.test(html)}`,
    );

    (function census(node: XmlNode): void {
      if (!isElement(node)) return;
      const { name } = node;
      if (
        name !== '#DOCUMENT' &&
        !/^DIV\d*$/.test(name) &&
        !EXCLUDED_FROM_COUNT.has(name) &&
        !MAPPED.has(name)
      ) {
        unmapped.set(name, (unmapped.get(name) ?? 0) + 1);
      }
      node.children.forEach(census);
    })(root);
  }

  const census = Object.fromEntries([...unmapped.entries()].sort((a, b) => b[1] - a[1]));
  say(`\nUNMAPPED elements across all samples: ${JSON.stringify(census)}`);

  const out = path.join(mkdtempSync(path.join(tmpdir(), 'ecfr-probe-')), 'live-measure.txt');
  writeFileSync(out, `${lines.join('\n')}\n`);
  // Written to a file, not logged: vitest suppresses console output from passing tests and
  // this harness's entire purpose is its output.
  process.stderr.write(`\nlive probe report: ${out}\n`);
});
