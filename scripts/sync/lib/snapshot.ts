/**
 * The JSON snapshot the Astro build consumes. The deploy path's data.
 *
 * WHAT THIS IS AND WHY IT IS HERE
 *
 * `apps/web` can be built from two sources: a local D1 sqlite file (the contributor path,
 * `apps/web/src/data/sources/d1-sqlite.ts`) or this snapshot directory (the deploy path,
 * `apps/web/src/data/sources/snapshot-dir.ts`). Nothing wrote the second one. The web build
 * therefore had a documented, schema'd input format and no producer — every deploy either
 * failed at `manifest.json` or silently fell back to the fixture.
 *
 * THE SPEC IS NOT RESTATED HERE
 *
 * `apps/web/src/data/contract.ts` is the spec, and it is IMPORTED rather than mirrored. A
 * second copy of `PartPage` living in scripts/ would be a second opinion about the format, and
 * two opinions drift — which is the exact failure mode the contract file exists to prevent.
 * Every file emitted below goes through `parseChecked` from the web's own `schema.ts`, so the
 * validation that runs here is the same code that runs in the build: a snapshot that would
 * fail the build fails the SYNC instead, before it is published, next to the run that produced
 * it.
 *
 * That check is not a formality. `assertWordCountsCoherent` is what makes
 * `{ words: 104642, status: 'unavailable_fetch_failed' }` unwritable — the fabricated-number
 * shape this whole project exists to eliminate — at the one boundary where the D1 CHECK
 * constraints cannot reach, because a JSON file has no database behind it.
 *
 * ORDER OF OPERATIONS
 *
 * Rendered HTML is staged per run and only promoted into `content/` once the publish gate has
 * accepted the run. The contract forbids a `PartPage` whose `content_key` names a file that
 * does not exist, so every key written below is checked against the filesystem first; a part
 * whose body this run did not render (a nightly delta re-renders only what moved) publishes
 * `content_key: null` with a reason the reader sees, never a dangling pointer.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { Measurement, Scope } from '@ecfr-atlas/core';
import {
  CountMethod,
  displayCitation,
  ecfrUrl,
  narrowestLevel,
  parseRefKey,
  rollUp,
  scopeContains,
  unavailable,
  WordCountStatus,
} from '@ecfr-atlas/core';
import type { WordCount } from '@ecfr-atlas/core/api-schemas';
import type { Agency, Title } from '@ecfr-atlas/core/ecfr-schemas';
import type {
  AgencyRef,
  AgencyScope,
  ChapterRow,
  CorpusTotals,
  DataQualityGroup,
  PartRow,
  PartSliceRef,
  SectionEntry,
} from '../../../apps/web/src/data/contract.js';
/*
 * The four cross-package imports in this file, and why each is an import rather than a copy:
 *
 *   contract.ts  the format itself. See above.
 *   schema.ts    the cross-field measurement check the build runs. Copying it would let the
 *                two drift in the one direction that matters.
 *   order.ts     display ordering. Chapter IX must not sort before chapter VIII in a snapshot
 *                build and after it in a D1 build; identical output requires identical
 *                comparators.
 *   routes.ts    `sectionAnchor`, which the reader's in-page links resolve against. A second
 *                implementation would produce anchors that do not match the rendered ids.
 *
 * scripts/ is not a workspace package, so these resolve through the relative path. They are
 * type-only-plus-pure-functions; nothing Astro-specific is reachable from them.
 */
import {
  AgencyPage,
  AgencyRow,
  AmendmentSeries,
  ChapterPage,
  DataQuality,
  PartPage,
  RouteIndex,
  SharedScope,
  SnapshotManifest,
  TitlePage,
  TitleRow,
} from '../../../apps/web/src/data/contract.js';
import { byIdentifier, compareIdentifiers } from '../../../apps/web/src/data/order.js';
import { sectionAnchor } from '../../../apps/web/src/data/routes.js';
import { parseChecked } from '../../../apps/web/src/data/schema.js';

import type { D1 } from './d1.js';
import type { Logger } from './log.js';
import type { RenderPlan, RenderUnit } from './render.js';
import type { AgencyInput, RollupResult } from './rollup.js';
import { sqlString } from './sql.js';
import type { FlatNode } from './structure.js';

/**
 * Months of amendment history charted, and the per-status sample cap on /data-quality.
 *
 * Both restate constants in `apps/web/src/data/sources/d1-sqlite.ts`. They are duplicated
 * rather than imported because that module opens a sqlite database at import time; the numbers
 * are the contract between the two sources and a divergence would show as a chart that changes
 * width depending on how the site was built.
 */
const AMENDMENT_WINDOW_MONTHS = 36;
const DQ_SAMPLE_LIMIT = 50;

/**
 * One path segment, escaped the same way `snapshot-dir.ts` escapes it when it reads the file
 * back. CFR identifiers are not URL-safe integers (`50a`, `1926`, appendix suffixes), so both
 * sides must agree on the encoding or the loader opens a path that was never written.
 *
 * `encodeURIComponent` leaves `.` alone, so it would happily turn a part identifier of `..`
 * into a directory traversal out of the snapshot. No such identifier exists, and if one ever
 * appears the run should stop rather than write outside the tree it was given.
 */
const seg = (value: string | number): string => {
  const encoded = encodeURIComponent(String(value));
  if (encoded === '' || encoded === '.' || encoded === '..') {
    throw new Error(
      `refusing to build a snapshot path from the identifier ${JSON.stringify(String(value))}: ` +
        'it is not a usable directory name',
    );
  }
  return encoded;
};

/** Guard for a path built from corpus data: it must stay inside the directory it belongs to. */
function assertInside(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to write ${path}: it escapes ${root}`);
  }
  return path;
}

// ─── measurement envelopes ───────────────────────────────────────────────────

/**
 * `Measurement` -> `WordCount`.
 *
 * The two are the same fact in two vocabularies: core's discriminated union for arithmetic,
 * the API's object for the wire. Going through one function means the snapshot cannot invent a
 * combination the union cannot represent.
 */
export function toWordCount(measurement: Measurement): WordCount {
  return measurement.known
    ? {
        words: measurement.words,
        status: measurement.status,
        reason: null,
        method: measurement.method,
      }
    : { words: null, status: measurement.status, reason: measurement.reason, method: null };
}

const unknownWc = (reason: string): WordCount => ({
  words: null,
  status: WordCountStatus.NotComputed,
  reason,
  method: null,
});

/**
 * A rollup integer plus its coverage counters, as a `WordCount`.
 *
 * `agency_rollup` stores a nullable INTEGER with no status column, so a null there carries no
 * explanation. The reason is reconstructed from the coverage counters in the same row — the
 * wording is copied verbatim from `d1-sqlite.ts` because the contract names it as the
 * convention and because two sources that explain the same gap differently are two sources a
 * reader cannot compare.
 */
function wcFromRollup(
  value: number | null,
  refsTotal: number,
  refsCounted: number,
  kind: 'attributed' | 'deduplicated',
): WordCount {
  if (value !== null) {
    return {
      words: value,
      status: WordCountStatus.RolledUp,
      reason: null,
      method: CountMethod.DescendantSum,
    };
  }
  if (refsTotal === 0) {
    return unknownWc('this agency administers no CFR scope, so there is nothing to count');
  }
  return unknownWc(
    `${refsTotal - refsCounted} of ${refsTotal} scopes are not counted, so the ${kind} total ` +
      'cannot be summed',
  );
}

/** Same rule as core's `rollUp`: unknown unless every contributor is known. */
function sumOrUnknown(values: readonly (number | null)[], noun: string): WordCount {
  if (values.length === 0) return unknownWc(`there are no ${noun} to sum`);
  const missing = values.filter((v) => v === null).length;
  if (missing > 0) return unknownWc(`${missing} of ${values.length} ${noun} are not counted`);
  let total = 0;
  for (const value of values) total += value as number;
  return {
    words: total,
    status: WordCountStatus.RolledUp,
    reason: null,
    method: CountMethod.DescendantSum,
  };
}

// ─── staged content ──────────────────────────────────────────────────────────

/**
 * Rendered body HTML for one run, held outside `content/` until the gate accepts it.
 *
 * A refused run must leave the previously published snapshot byte-for-byte intact, and body
 * text is part of that snapshot. Writing straight into `content/` would mean a refused run
 * still replaced the text a later accepted run would then point at — text that was never
 * gate-checked, sitting under measurements from a different run.
 */
export class ContentStaging {
  readonly stagingDir: string;
  readonly contentDir: string;
  #staged = 0;

  constructor(snapshotDir: string, runId: number) {
    this.contentDir = join(snapshotDir, 'content');
    this.stagingDir = join(snapshotDir, `.staging-run-${runId}`);
  }

  get staged(): number {
    return this.#staged;
  }

  async write(contentKey: string, html: string): Promise<void> {
    const path = assertInside(this.stagingDir, join(this.stagingDir, `${contentKey}.html`));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, html, 'utf8');
    this.#staged += 1;
  }

  /** Move this run's HTML into `content/`. Returns how many files landed. */
  async promote(): Promise<number> {
    if (!existsSync(this.stagingDir)) return 0;
    let moved = 0;
    for (const file of await this.#walk(this.stagingDir)) {
      const target = assertInside(
        this.contentDir,
        join(this.contentDir, relative(this.stagingDir, file)),
      );
      await mkdir(dirname(target), { recursive: true });
      await rename(file, target);
      moved += 1;
    }
    await rm(this.stagingDir, { recursive: true, force: true });
    return moved;
  }

  async discard(): Promise<void> {
    await rm(this.stagingDir, { recursive: true, force: true });
  }

  /** True once `promote` has run and the key resolves to a file the build can open. */
  has(contentKey: string): boolean {
    return existsSync(join(this.contentDir, `${contentKey}.html`));
  }

  async #walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await this.#walk(path)));
      else out.push(path);
    }
    return out;
  }
}

// ─── amendments ──────────────────────────────────────────────────────────────

/**
 * Amendment activity, aggregated in D1 rather than carried in memory.
 *
 * A nightly delta only ever fetches its own window, so the run's in-memory rows are a few
 * hundred out of hundreds of thousands. The table is the only place the whole history lives,
 * and by the time this runs the gate has passed and the run's own rows are in it. Four GROUP
 * BY queries is a few thousand rows over the wire; the alternative — reading every amendment
 * row back through wrangler's JSON output — is tens of megabytes to compute a bar chart.
 */
export interface AmendmentIndex {
  total: number;
  latestIssueDate: string | null;
  /** `${title} ${part ?? ''}` -> `YYYY-MM` -> count, within the charted window. */
  monthly: Map<string, Map<string, number>>;
  /** `${title} ${part}` -> most recent amendment_date. */
  lastAmended: Map<string, string>;
}

const partKey = (title: number, part: string | null): string => `${title} ${part ?? ''}`;

/** First month of the charted window, `YYYY-MM`, derived from the newest issue_date present. */
function windowStart(latestIssueDate: string | null): string | null {
  if (!latestIssueDate) return null;
  const end = new Date(`${latestIssueDate}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() - (AMENDMENT_WINDOW_MONTHS - 1));
  return `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function readAmendmentIndex(d1: D1): Promise<AmendmentIndex> {
  const latest =
    (
      await d1.queryOne<{ d: string | null }>(
        'SELECT MAX(issue_date) AS d FROM amendment;',
        'amend-latest',
      )
    )?.d ?? null;
  const total =
    (await d1.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM amendment;', 'amend-total'))?.n ??
    0;

  const index: AmendmentIndex = {
    total,
    latestIssueDate: latest,
    monthly: new Map(),
    lastAmended: new Map(),
  };
  if (latest === null) return index;

  const start = windowStart(latest);
  const monthly = await d1.query<{
    title_number: number;
    part: string | null;
    month: string;
    n: number;
  }>(
    `SELECT title_number, part, substr(issue_date, 1, 7) AS month, COUNT(*) AS n
     FROM amendment
     WHERE issue_date >= ${sqlString(`${start ?? '0000-01'}-01`)}
     GROUP BY 1, 2, 3;`,
    'amend-monthly',
  );
  for (const row of monthly) {
    const key = partKey(row.title_number, row.part);
    const bucket = index.monthly.get(key) ?? new Map<string, number>();
    bucket.set(row.month, (bucket.get(row.month) ?? 0) + row.n);
    index.monthly.set(key, bucket);
  }

  for (const row of await d1.query<{ title_number: number; part: string; d: string }>(
    `SELECT title_number, part, MAX(amendment_date) AS d
     FROM amendment WHERE part IS NOT NULL GROUP BY 1, 2;`,
    'amend-last',
  )) {
    index.lastAmended.set(partKey(row.title_number, row.part), row.d);
  }

  return index;
}

/**
 * Contiguous months oldest -> newest, including the zero months.
 *
 * A chart with gaps where nothing happened reads as missing data; a quiet quarter is a fact
 * about the CFR and has to look like one. Mirrors `toSeries` in d1-sqlite.ts.
 */
function toSeries(
  counts: Map<string, number>,
  unattributable: number,
  latestIssueDate: string | null,
): AmendmentSeries {
  const start = windowStart(latestIssueDate);
  if (!start || !latestIssueDate) {
    return { buckets: [], total: 0, unattributable, from: null, to: null };
  }
  const end = latestIssueDate.slice(0, 7);
  const buckets: Array<{ month: string; count: number }> = [];
  const cursor = new Date(`${start}-01T00:00:00Z`);
  let total = 0;
  for (let i = 0; i < AMENDMENT_WINDOW_MONTHS; i += 1) {
    const month = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`;
    const count = counts.get(month) ?? 0;
    buckets.push({ month, count });
    total += count;
    if (month >= end) break;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return { buckets, total, unattributable, from: start, to: end };
}

// ─── input ───────────────────────────────────────────────────────────────────

export interface SnapshotInput {
  dir: string;
  runId: number;
  sourceDate: string | null;
  /** Every title eCFR listed, reserved ones included: the site lists all 50. */
  titles: readonly Title[];
  nodes: readonly FlatNode[];
  measurements: ReadonlyMap<string, Measurement>;
  agencies: readonly AgencyInput[];
  rawAgencies: readonly Agency[];
  rollup: RollupResult;
  plan: RenderPlan;
  amendments: AmendmentIndex;
  /** Per-agency time series, read from `agency_snapshot`. */
  history: ReadonlyMap<
    string,
    Array<{
      snapshot_date: string;
      attributed: number | null;
      deduplicated: number | null;
      coverage_pct: number | null;
    }>
  >;
  content: ContentStaging;
  log: Logger;
}

export interface SnapshotStats {
  files: number;
  /** Reader pages (a whole part, or one slice of a split part) that resolved to a body file. */
  pagesWithText: number;
  /**
   * Reader pages published with `content_key: null` and a reason.
   *
   * Expected to be large on a delta assembled on a fresh runner, which re-renders only the
   * parts that moved. It is a fact about the build, so it is counted and logged rather than
   * being allowed to look like a rendering failure.
   */
  pagesWithoutText: number;
}

// ─── the exporter ────────────────────────────────────────────────────────────

export async function writeSnapshot(input: SnapshotInput): Promise<SnapshotStats> {
  const log = input.log.child('snapshot');
  const stats: SnapshotStats = { files: 0, pagesWithText: 0, pagesWithoutText: 0 };

  const write = async (
    relPath: string,
    schema: Parameters<typeof parseChecked>[0],
    value: unknown,
  ): Promise<void> => {
    // Validate BEFORE writing, and write what the schema returned rather than what was passed
    // in, so an extra field cannot ride along into a file the build will re-validate.
    const checked: unknown = parseChecked(schema, value, `snapshot:${relPath}`);
    const path = assertInside(input.dir, join(input.dir, relPath));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(checked)}\n`, 'utf8');
    stats.files += 1;
  };

  // ── indexes over the run's in-memory structure ──

  const measurementOf = (citation: string): Measurement =>
    input.measurements.get(citation) ??
    unavailable(WordCountStatus.NotComputed, `no measurement was recorded for ${citation}`);
  const wcOf = (citation: string): WordCount => toWordCount(measurementOf(citation));

  const byCitation = new Map<string, FlatNode>();
  const byTitle = new Map<number, FlatNode[]>();
  for (const node of input.nodes) {
    byCitation.set(node.citation, node);
    const bucket = byTitle.get(node.titleNumber);
    if (bucket) bucket.push(node);
    else byTitle.set(node.titleNumber, [node]);
  }

  const titleNames = new Map(input.titles.map((t) => [t.number, t.name]));
  const nodesIn = (titleNumber: number): FlatNode[] => byTitle.get(titleNumber) ?? [];

  /**
   * Nodes of one type that have an identifier.
   *
   * 151 nodes corpus-wide have none (hed1 nodes and generated subject groups). They are real
   * structure and are counted, but they cannot be a route segment or a table row keyed on an
   * identifier, so every listing below is built from this rather than from a raw filter.
   */
  type Identified = FlatNode & { identifier: string };
  const identifiedIn = (titleNumber: number, nodeType: string): Identified[] =>
    nodesIn(titleNumber).filter(
      (n): n is Identified => n.nodeType === nodeType && n.identifier !== null,
    );

  const countIn = (titleNumber: number, nodeType: string): number =>
    nodesIn(titleNumber).filter((n) => n.nodeType === nodeType).length;

  // ── agencies ──

  const rawBySlug = new Map<string, Agency>();
  const collectRaw = (list: readonly Agency[]): void => {
    for (const agency of list) {
      rawBySlug.set(agency.slug, agency);
      collectRaw(agency.children ?? []);
    }
  };
  collectRaw(input.rawAgencies);

  const rollupBySlug = new Map(input.rollup.rollups.map((r) => [r.agencySlug, r]));

  const agencyRows: AgencyRow[] = input.agencies
    .map((agency): AgencyRow => {
      const r = rollupBySlug.get(agency.slug);
      const refsTotal = r?.refsTotal ?? 0;
      const refsCounted = r?.refsCounted ?? 0;
      return {
        slug: agency.slug,
        name: rawBySlug.get(agency.slug)?.name ?? agency.displayName,
        short_name: rawBySlug.get(agency.slug)?.short_name ?? null,
        display_name: agency.displayName,
        sortable_name: agency.sortableName,
        parent_slug: agency.parentSlug,
        depth: agency.depth,
        children_count: r?.childrenCount ?? 0,
        attributed: wcFromRollup(
          r?.attributedWordCount ?? null,
          refsTotal,
          refsCounted,
          'attributed',
        ),
        deduplicated: wcFromRollup(
          r?.deduplicatedWordCount ?? null,
          refsTotal,
          refsCounted,
          'deduplicated',
        ),
        subtree_attributed: wcFromRollup(
          r?.subtreeAttributed ?? null,
          refsTotal,
          refsCounted,
          'attributed',
        ),
        subtree_deduplicated: wcFromRollup(
          r?.subtreeDeduplicated ?? null,
          refsTotal,
          refsCounted,
          'deduplicated',
        ),
        coverage: { refs_total: refsTotal, refs_counted: refsCounted, pct: r?.coveragePct ?? 0 },
        shared_refs: r?.sharedRefs ?? 0,
      };
    })
    .sort((a, b) => a.sortable_name.localeCompare(b.sortable_name) || a.slug.localeCompare(b.slug));

  const agencyRowBySlug = new Map(agencyRows.map((row) => [row.slug, row]));
  const agencyRefOf = (slug: string): AgencyRef => ({
    slug,
    display_name: agencyRowBySlug.get(slug)?.display_name ?? slug,
  });
  const sortAgencyRefs = (slugs: Iterable<string>): AgencyRef[] =>
    [...new Set(slugs)]
      .sort((a, b) =>
        (agencyRowBySlug.get(a)?.sortable_name ?? a).localeCompare(
          agencyRowBySlug.get(b)?.sortable_name ?? b,
        ),
      )
      .map(agencyRefOf);

  // ── references ──

  const refsBySlug = new Map<string, RollupResult['references']>();
  const claimantsByRefKey = new Map<string, string[]>();
  for (const ref of input.rollup.references) {
    const bucket = refsBySlug.get(ref.agencySlug) ?? [];
    bucket.push(ref);
    refsBySlug.set(ref.agencySlug, bucket);
    const claimants = claimantsByRefKey.get(ref.refKey) ?? [];
    claimants.push(ref.agencySlug);
    claimantsByRefKey.set(ref.refKey, claimants);
  }
  /** First resolved node for a scope, for the label a shared-jurisdiction row shows. */
  const nodeForRefKey = new Map<string, string>();
  for (const ref of input.rollup.references) {
    if (ref.nodeCitation && !nodeForRefKey.has(ref.refKey)) {
      nodeForRefKey.set(ref.refKey, ref.nodeCitation);
    }
  }

  const scopeWordCount = (nodeCitation: string | null): WordCount =>
    nodeCitation === null
      ? unknownWc(
          'this reference does not resolve to a node in the current CFR structure, so there is ' +
            'nothing to measure',
        )
      : wcOf(nodeCitation);

  const toAgencyScope = (ref: RollupResult['references'][number]): AgencyScope => {
    const scope = parseRefKey(ref.refKey);
    return {
      ref_key: ref.refKey,
      title: scope.title,
      subtitle: scope.subtitle ?? null,
      chapter: scope.chapter ?? null,
      subchapter: scope.subchapter ?? null,
      part: scope.part ?? null,
      // Recomputed from the parsed scope rather than trusted from the column, exactly as
      // d1-sqlite does, so the two sources cannot disagree about which level a reference names.
      narrowest_level: narrowestLevel(scope),
      display: displayCitation(scope),
      ecfr_url: ecfrUrl(scope),
      word_count: scopeWordCount(ref.nodeCitation),
      label: ref.nodeCitation ? (byCitation.get(ref.nodeCitation)?.label ?? null) : null,
      node_citation: ref.nodeCitation,
      shared_with: sortAgencyRefs(
        (claimantsByRefKey.get(ref.refKey) ?? []).filter((slug) => slug !== ref.agencySlug),
      ),
    };
  };

  // ── amendment attribution ──

  /**
   * Amendments inside an agency's scopes.
   *
   * Exact, not estimated: each scope is expanded to the part identifiers that actually sit
   * inside it in the current structure, and only amendments naming one of those parts count.
   * Rows with no part identifier cannot be placed and are reported separately rather than
   * folded in — the difference between a chart and a guess.
   */
  const agencyAmendments = (refs: RollupResult['references']): AmendmentSeries => {
    if (refs.length === 0) return toSeries(new Map(), 0, input.amendments.latestIssueDate);

    const partsByTitle = new Map<number, Set<string>>();
    for (const ref of refs) {
      const set = partsByTitle.get(ref.titleNumber) ?? new Set<string>();
      partsByTitle.set(ref.titleNumber, set);
      if (ref.partId) {
        set.add(ref.partId);
        continue;
      }
      for (const node of nodesIn(ref.titleNumber)) {
        if (node.nodeType !== 'part' || !node.identifier) continue;
        if (ref.subchapterId) {
          if (node.subchapterId !== ref.subchapterId) continue;
        } else if (ref.chapterId) {
          if (node.chapterId !== ref.chapterId) continue;
        } else if (ref.subtitleId) {
          if (node.subtitleId !== ref.subtitleId) continue;
        }
        set.add(node.identifier);
      }
    }

    const counts = new Map<string, number>();
    let unattributable = 0;
    for (const [titleNumber, parts] of partsByTitle) {
      for (const part of parts) {
        for (const [month, n] of input.amendments.monthly.get(partKey(titleNumber, part)) ?? []) {
          counts.set(month, (counts.get(month) ?? 0) + n);
        }
      }
      for (const [, n] of input.amendments.monthly.get(partKey(titleNumber, null)) ?? []) {
        unattributable += n;
      }
    }
    return toSeries(counts, unattributable, input.amendments.latestIssueDate);
  };

  // ── render units, keyed by the part they belong to ──

  const unitsByPart = new Map<string, RenderUnit[]>();
  for (const unit of input.plan.units) {
    const bucket = unitsByPart.get(unit.partCitation) ?? [];
    bucket.push(unit);
    unitsByPart.set(unit.partCitation, bucket);
  }
  /** Route tail identifying a slice, e.g. `A--B`. Null for a unit that is the whole part. */
  const sliceIdOf = (unit: RenderUnit): string | null =>
    unit.splitOf === null ? null : (unit.route.split('/').pop() ?? null);

  // ── titles ──

  const titleRowOf = (title: Title): TitleRow => ({
    number: title.number,
    name: title.name,
    reserved: title.reserved,
    latest_amended_on: title.latest_amended_on,
    latest_issue_date: title.latest_issue_date,
    up_to_date_as_of: title.up_to_date_as_of,
    word_count: byCitation.has(`title-${title.number}`)
      ? wcOf(`title-${title.number}`)
      : unknownWc(
          title.reserved
            ? 'this title is reserved: it has no structure and no text to measure'
            : 'no structure node has been recorded for this title yet',
        ),
    chapters: countIn(title.number, 'chapter'),
    parts: countIn(title.number, 'part'),
    sections: countIn(title.number, 'section'),
  });

  const titleRows = [...input.titles].sort((a, b) => a.number - b.number).map(titleRowOf);

  const chapterRowOf = (node: FlatNode, parts: number, agencies: AgencyRef[]): ChapterRow => ({
    citation: node.citation,
    identifier: node.identifier ?? '',
    label: node.label || `Chapter ${node.identifier ?? ''}`,
    reserved: node.reserved,
    word_count: wcOf(node.citation),
    parts,
    agencies,
  });

  const partRowOf = (node: FlatNode, sections: number): PartRow => ({
    citation: node.citation,
    identifier: node.identifier ?? '',
    label: node.label || `Part ${node.identifier ?? ''}`,
    reserved: node.reserved,
    word_count: wcOf(node.citation),
    sections,
  });

  // ── collection files ──

  await write('titles.json', TitleRow.array(), titleRows);
  await write('agencies.json', AgencyRow.array(), agencyRows);

  // ── per-agency pages ──

  for (const row of agencyRows) {
    const refs = refsBySlug.get(row.slug) ?? [];
    const parentRow = row.parent_slug ? agencyRowBySlug.get(row.parent_slug) : undefined;
    await write(join('agency', `${seg(row.slug)}.json`), AgencyPage, {
      ...row,
      parent: parentRow ? { slug: parentRow.slug, display_name: parentRow.display_name } : null,
      children: agencyRows.filter((child) => child.parent_slug === row.slug),
      scopes: refs
        .map(toAgencyScope)
        .sort((a, b) => a.title - b.title || a.display.localeCompare(b.display)),
      amendments: agencyAmendments(refs),
      history: input.history.get(row.slug) ?? [],
    });
  }

  // ── per-title, per-chapter and per-part pages ──

  const routeChapters: Array<{ title: number; chapter: string }> = [];
  const routeParts: Array<{ title: number; part: string; subpart: string | null }> = [];

  for (const title of titleRows) {
    const nodes = nodesIn(title.number);
    const partNodes = identifiedIn(title.number, 'part');
    const sectionNodes = identifiedIn(title.number, 'section');

    const partsPerChapter = new Map<string, number>();
    for (const part of partNodes) {
      if (!part.chapterId) continue;
      partsPerChapter.set(part.chapterId, (partsPerChapter.get(part.chapterId) ?? 0) + 1);
    }

    const titleRefs = input.rollup.references.filter((r) => r.titleNumber === title.number);
    const chapterAgencies = new Map<string, Set<string>>();
    for (const ref of titleRefs) {
      if (!ref.chapterId) continue;
      const set = chapterAgencies.get(ref.chapterId) ?? new Set<string>();
      set.add(ref.agencySlug);
      chapterAgencies.set(ref.chapterId, set);
    }

    const chapterNodes = identifiedIn(title.number, 'chapter').sort(byIdentifier);

    const chapterList = chapterNodes.map((node) =>
      chapterRowOf(
        node,
        partsPerChapter.get(node.identifier) ?? 0,
        sortAgencyRefs(chapterAgencies.get(node.identifier) ?? []),
      ),
    );

    const subtitles = identifiedIn(title.number, 'subtitle')
      .sort(byIdentifier)
      .map((subtitle) => ({
        identifier: subtitle.identifier,
        label: subtitle.label || `Subtitle ${subtitle.identifier}`,
        chapters: chapterNodes
          .filter((c) => c.subtitleId === subtitle.identifier)
          .map((c) => c.identifier)
          .sort(compareIdentifiers),
      }));

    await write(join('title', `${seg(title.number)}.json`), TitlePage, {
      ...title,
      chapter_list: chapterList,
      subtitles,
      agencies: sortAgencyRefs(titleRefs.map((r) => r.agencySlug)),
    });

    const sectionsPerPart = new Map<string, number>();
    for (const section of sectionNodes) {
      if (!section.partId) continue;
      sectionsPerPart.set(section.partId, (sectionsPerPart.get(section.partId) ?? 0) + 1);
    }

    for (const chapterNode of chapterNodes) {
      const chapterId = chapterNode.identifier;
      routeChapters.push({ title: title.number, chapter: chapterId });

      const chapterParts = partNodes.filter((p) => p.chapterId === chapterId);
      const bySubchapter = new Map<string | null, Identified[]>();
      for (const part of chapterParts) {
        const bucket = bySubchapter.get(part.subchapterId) ?? [];
        bucket.push(part);
        bySubchapter.set(part.subchapterId, bucket);
      }
      const subchapterLabels = new Map(
        nodes
          .filter((n) => n.nodeType === 'subchapter' && n.chapterId === chapterId)
          .map((n) => [n.identifier, n.label]),
      );

      const scope: Scope = { title: title.number, chapter: chapterId };
      await write(
        join('title', seg(title.number), 'chapter', `${seg(chapterId)}.json`),
        ChapterPage,
        {
          ...chapterRowOf(
            chapterNode,
            chapterParts.length,
            // Both containment directions, as d1-sqlite does: an agency claiming the whole
            // chapter and an agency claiming one part inside it both belong on this page.
            sortAgencyRefs(
              titleRefs
                .filter((r) => {
                  const refScope = parseRefKey(r.refKey);
                  return scopeContains(refScope, scope) || scopeContains(scope, refScope);
                })
                .map((r) => r.agencySlug),
            ),
          ),
          title_number: title.number,
          title_name: title.name,
          ecfr_url: ecfrUrl(scope),
          display: displayCitation(scope),
          groups: [...bySubchapter.entries()]
            .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : compareIdentifiers(a, b)))
            .map(([identifier, rows]) => ({
              identifier,
              label: identifier === null ? null : (subchapterLabels.get(identifier) ?? null),
              part_list: rows
                .map((p) => partRowOf(p, sectionsPerPart.get(p.identifier) ?? 0))
                .sort(byIdentifier),
            })),
        },
      );
    }

    // Parts. One page per (title, identifier); a title that lists the same part identifier
    // twice would otherwise produce two files racing for one route.
    const seenPartIds = new Set<string>();
    for (const partNode of [...partNodes].sort((a, b) => a.citation.localeCompare(b.citation))) {
      const partId = partNode.identifier;
      if (seenPartIds.has(partId)) {
        log.warn('duplicate part identifier in one title; only the first gets a page', {
          title: title.number,
          part: partId,
          citation: partNode.citation,
        });
        continue;
      }
      seenPartIds.add(partId);

      const sections: SectionEntry[] = sectionNodes
        .filter((s) => s.partId === partId)
        .sort(byIdentifier)
        .map((s) => ({
          citation: s.citation,
          identifier: s.identifier,
          label: s.label || s.identifier,
          reserved: s.reserved,
          word_count: wcOf(s.citation),
          anchor: sectionAnchor(s.identifier),
        }));

      const units = unitsByPart.get(partNode.citation) ?? [];
      const split = units.length > 1 || units.some((u) => u.splitOf !== null);
      const slices: PartSliceRef[] = split
        ? units.map((unit) => ({
            subpart: sliceIdOf(unit),
            label: unit.label,
            word_count: toWordCount(rollUp(unit.citations.map(measurementOf))),
          }))
        : [];

      const scope: Scope = {
        title: title.number,
        ...(partNode.chapterId ? { chapter: partNode.chapterId } : {}),
        part: partId,
      };
      const chapterLabel = partNode.chapterId
        ? (nodes.find((n) => n.nodeType === 'chapter' && n.identifier === partNode.chapterId)
            ?.label ?? null)
        : null;
      const subchapterLabel = partNode.subchapterId
        ? (nodes.find((n) => n.nodeType === 'subchapter' && n.identifier === partNode.subchapterId)
            ?.label ?? null)
        : null;

      const base = {
        title_number: title.number,
        title_name: title.name,
        chapter: partNode.chapterId
          ? {
              identifier: partNode.chapterId,
              label: chapterLabel ?? `Chapter ${partNode.chapterId}`,
            }
          : null,
        subchapter: partNode.subchapterId
          ? {
              identifier: partNode.subchapterId,
              label: subchapterLabel ?? `Subchapter ${partNode.subchapterId}`,
            }
          : null,
        display: displayCitation(scope),
        ecfr_url: ecfrUrl(scope),
        // Authority, source and editorial notes live in the part's XML apparatus, which this
        // pipeline excludes from the count and does not currently carry through to storage.
        // Null is the honest answer; the reader renders nothing rather than an empty heading.
        authority: null,
        source_note: null,
        editorial_note: null,
        last_amended_on: input.amendments.lastAmended.get(partKey(title.number, partId)) ?? null,
        agencies: sortAgencyRefs(
          titleRefs
            .filter((r) => scopeContains(parseRefKey(r.refKey), scope))
            .map((r) => r.agencySlug),
        ),
        slices,
      };

      /** Resolve a unit's body to a key the build can open, or say why there is none. */
      const contentFor = (
        unit: RenderUnit | undefined,
      ): { content_key: string | null; content_unavailable_reason: string | null } => {
        if (unit && input.content.has(unit.contentKey)) {
          stats.pagesWithText += 1;
          return { content_key: unit.contentKey, content_unavailable_reason: null };
        }
        stats.pagesWithoutText += 1;
        return {
          content_key: null,
          content_unavailable_reason:
            'This build has no rendered text for this part. A nightly sync re-renders only the ' +
            'parts that changed, so a snapshot assembled on a fresh runner carries text for ' +
            'those parts alone. The full text is on the official eCFR, linked above.',
        };
      };

      const wholeUnit = split ? undefined : units[0];
      routeParts.push({ title: title.number, part: partId, subpart: null });
      await write(join('title', seg(title.number), 'part', `${seg(partId)}.json`), PartPage, {
        ...partRowOf(partNode, sections.length),
        ...base,
        // Null on a whole part AND on a slice index: this page is the part, not one piece.
        slice: null,
        section_list: sections,
        ...(split
          ? {
              content_key: null,
              content_unavailable_reason:
                'This part is published in slices because it is too large for one page. Choose a ' +
                'slice below to read its text.',
            }
          : contentFor(wholeUnit)),
      });

      if (!split) continue;

      for (const unit of units) {
        const sliceId = sliceIdOf(unit);
        if (sliceId === null) continue;
        const inSlice = new Set(unit.citations);
        const sliceSections = sections.filter(
          (s) =>
            inSlice.has(s.citation) || unit.citations.some((c) => s.citation.startsWith(`${c}/`)),
        );
        routeParts.push({ title: title.number, part: partId, subpart: sliceId });
        await write(
          join('title', seg(title.number), 'part', seg(partId), `${seg(sliceId)}.json`),
          PartPage,
          {
            ...partRowOf(partNode, sliceSections.length),
            ...base,
            slice: sliceId,
            section_list: sliceSections,
            ...contentFor(unit),
          },
        );
      }
    }
  }

  // ── shared jurisdiction ──

  await write(
    'shared-jurisdiction.json',
    SharedScope.array(),
    input.rollup.overlaps
      .map((overlap): SharedScope => {
        const scope = parseRefKey(overlap.refKey);
        const nodeCitation = nodeForRefKey.get(overlap.refKey) ?? null;
        return {
          ref_key: overlap.refKey,
          title_number: overlap.titleNumber,
          title_name: titleNames.get(overlap.titleNumber) ?? `Title ${overlap.titleNumber}`,
          display: displayCitation(scope),
          ecfr_url: ecfrUrl(scope),
          label: nodeCitation ? (byCitation.get(nodeCitation)?.label ?? null) : null,
          narrowest_level: narrowestLevel(scope),
          word_count:
            overlap.wordCount === null
              ? unknownWc('the scope itself has no measured word count')
              : {
                  words: overlap.wordCount,
                  status: WordCountStatus.RolledUp,
                  reason: null,
                  method: CountMethod.DescendantSum,
                },
          agencies: sortAgencyRefs(claimantsByRefKey.get(overlap.refKey) ?? []),
        };
      })
      .sort((a, b) => (b.word_count.words ?? -1) - (a.word_count.words ?? -1)),
  );

  // ── data quality ──

  const unknownNodes = input.nodes.filter((n) => !measurementOf(n.citation).known);
  const groups = new Map<string, DataQualityGroup>();
  const reasonCounts = new Map<string, Map<string, number>>();
  for (const node of unknownNodes) {
    const measurement = measurementOf(node.citation);
    if (measurement.known) continue;
    let group = groups.get(measurement.status);
    if (!group) {
      group = {
        status: measurement.status,
        count: 0,
        reasons: [],
        sample: [],
        sample_truncated: false,
      };
      groups.set(measurement.status, group);
    }
    group.count += 1;
    if (group.sample.length < DQ_SAMPLE_LIMIT) {
      group.sample.push({
        citation: node.citation,
        title_number: node.titleNumber,
        node_type: node.nodeType,
        label: node.label,
        reason: measurement.reason,
      });
    }
    const reasons = reasonCounts.get(measurement.status) ?? new Map<string, number>();
    reasons.set(measurement.reason, (reasons.get(measurement.reason) ?? 0) + 1);
    reasonCounts.set(measurement.status, reasons);
  }
  for (const [status, group] of groups) {
    group.reasons = [...(reasonCounts.get(status) ?? [])]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);
    group.sample_truncated = group.count > group.sample.length;
  }

  const unknownPerTitle = new Map<number, number>();
  for (const node of unknownNodes) {
    unknownPerTitle.set(node.titleNumber, (unknownPerTitle.get(node.titleNumber) ?? 0) + 1);
  }

  const unresolved = new Map<string, string[]>();
  for (const ref of input.rollup.references) {
    if (ref.nodeCitation !== null) continue;
    const bucket = unresolved.get(ref.refKey) ?? [];
    bucket.push(ref.agencySlug);
    unresolved.set(ref.refKey, bucket);
  }

  await write('data-quality.json', DataQuality, {
    nodes_total: input.nodes.length,
    nodes_known: input.nodes.length - unknownNodes.length,
    nodes_unknown: unknownNodes.length,
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
    by_title: titleRows
      .map((t) => ({
        title_number: t.number,
        title_name: t.name,
        unknown: unknownPerTitle.get(t.number) ?? 0,
        total: nodesIn(t.number).length,
      }))
      .filter((t) => t.unknown > 0)
      .sort((a, b) => b.unknown - a.unknown),
    partial_agencies: agencyRows
      .filter((a) => a.coverage.refs_total > 0 && a.coverage.pct < 1)
      .map((a) => ({ slug: a.slug, display_name: a.display_name, coverage: a.coverage }))
      .sort((a, b) => a.coverage.pct - b.coverage.pct),
    unresolved_refs: [...unresolved.entries()].map(([refKey, slugs]) => ({
      ref_key: refKey,
      display: displayCitation(parseRefKey(refKey)),
      agencies: sortAgencyRefs(slugs),
    })),
  });

  // ── corpus-wide amendment activity ──

  const corpusMonths = new Map<string, number>();
  for (const buckets of input.amendments.monthly.values()) {
    for (const [month, n] of buckets) corpusMonths.set(month, (corpusMonths.get(month) ?? 0) + n);
  }
  await write(
    'amendments.json',
    AmendmentSeries,
    toSeries(corpusMonths, 0, input.amendments.latestIssueDate),
  );

  // ── routes ──

  await write('routes.json', RouteIndex, {
    agencies: agencyRows.map((a) => a.slug),
    titles: titleRows.map((t) => t.number),
    chapters: routeChapters,
    parts: routeParts,
  });

  // ── manifest, written LAST ──
  //
  // The loader reads manifest.json first and refuses a version it does not understand. Writing
  // it last means a snapshot interrupted halfway through has no manifest and is rejected
  // outright, rather than being read as a complete snapshot that is missing two thirds of its
  // pages.

  const corpus: CorpusTotals = {
    deduplicated: sumOrUnknown(
      input.rollup.rollups.map((r) => r.deduplicatedWordCount),
      'agency rollups',
    ),
    attributed: sumOrUnknown(
      input.rollup.rollups.map((r) => r.attributedWordCount),
      'agency rollups',
    ),
    shared: sumOrUnknown(
      input.rollup.overlaps.map((o) => o.wordCount),
      'shared scopes',
    ),
    agencies: agencyRows.length,
    titles: titleRows.length,
    titles_reserved: titleRows.filter((t) => t.reserved).length,
    chapters: input.nodes.filter((n) => n.nodeType === 'chapter').length,
    parts: input.nodes.filter((n) => n.nodeType === 'part').length,
    sections: input.nodes.filter((n) => n.nodeType === 'section').length,
    structure_nodes: input.nodes.length,
    refs_total: input.rollup.references.length,
    shared_scopes: input.rollup.overlaps.length,
    amendments: input.amendments.total,
    nodes_unknown: unknownNodes.length,
  };

  await write('manifest.json', SnapshotManifest, {
    snapshot_version: 1,
    generated_at: new Date().toISOString(),
    run_id: input.runId,
    source_date: input.sourceDate,
    latest_issue_date: input.amendments.latestIssueDate,
    fixture: false,
    source: 'snapshot',
    corpus,
  } satisfies SnapshotManifest);

  // A snapshot is only as complete as the `content/` directory it was assembled against, and a
  // nightly delta re-renders only the parts that moved. On a runner where `content/` did not
  // survive from the previous run, most reader pages will honestly say they have no text — the
  // site is correct but nearly bodiless, and that is worth saying out loud rather than leaving
  // for someone to notice on the deployed page.
  if (stats.pagesWithoutText > stats.pagesWithText) {
    log.warn('most reader pages in this snapshot carry no body text', {
      withText: stats.pagesWithText,
      withoutText: stats.pagesWithoutText,
      contentDir: input.content.contentDir,
      hint: 'persist the snapshot content directory between runs, or run a backfill',
    });
  }

  log.info('snapshot written', {
    dir: input.dir,
    files: stats.files,
    pagesWithText: stats.pagesWithText,
    pagesWithoutText: stats.pagesWithoutText,
    agencies: agencyRows.length,
    titles: titleRows.length,
  });
  return stats;
}
