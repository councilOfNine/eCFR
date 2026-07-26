#!/usr/bin/env node
/**
 * Generate fixtures/seed.sql (and fixtures/content/) from a live eCFR pull.
 *
 * Run by a maintainer; the OUTPUT is committed. A contributor clones the repo, runs
 * `pnpm db:reset`, and has a working database with no network and no Cloudflare account.
 *
 *   node --max-old-space-size=8192 scripts/build-fixtures.ts
 *   node scripts/build-fixtures.ts --titles 1,3   # smaller, no 39 MB title-12 parse
 *   node scripts/build-fixtures.ts --no-network   # re-emit from fixtures/raw/, if present
 *
 * The heap flag is for title 12: 39,081,999 characters of XML, and the normalised tree is a
 * multiple of that. Titles 1 and 3 alone run fine in a default heap.
 *
 * ── WHY THIS DOES NOT CALL THE SYNC PIPELINE ────────────────────────────────
 *
 * It would be less code. It would also make the fixture worthless as a test input.
 *
 * The tests that matter here assert things like "a scope claimed by three agencies contributes
 * exactly one third to each deduplicated total" and "the corpus total equals the sum of
 * distinct scopes". If the fixture were produced by the same rollup code those tests exercise,
 * a bug in that code would produce a fixture that agrees with the bug, and every assertion
 * would pass while the numbers were wrong. The two implementations have to be independent for
 * the comparison to mean anything.
 *
 * The exceptions are deliberate and narrow:
 *
 *   - `flattenStructure` / `rollUpTree` from scripts/sync/lib/structure.ts. Citations are a
 *     naming CONVENTION, not a computation: apps/web and apps/api look rows up by the exact
 *     string this produces. A second implementation would not be an independent check, it
 *     would be a second chance to disagree, and the fixture would silently fail to resolve.
 *   - `@ecfr-atlas/core` for measurements and citation keys, and `@ecfr-atlas/ecfr` for
 *     parsing and counting. These are the contract. Reimplementing the word definition here
 *     would produce a fixture whose counts nothing else can reproduce.
 *   - `buildUpsert` from scripts/sync/lib/sql.ts, for SQL escaping only. Hand-rolling quoting
 *     in a generator that emits a committed file is how a fixture ends up with a broken
 *     apostrophe in an agency name.
 *
 * The agency rollups, the deduplication arithmetic and the overlap detection are computed
 * below, from first principles, in about eighty lines.
 *
 * ── POLITENESS ──────────────────────────────────────────────────────────────
 *
 * eCFR's limiter is a token bucket, not a concurrency gate, so serial requests do not avoid
 * it. Sustained <=8 req/s is clean; ~10 req/s is the onset. This makes at most
 * 3 + 3*titles requests with a fixed delay between them, which for three titles is twelve
 * requests over about four seconds.
 */

import './sync/lib/bootstrap.mjs';

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// Type-only imports are erased by both tsc and Node's stripping, so they may be static even
// though the VALUE imports below must stay dynamic (they resolve through the hook that
// bootstrap.mjs has only just registered).
import type { HierarchyLevel, Measurement, Scope } from '@ecfr-atlas/core';
import type { Agency, ContentVersion, StructureNodeType } from '@ecfr-atlas/core/ecfr-schemas';
import type { FlatNode } from './sync/lib/structure.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const { narrowestLevel, refKey, toScope, scopeContains, toRow, unavailable, WordCountStatus } =
  await import('@ecfr-atlas/core');
const { STRUCTURE_NODE_TYPES } = await import('@ecfr-atlas/core/ecfr-schemas');
const { AgenciesResponse, StructureResponse, TitlesResponse, VersionsResponse } = await import(
  '@ecfr-atlas/core/ecfr-schemas'
);
const { measureNode, parseXml, findNode, toHtml, isReservedNode } = await import(
  '@ecfr-atlas/ecfr'
);
const { flattenStructure, rollUpTree, LEAF_TYPES } = await import('./sync/lib/structure.js');
const sql = await import('./sync/lib/sql.js');

// ─── configuration ───────────────────────────────────────────────────────────

const ECFR_BASE = 'https://www.ecfr.gov';
const USER_AGENT = 'ecfr-atlas-fixtures/0.1 (+https://github.com/councilOfNine/eCFR)';

/**
 * Milliseconds between requests. 8 req/s is the measured clean ceiling; 150 ms is 6.7 req/s
 * with margin, and this script is not in anyone's critical path.
 */
const REQUEST_INTERVAL_MS = 150;

/**
 * Titles whose structure tree, measurements and amendments go into the fixture.
 *
 * 1, 3 and 12 between them cover every shape the site has to render, which is why these three
 * and not three others:
 *
 *   1   — subchapters, reserved sections, 368 nodes. Fully measured: 63,713 words.
 *   3   — no subchapters at all, a whole reserved part (103-199), 33 nodes. 3,961 words.
 *   12  — 8,861 nodes and 488 parts between the three, which is the scale at which a
 *         table-of-contents query stops being trivially fast. It also contains the single
 *         `hed1` node that makes its own ancestor chain unmeasurable, so the fixture has a
 *         real `unavailable` title total alongside two real measured ones. A fixture where
 *         every number is known would let a page that renders `null` as `0` pass review.
 */
const DEFAULT_FIXTURE_TITLES: readonly number[] = [1, 3, 12];

interface XmlFixture {
  title: number;
  part: string | null;
  why: string;
}

/**
 * Small real XML slices committed under fixtures/xml/ for the parser and counter tests.
 *
 * Fetched separately with `?part=`, which genuinely slices — unlike `?chapter=` and
 * `?subtitle=`, which validate and return the entire title.
 */
const XML_FIXTURES: readonly XmlFixture[] = [
  { title: 1, part: '51', why: '1 CFR Part 51, six sections, AUTH + SOURCE boilerplate' },
  { title: 3, part: '101', why: '3 CFR Part 101, seven short sections' },
  { title: 3, part: null, why: 'all of title 3: chapter, parts, reserved sections, reserved part' },
];

/** Months of amendment history to keep. Enough for the timeline component to have a shape. */
const AMENDMENT_MONTHS = 24;

/** Parts whose rendered HTML is written to fixtures/content/. */
const MAX_CONTENT_PARTS = 30;

/** The one run id every fixture row claims. Insert-then-prune needs a coherent watermark. */
const RUN_ID = 1;

// ─── argv ────────────────────────────────────────────────────────────────────

interface CliOptions {
  titles: number[];
  network: boolean;
  out: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    titles: [...DEFAULT_FIXTURE_TITLES],
    network: true,
    out: 'fixtures',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--titles') {
      const value = argv[++i] ?? '';
      options.titles = value
        .split(',')
        .map((n) => Number.parseInt(n.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 50);
      if (options.titles.length === 0) fail('--titles needs at least one CFR title number');
    } else if (arg === '--no-network') {
      options.network = false;
    } else if (arg === '--out') {
      options.out = argv[++i] ?? 'fixtures';
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const HELP = `build-fixtures — regenerate fixtures/seed.sql from eCFR

  --titles 1,3      titles to include in full (default 1,3,12)
  --no-network      re-emit from the cached responses in fixtures/raw/
  --out DIR         output directory (default fixtures)

All 50 titles, all agencies and all CFR references are always included; --titles
controls which titles get a structure tree, word counts and amendments.
`;

function fail(message: string): never {
  process.stderr.write(`build-fixtures: ${message}\n`);
  process.exit(1);
}

function log(message: string): void {
  process.stdout.write(`build-fixtures: ${message}\n`);
}

// ─── fetching ────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let lastRequestAt = 0;

/**
 * One polite GET, validated at the boundary.
 *
 * Retries are blind exponential backoff with jitter, because the 429 arrives from bare nginx
 * with no Retry-After. The 504 is the origin's XML generation timing out on a large title —
 * measured as a coin flip on isolated title-49 fetches — so it gets the same treatment with a
 * longer ceiling.
 */
async function ecfrGet(pathname: string): Promise<unknown>;
async function ecfrGet(pathname: string, options: { json: false }): Promise<string>;
async function ecfrGet(pathname: string, { json = true } = {}): Promise<unknown> {
  const url = `${ECFR_BASE}${pathname}`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = Math.max(0, lastRequestAt + REQUEST_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          // The corpus compresses 4.96x. Not asking for it is rude and slow.
          'Accept-Encoding': 'gzip',
          Accept: json ? 'application/json' : 'application/xml',
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`  network error on ${pathname} (attempt ${attempt + 1}): ${reason}`);
      await sleep(Math.floor(Math.random() * Math.min(1000 * 2 ** attempt, 8000)));
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      log(`  HTTP ${response.status} on ${pathname} (attempt ${attempt + 1}), backing off`);
      await sleep(Math.floor(Math.random() * Math.min(1000 * 2 ** attempt, 8000)));
      continue;
    }
    if (!response.ok) fail(`HTTP ${response.status} for ${url}`);

    return json ? response.json() : response.text();
  }

  fail(`gave up on ${url} after 5 attempts`);
}

/**
 * A window of amendments for one title, guaranteed complete.
 *
 * TWO upstream traps, both measured against the live API on 2026-07-26:
 *
 *   1. The UNFILTERED /versions response is paged at 1,000 rows. Title 12 has 18,752 versions
 *      and returns page 1 of 19 with no indication in the body that anything is missing except
 *      `meta.total_pages` — which arrives as the STRING "19". `VersionsResponse` in
 *      @ecfr-atlas/core declares `total_pages: z.number().int()`, so parsing that response
 *      throws. Small titles (1, 3) omit the paging keys entirely and parse fine, which is
 *      exactly the shape of bug that ships: it works on everything you tested it on.
 *
 *   2. The FILTERED (`?issue_date[gte]=`) response omits `meta.total_pages` altogether, so a
 *      truncated 1,000-row page is indistinguishable from a complete one.
 *
 * So: filter, and treat a full page as evidence of truncation rather than a coincidence.
 * Halving the window and retrying converges quickly and never publishes a partial history as
 * if it were whole.
 */
async function fetchAmendments(
  titleNumber: number,
  anchorDay: string,
  months: number,
): Promise<ContentVersion[]> {
  const VERSIONS_PAGE_SIZE = 1000;

  for (let window = months; window >= 1; window = Math.floor(window / 2)) {
    const cutoff = new Date(`${anchorDay}T00:00:00Z`);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - window);
    const since = cutoff.toISOString().slice(0, 10);

    const body = await cached(RAW_DIR, `versions-${titleNumber}-${since}.json`, () =>
      ecfrGet(`/api/versioner/v1/versions/title-${titleNumber}.json?issue_date%5Bgte%5D=${since}`),
    );
    const rows = VersionsResponse.parse(JSON.parse(body)).content_versions;

    if (rows.length < VERSIONS_PAGE_SIZE) {
      log(`  amendment window ${since}..${anchorDay}: ${rows.length} rows, complete`);
      return rows;
    }
    log(`  amendment window ${since}.. returned a full page (${rows.length}); halving`);
  }

  fail(`could not get an untruncated amendment window for title ${titleNumber}`);
}

/** Cache every raw response so `--no-network` can rebuild without touching eCFR again. */
async function cached(
  rawDir: string,
  name: string,
  loader: () => Promise<unknown>,
): Promise<string> {
  const file = path.join(rawDir, name);
  if (!OPTIONS.network) {
    if (!existsSync(file)) fail(`--no-network but ${file} is missing; run once with network`);
    return readFile(file, 'utf8');
  }
  const body = await loader();
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  await writeFile(file, text);
  return text;
}

// ─── the build ───────────────────────────────────────────────────────────────

const OPTIONS = parseArgs(process.argv.slice(2));
const OUT_DIR = path.resolve(REPO_ROOT, OPTIONS.out);
const RAW_DIR = path.join(OUT_DIR, 'raw');
const CONTENT_DIR = path.join(OUT_DIR, 'content');

await mkdir(RAW_DIR, { recursive: true });
await rm(CONTENT_DIR, { recursive: true, force: true });
await mkdir(CONTENT_DIR, { recursive: true });

log(`titles in full: ${OPTIONS.titles.join(', ')}`);

// ── reference data: every title, every agency, every CFR reference ──

const titlesRaw: unknown = JSON.parse(
  await cached(RAW_DIR, 'titles.json', () => ecfrGet('/api/versioner/v1/titles.json')),
);
const titles = TitlesResponse.parse(titlesRaw).titles;
log(`${titles.length} titles (${titles.filter((t) => t.reserved).length} reserved)`);

const agenciesRaw: unknown = JSON.parse(
  await cached(RAW_DIR, 'agencies.json', () => ecfrGet('/api/admin/v1/agencies.json')),
);
const agencyTree = AgenciesResponse.parse(agenciesRaw).agencies;

/** One flattened agency, in `agency`-table column shape. */
interface AgencyRow {
  slug: string;
  name: string;
  short_name: string | null;
  display_name: string;
  sortable_name: string;
  parent_slug: string | null;
  depth: number;
}

/**
 * One CFR reference, carried through the whole build: resolved to a node citation after the
 * fixture titles are flattened, and given a word count after they are measured. Both start
 * null and STAY null for scopes outside the fixture titles — that partiality is deliberate
 * and documented in the emitted seed header.
 */
interface FixtureReference {
  agencySlug: string;
  scope: Scope;
  /** The canonical scope key. The single most important field in the fixture — see below. */
  key: string;
  level: HierarchyLevel;
  nodeCitation: string | null;
  words: number | null;
}

/**
 * Flatten eCFR's two-level agency tree.
 *
 * `depth` is stored because the site indents child agencies, and eCFR only ever nests one
 * level — but the walk is recursive anyway, since a schema that permits deeper nesting will
 * eventually contain it.
 */
const agencies: AgencyRow[] = [];
const references: FixtureReference[] = [];

function visitAgency(agency: Agency, parentSlug: string | null, depth: number): void {
  agencies.push({
    slug: agency.slug,
    name: agency.name,
    short_name: agency.short_name ?? null,
    display_name: agency.display_name,
    sortable_name: agency.sortable_name,
    parent_slug: parentSlug,
    depth,
  });

  for (const ref of agency.cfr_references ?? []) {
    const scope = toScope(ref);
    references.push({
      agencySlug: agency.slug,
      scope,
      // The single most important line in the fixture. Reading `chapter` while a narrower
      // `subchapter`/`part` sits on the same reference is what over-credited one agency 12.7x.
      key: refKey(scope),
      level: narrowestLevel(scope),
      nodeCitation: null,
      words: null,
    });
  }

  for (const child of agency.children ?? []) visitAgency(child, agency.slug, depth + 1);
}

for (const agency of agencyTree) visitAgency(agency, null, 0);

// eCFR really does list the same scope twice on one agency (with and without an empty
// subchapter). refKey() collapses those; this drops the duplicate row the old unique index
// would have kept.
const uniqueReferences = [
  ...new Map(references.map((r) => [`${r.agencySlug}|${r.key}`, r])).values(),
];

// The 12.7x over-credit in one number: references that name a chapter AND something narrower.
// Reading the chapter and ignoring the part is what the predecessor did, and it is invisible
// unless you count these on purpose.
const narrowerThanChapter = uniqueReferences.filter(
  (r) => r.scope.chapter && (r.level === 'subchapter' || r.level === 'part'),
).length;

log(
  `${agencies.length} agencies, ${uniqueReferences.length} references ` +
    `(${references.length - uniqueReferences.length} duplicate scope claims collapsed, ` +
    `${narrowerThanChapter} name a chapter and something narrower)`,
);

// ── the small XML slices the parser and counter tests assert exact counts against ──

const XML_DIR = path.join(OUT_DIR, 'xml');
await mkdir(XML_DIR, { recursive: true });

for (const fixture of XML_FIXTURES) {
  const title = titles.find((t) => t.number === fixture.title);
  const date = title?.latest_issue_date;
  if (!date) fail(`title ${fixture.title} has no latest_issue_date`);

  const name = fixture.part
    ? `title-${fixture.title}-part-${fixture.part}-${date}.xml`
    : `title-${fixture.title}-full-${date}.xml`;

  // Skipped when already present: these files are asserted against by exact word count, so
  // silently replacing one with a newer eCFR revision would break tests for a reason nobody
  // would look for. Delete the file to refresh it deliberately.
  if (existsSync(path.join(XML_DIR, name))) continue;

  const xml = await ecfrGet(
    `/api/versioner/v1/full/${date}/title-${fixture.title}.xml` +
      (fixture.part ? `?part=${encodeURIComponent(fixture.part)}` : ''),
    { json: false },
  );
  await writeFile(path.join(XML_DIR, name), xml);
  log(`wrote fixtures/xml/${name} — ${fixture.why}`);
}

// ── per-title: structure, measurements, amendments ──

/** `amendment`-table column shape. */
interface AmendmentRow {
  title_number: number;
  section_identifier: string;
  amendment_date: string;
  issue_date: string;
  part: string | null;
  subpart: string | null;
  name: string | null;
  removed: boolean;
  substantive: boolean;
}

/** `title_watermark`-table column shape. */
interface WatermarkRow {
  title_number: number;
  latest_amended_on: string | null;
  latest_issue_date: string | null;
  last_synced_at: string;
  last_synced_run_id: number;
}

/** Every FlatNode across every fixture title, in document order. */
const allNodes: FlatNode[] = [];
/** citation -> Measurement. */
const measurements = new Map<string, Measurement>();
const amendments: AmendmentRow[] = [];
const watermarks: WatermarkRow[] = [];
const contentKeys = new Map<string, string>();

/** eCFR's `type` field is an open string; findNode's selector is not. Guard, don't cast. */
const isStructureNodeType = (value: string): value is StructureNodeType =>
  (STRUCTURE_NODE_TYPES as readonly string[]).includes(value);

let contentWritten = 0;

for (const titleNumber of OPTIONS.titles) {
  const title = titles.find((t) => t.number === titleNumber);
  if (!title) fail(`eCFR does not list title ${titleNumber}`);
  if (title.reserved) {
    log(`title ${titleNumber} is reserved; nothing to fetch`);
    continue;
  }

  // Content is addressable by ISSUE date. amendment_date differs from issue_date in 49.7% of
  // rows, and fetching on the wrong one silently returns a different snapshot.
  const date = title.latest_issue_date;
  if (!date) fail(`title ${titleNumber} has no latest_issue_date`);

  log(`title ${titleNumber} (${title.name}) @ ${date}`);

  const structure = StructureResponse.parse(
    JSON.parse(
      await cached(RAW_DIR, `structure-${titleNumber}.json`, () =>
        ecfrGet(`/api/versioner/v1/structure/${date}/title-${titleNumber}.json`),
      ),
    ),
  );

  const xml = await cached(RAW_DIR, `title-${titleNumber}.xml`, () =>
    ecfrGet(`/api/versioner/v1/full/${date}/title-${titleNumber}.xml`, { json: false }),
  );

  const nodes = flattenStructure(structure, titleNumber);
  allNodes.push(...nodes);
  log(`  ${nodes.length} structure nodes, ${xml.length} chars of XML`);

  // ── measure ──
  //
  // Parse once, then locate each leaf in the parsed tree. Locating by (type, identifier)
  // rather than by position is not an optimisation: DIV levels are not sequential — title 7
  // jumps DIV2 -> DIV5 thirty-five times — so there is no positional walk that is correct.
  const root = parseXml(xml);
  const leafMeasurements = new Map<string, Measurement>();
  let missing = 0;

  for (const node of nodes) {
    // A leaf is anything with no children, not only a section or an appendix.
    //
    // `LEAF_TYPES` alone leaves 26 nodes in titles 1/3/12 unmeasured, and every one of them
    // makes its whole ancestor chain unavailable through `rollUp()` — including the title. They
    // are eCFR's structural placeholders: 9 parts and 4 subparts labelled literally
    // "Part 15—XXX", plus one unnamed `hed1`, each with `size: 0`, no children, and
    // `reserved: false`. Real nodes, genuinely empty, and not reserved, so nothing in the
    // type-based rule reaches them.
    //
    // Measuring them from XML is the honest resolution: they either appear in the document with
    // no countable text (a measured 0) or they do not appear at all (unavailable, with a
    // reason). Neither outcome is a guess, and the difference is exactly the one the
    // `reserved_empty`/`counted(0)`/`unavailable` distinction exists to record.
    const isLeaf = LEAF_TYPES.has(node.nodeType) || node.childCitations.length === 0;
    if (!isLeaf) continue;
    if (node.identifier === null) {
      // A `hed1` has no `N` attribute, so there is nothing to locate it by and no honest way
      // to measure it. eCFR reports it at size 0 and 151 of them exist corpus-wide, which
      // means 151 ancestor chains — up to and including their titles — roll up to
      // `unavailable`. That is the correct behaviour of `rollUp()` given an unknown child, and
      // it is a real gap in the pipeline rather than one this generator should paper over.
      // Recording it as unknown is what makes it visible on /data-quality.
      leafMeasurements.set(
        node.citation,
        unavailable(
          WordCountStatus.NotComputed,
          `${node.citation} carries no identifier, so it cannot be located in the XML`,
        ),
      );
      missing++;
      continue;
    }
    // A node type outside the known vocabulary cannot be named to findNode; measureNode(null)
    // records it as unavailable with the standard not-in-XML reason, same as a failed lookup.
    const element = isStructureNodeType(node.nodeType)
      ? findNode(root, { type: node.nodeType, identifier: node.identifier })
      : null;
    const measurement = measureNode(element, { xmlBytes: node.xmlBytes ?? undefined });
    if (!measurement.known) missing++;
    leafMeasurements.set(node.citation, measurement);
  }

  for (const [citation, measurement] of rollUpTree(nodes, leafMeasurements)) {
    measurements.set(citation, measurement);
  }
  log(`  measured ${leafMeasurements.size} leaves (${missing} unavailable)`);

  // ── render a sample of parts ──
  for (const node of nodes) {
    if (node.nodeType !== 'part' || node.identifier === null) continue;
    if (contentWritten >= MAX_CONTENT_PARTS) break;
    const element = findNode(root, { type: 'part', identifier: node.identifier });
    if (!element || isReservedNode(element)) continue;

    const { html } = toHtml(element, { headingLevel: 2 });
    // Gzipped because R2 serves them gzipped and because a fixture directory of raw HTML is
    // most of a repository's weight for none of its value.
    const key = `parts/title-${titleNumber}/part-${node.identifier}.html`;
    await writeFile(path.join(CONTENT_DIR, `${key.replaceAll('/', '__')}.gz`), gzipSync(html));
    contentKeys.set(node.citation, key);
    contentWritten++;
  }

  // ── amendments ──
  //
  // The window is measured back from the TITLE's own last amendment, not from today. Title 1
  // was last amended 2022-12-29 and title 3 in 2015; a window anchored to `now` returns nothing
  // for either, and a fixture with an empty amendment table cannot exercise the timeline
  // component at all. Anchoring to the title gives "the last 24 months in which this title
  // actually changed", which is the history a reader of that title would see.
  const anchor = title.latest_amended_on ?? date;
  const kept = await fetchAmendments(titleNumber, anchor, AMENDMENT_MONTHS);

  for (const version of kept) {
    amendments.push({
      title_number: titleNumber,
      section_identifier: version.identifier,
      amendment_date: version.amendment_date,
      issue_date: version.issue_date,
      part: version.part ?? null,
      subpart: version.subpart ?? null,
      name: version.name ?? null,
      removed: version.removed === true,
      substantive: version.substantive !== false,
    });
  }
  log(`  ${kept.length} amendments in the last ${AMENDMENT_MONTHS} months of change`);

  watermarks.push({
    title_number: titleNumber,
    latest_amended_on: title.latest_amended_on ?? null,
    latest_issue_date: title.latest_issue_date ?? null,
    last_synced_at: new Date().toISOString(),
    last_synced_run_id: RUN_ID,
  });
}

// ─── resolve every reference to a node ───────────────────────────────────────

/**
 * A scope names a subtree; a citation names a node. Matching them means finding the node whose
 * own level equals the scope's narrowest level and whose ancestry matches everything above it.
 *
 * A scope matching MORE than one node resolves to nothing. That happens when a title reuses a
 * chapter identifier across subtitles, and picking either one would be a coin flip recorded as
 * a fact.
 */
function resolveScope(scope: Scope): string | null {
  const level = narrowestLevel(scope);
  const candidates = allNodes.filter((node) => {
    if (node.titleNumber !== scope.title) return false;
    if (node.nodeType !== level) return false;
    if (level === 'title') return true;
    if (node.identifier !== scope[level]) return false;
    if (scope.subtitle && level !== 'subtitle' && node.subtitleId !== scope.subtitle) return false;
    if (scope.chapter && level !== 'chapter' && node.chapterId !== scope.chapter) return false;
    if (scope.subchapter && level !== 'subchapter' && node.subchapterId !== scope.subchapter) {
      return false;
    }
    return true;
  });
  return candidates.length === 1 ? (candidates[0]?.citation ?? null) : null;
}

for (const ref of uniqueReferences) {
  ref.nodeCitation = OPTIONS.titles.includes(ref.scope.title) ? resolveScope(ref.scope) : null;
  const measurement = ref.nodeCitation ? measurements.get(ref.nodeCitation) : undefined;
  ref.words = measurement?.known ? measurement.words : null;
}

// ─── shared jurisdiction ─────────────────────────────────────────────────────

/** ref_key -> the slugs claiming it, ordered by sortable_name. */
const claimants = new Map<string, string[]>();
const sortableBySlug = new Map(agencies.map((a) => [a.slug, a.sortable_name]));

for (const ref of uniqueReferences) {
  const list = claimants.get(ref.key) ?? [];
  list.push(ref.agencySlug);
  claimants.set(ref.key, list);
}
for (const list of claimants.values()) {
  list.sort((a, b) => (sortableBySlug.get(a) ?? a).localeCompare(sortableBySlug.get(b) ?? b));
}

/** `scope_overlap`-table column shape. */
interface OverlapRow {
  ref_key: string;
  title_number: number;
  agency_count: number;
  agency_slugs: string;
  word_count: number | null;
}

const refByKey = new Map(uniqueReferences.map((r) => [r.key, r]));

const overlaps: OverlapRow[] = [...claimants.entries()]
  .filter(([, slugs]) => slugs.length > 1)
  .flatMap(([key, slugs]) => {
    const ref = refByKey.get(key);
    if (!ref) return []; // unreachable: claimants was built from uniqueReferences
    return [
      {
        ref_key: key,
        title_number: ref.scope.title,
        agency_count: slugs.length,
        agency_slugs: JSON.stringify(slugs),
        word_count: ref.words,
      },
    ];
  });
log(`${overlaps.length} scopes claimed by more than one agency`);

// ─── rollups ─────────────────────────────────────────────────────────────────

/**
 * Attributed vs deduplicated, computed from first principles.
 *
 *   attributed    — a shared scope counts IN FULL for every agency claiming it. Answers "what
 *                   is this agency responsible for?" These totals do not sum to the corpus,
 *                   and summing them is what published a CFR larger than the CFR.
 *   deduplicated  — a shared scope is split evenly among its claimants, so the corpus total is
 *                   conserved exactly. This is the dashboard headline.
 *
 * Two rules that are easy to get wrong and are the whole point of the exercise:
 *
 *   1. An agency claiming both a chapter and a part inside it must not count the part twice.
 *      Contained scopes are dropped before summing.
 *   2. If any surviving scope has no measured count, BOTH totals are null. A partial sum is an
 *      under-report that looks exactly like a measurement.
 */
function pruneContained(scopes: readonly FixtureReference[]): FixtureReference[] {
  return scopes.filter(
    (inner) => !scopes.some((outer) => outer !== inner && scopeContains(outer.scope, inner.scope)),
  );
}

const refsByAgency = new Map<string, FixtureReference[]>();
for (const ref of uniqueReferences) {
  const list = refsByAgency.get(ref.agencySlug) ?? [];
  list.push(ref);
  refsByAgency.set(ref.agencySlug, list);
}

const childrenBySlug = new Map<string, string[]>();
for (const agency of agencies) {
  if (!agency.parent_slug) continue;
  const list = childrenBySlug.get(agency.parent_slug) ?? [];
  list.push(agency.slug);
  childrenBySlug.set(agency.parent_slug, list);
}

interface ScopeTotals {
  attributed: number | null;
  deduplicated: number | null;
  refsTotal: number;
  refsCounted: number;
  shared: number;
  coverage: number;
}

function totalsFor(scopes: readonly FixtureReference[]): ScopeTotals {
  const kept = pruneContained(scopes);
  const refsTotal = kept.length;
  const refsCounted = kept.filter((ref) => ref.words !== null).length;

  if (refsTotal === 0) {
    // No claims is not the same as no data: the agency genuinely regulates nothing, which is a
    // measured zero at full coverage.
    return { attributed: 0, deduplicated: 0, refsTotal: 0, refsCounted: 0, shared: 0, coverage: 1 };
  }
  const shared = kept.filter((ref) => (claimants.get(ref.key)?.length ?? 1) > 1).length;
  const complete = refsCounted === refsTotal;

  let attributed = 0;
  let deduplicated = 0;
  for (const ref of kept) {
    if (ref.words === null) continue;
    attributed += ref.words;
    deduplicated += ref.words / (claimants.get(ref.key)?.length ?? 1);
  }

  return {
    attributed: complete ? attributed : null,
    // Rounded only at the very end, once, so the split of a shared scope is exact in the sum
    // rather than drifting by a word per claimant.
    deduplicated: complete ? Math.round(deduplicated) : null,
    refsTotal,
    refsCounted,
    shared,
    coverage: refsCounted / refsTotal,
  };
}

/** Scopes belonging to an agency and every descendant, deduplicated by key. */
function subtreeScopes(slug: string, seen = new Set<string>()): FixtureReference[] {
  if (seen.has(slug)) return [];
  seen.add(slug);
  const own = refsByAgency.get(slug) ?? [];
  const below = (childrenBySlug.get(slug) ?? []).flatMap((child) => subtreeScopes(child, seen));
  // Union by key: a parent and a child claiming the same scope is one scope in the subtree.
  return [...new Map([...own, ...below].map((ref) => [ref.key, ref])).values()];
}

/** `agency_rollup`-table column shape. */
interface RollupRow {
  agency_slug: string;
  attributed_word_count: number | null;
  deduplicated_word_count: number | null;
  subtree_attributed: number | null;
  subtree_deduplicated: number | null;
  refs_total: number;
  refs_counted: number;
  shared_refs: number;
  children_count: number;
  coverage_pct: number;
}

const rollups: RollupRow[] = agencies.map((agency) => {
  const own = totalsFor(refsByAgency.get(agency.slug) ?? []);
  const subtree = totalsFor(subtreeScopes(agency.slug));
  return {
    agency_slug: agency.slug,
    attributed_word_count: own.attributed,
    deduplicated_word_count: own.deduplicated,
    subtree_attributed: subtree.attributed,
    subtree_deduplicated: subtree.deduplicated,
    refs_total: own.refsTotal,
    refs_counted: own.refsCounted,
    shared_refs: own.shared,
    children_count: (childrenBySlug.get(agency.slug) ?? []).length,
    coverage_pct: own.coverage,
  };
});

// ─── emit ────────────────────────────────────────────────────────────────────

const sourceDate =
  titles
    .filter((t) => OPTIONS.titles.includes(t.number) && t.up_to_date_as_of)
    .map((t) => t.up_to_date_as_of)
    .sort()
    .at(-1) ?? new Date().toISOString().slice(0, 10);

const statements: string[] = [];

statements.push(`-- fixtures/seed.sql — GENERATED by scripts/build-fixtures.ts. Do not hand-edit.
--
-- Real eCFR data, partial by design. Regenerate with:
--   node scripts/build-fixtures.ts --titles ${OPTIONS.titles.join(',')}
--
-- REAL AND COMPLETE : every title (${titles.length}), every agency (${agencies.length}),
--                     every CFR reference (${uniqueReferences.length}), and the full structure
--                     tree, measured word counts and amendment history for title(s)
--                     ${OPTIONS.titles.join(', ')}.
-- REAL AND PARTIAL  : agency rollups. An agency whose scopes lie outside the fixture titles
--                     has refs it cannot resolve, so its totals are NULL with a coverage
--                     fraction below 1 — which is exactly what the site must render for an
--                     agency it cannot fully measure, and therefore worth having in a fixture.
-- NOT PRESENT       : the other ${titles.length - OPTIONS.titles.length} titles' structure and
--                     amendments, and agency_snapshot history beyond the two rows below.
--
-- Source: the Electronic Code of Federal Regulations, https://www.ecfr.gov
-- Snapshot: ${sourceDate}`);

statements.push(`
-- One synthetic run, marked succeeded, so app_meta can point at something and every
-- insert-then-prune watermark is coherent.
INSERT INTO sync_run (id, kind, status, started_at, finished_at, source_date,
                      titles_touched, nodes_upserted, nodes_pruned, fetch_failures, parse_failures, message)
VALUES (${RUN_ID}, 'backfill', 'succeeded', ${sql.sqlString(`${sourceDate}T00:00:00.000Z`)},
        ${sql.sqlString(`${sourceDate}T00:00:00.000Z`)}, ${sql.sqlString(sourceDate)},
        ${OPTIONS.titles.length}, ${allNodes.length}, 0, 0, 0,
        'fixture data generated by scripts/build-fixtures.ts')
ON CONFLICT (id) DO NOTHING;

UPDATE app_meta
   SET published_run_id = ${RUN_ID},
       published_at = ${sql.sqlString(`${sourceDate}T00:00:00.000Z`)},
       source_date = ${sql.sqlString(sourceDate)}
 WHERE id = 1;`);

function section(
  label: string,
  spec: import('./sync/lib/sql.js').TableSpec,
  rows: readonly import('./sync/lib/sql.js').Row[],
): void {
  if (rows.length === 0) return;
  statements.push(`\n-- ${label} (${rows.length} rows)`);
  // Chunked for the same reason the pipeline chunks: SQLite compiles a multi-row VALUES list
  // as a compound SELECT and has historically capped that at 500 terms.
  for (let i = 0; i < rows.length; i += 200) {
    statements.push(sql.buildUpsert(spec, rows.slice(i, i + 200)));
  }
}

section(
  'titles',
  sql.TITLE,
  titles.map((t) => ({
    number: t.number,
    name: t.name,
    latest_amended_on: t.latest_amended_on ?? null,
    latest_issue_date: t.latest_issue_date ?? null,
    up_to_date_as_of: t.up_to_date_as_of ?? null,
    reserved: t.reserved === true,
    last_seen_run_id: RUN_ID,
  })),
);

// Parents before children: agency.parent_slug references agency.slug.
section(
  'agencies',
  sql.AGENCY,
  [...agencies].sort((a, b) => a.depth - b.depth).map((a) => ({ ...a, last_seen_run_id: RUN_ID })),
);

section(
  'structure nodes',
  sql.STRUCTURE_NODE,
  allNodes.map((node) => {
    const measurement = measurements.get(node.citation);
    const row = toRow(
      measurement ?? unavailable(WordCountStatus.NotComputed, 'not reached by the fixture build'),
    );
    return {
      citation: node.citation,
      parent_citation: node.parentCitation,
      title_number: node.titleNumber,
      node_type: node.nodeType,
      identifier: node.identifier,
      label: node.label,
      reserved: node.reserved,
      subtitle_id: node.subtitleId,
      chapter_id: node.chapterId,
      subchapter_id: node.subchapterId,
      part_id: node.partId,
      xml_bytes: node.xmlBytes,
      content_key: contentKeys.get(node.citation) ?? null,
      word_count: row.word_count,
      word_count_status: row.word_count_status,
      word_count_method: row.word_count_method,
      word_count_reason: row.word_count_reason,
      word_count_run_id: RUN_ID,
      last_seen_run_id: RUN_ID,
    };
  }),
);

section(
  'agency CFR references',
  sql.AGENCY_CFR_REFERENCE,
  uniqueReferences.map((ref) => ({
    agency_slug: ref.agencySlug,
    ref_key: ref.key,
    title_number: ref.scope.title,
    narrowest_level: ref.level,
    subtitle_id: ref.scope.subtitle ?? null,
    chapter_id: ref.scope.chapter ?? null,
    subchapter_id: ref.scope.subchapter ?? null,
    part_id: ref.scope.part ?? null,
    node_citation: ref.nodeCitation ?? null,
    last_seen_run_id: RUN_ID,
  })),
);

section(
  'shared jurisdiction',
  sql.SCOPE_OVERLAP,
  overlaps.map((o) => ({ ...o, last_seen_run_id: RUN_ID })),
);

section(
  'agency rollups',
  sql.AGENCY_ROLLUP,
  rollups.map((r) => ({ ...r, last_seen_run_id: RUN_ID })),
);

// Two snapshots a month apart, so the history chart has a line rather than a point. The older
// one is the same data — a fixture must not invent a trend it did not measure.
section(
  'agency snapshots',
  sql.AGENCY_SNAPSHOT,
  rollups.flatMap((r) =>
    [sourceDate, shiftDays(sourceDate, -30)].map((snapshot_date) => ({
      agency_slug: r.agency_slug,
      snapshot_date,
      run_id: RUN_ID,
      attributed_word_count: r.attributed_word_count,
      deduplicated_word_count: r.deduplicated_word_count,
      coverage_pct: r.coverage_pct,
    })),
  ),
);

section(
  'amendments',
  sql.AMENDMENT,
  amendments.map((a) => ({ ...a, last_seen_run_id: RUN_ID })),
);
section(
  'title watermarks',
  sql.TITLE_WATERMARK,
  watermarks.map((w) => ({ ...w })),
);

function shiftDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

const seed = `${statements.join('\n')}\n`;
const seedPath = path.join(OUT_DIR, 'seed.sql');
await writeFile(seedPath, seed);

const manifest = {
  generated_by: 'scripts/build-fixtures.ts',
  source: ECFR_BASE,
  source_date: sourceDate,
  fixture_titles: OPTIONS.titles,
  counts: {
    titles: titles.length,
    agencies: agencies.length,
    references: uniqueReferences.length,
    structure_nodes: allNodes.length,
    measured_nodes: [...measurements.values()].filter((m) => m.known).length,
    unmeasured_nodes: [...measurements.values()].filter((m) => !m.known).length,
    overlaps: overlaps.length,
    amendments: amendments.length,
    rendered_parts: contentWritten,
  },
  seed_bytes: Buffer.byteLength(seed),
};
await writeFile(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

log(`wrote ${seedPath} (${(manifest.seed_bytes / 1024 / 1024).toFixed(2)} MB)`);
log(`wrote ${contentWritten} rendered parts to ${CONTENT_DIR}`);
log(JSON.stringify(manifest.counts));
