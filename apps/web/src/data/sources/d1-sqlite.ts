/**
 * `AtlasData` over a local D1 sqlite file. The contributor path.
 *
 * A contributor who has run `pnpm db:migrate:local` and a sync can build the whole site without
 * waiting for a snapshot export. Everything the schema can answer is answered here, from the
 * same tables the API reads.
 *
 * ONE DELIBERATE GAP: regulation body text. `structure_node.content_key` is a pointer into R2,
 * because six sections exceed D1's 2,000,000-byte row cap and 26 CFR Part 1 is 69,598,633 bytes.
 * A build from D1 therefore renders the reader with its citation, authority block, table of
 * contents and measurements, and an explicit notice in place of the text — never a blank page
 * and never a page that looks complete but is not. Use a snapshot when you need the prose.
 *
 * Subpart slicing is likewise absent here: there is no text to slice, so every part emits one
 * route and `slices: []`.
 */

import { existsSync } from 'node:fs';
import {
  CountMethod,
  displayCitation,
  ecfrUrl,
  narrowestLevel,
  parseRefKey,
  type Scope,
  scopeContains,
  WordCountStatus,
} from '@ecfr-atlas/core';
import type { WordCount } from '@ecfr-atlas/core/api-schemas';
import type {
  AgencyPage,
  AgencyRef,
  AgencyRow,
  AgencyScope,
  AmendmentSeries,
  AtlasData,
  ChapterPage,
  ChapterRow,
  CorpusTotals,
  DataQuality,
  DataQualityGroup,
  PartRow,
  PartView,
  RouteIndex,
  SectionEntry,
  SharedScope,
  SnapshotManifest,
  TitlePage,
  TitleRow,
} from '../contract.js';
import { byIdentifier, compareIdentifiers } from '../order.js';
import { sectionAnchor } from '../routes.js';

/** Months of amendment history charted. Long enough to show seasonality, short enough to read. */
const AMENDMENT_WINDOW_MONTHS = 36;

/** Cap on how many example nodes /data-quality lists per status. */
const DQ_SAMPLE_LIMIT = 50;

// ─── thin typed wrapper over node:sqlite ─────────────────────────────────────

interface Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface Database {
  prepare(sql: string): Statement;
  close(): void;
}

/**
 * node:sqlite returns rows as loosely-typed records. Each call site declares the row interface
 * it expects immediately above the SQL that produces it, which is as close to a checked mapping
 * as this gets without a query builder; the assertion is confined to these two helpers so there
 * is exactly one place to audit.
 */
function all<T>(db: Database, sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}
function one<T>(db: Database, sql: string, params: unknown[] = []): T | null {
  return (db.prepare(sql).get(...params) as T | undefined) ?? null;
}

// ─── measurement construction ────────────────────────────────────────────────

interface MeasuredRow {
  word_count: number | null;
  word_count_status: string;
  word_count_method: string | null;
  word_count_reason: string | null;
}

/**
 * Straight lift of the four columns. The table's CHECK constraints already guarantee the
 * combination is coherent, so this cannot manufacture the forbidden state — and if a hand-edited
 * database somehow contains one, src/data/schema.ts catches it before a page renders.
 */
function wcFromRow(row: MeasuredRow | null, absentReason: string): WordCount {
  if (row === null) {
    return {
      words: null,
      status: WordCountStatus.NotComputed,
      reason: absentReason,
      method: null,
    };
  }
  return {
    words: row.word_count,
    status: row.word_count_status as WordCount['status'],
    reason: row.word_count_reason,
    method: row.word_count_method as WordCount['method'],
  };
}

const unknownWc = (reason: string): WordCount => ({
  words: null,
  status: WordCountStatus.NotComputed,
  reason,
  method: null,
});

/**
 * `agency_rollup` stores a nullable INTEGER with no status column of its own, so a null there
 * carries no explanation. Rather than render a bare em dash, the reason is reconstructed from
 * the coverage counters that sit in the same row — which is exactly the information a reader
 * needs to judge the gap.
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

/**
 * Aggregate a column across rows, refusing to publish a partial sum.
 *
 * Same rule as core's `rollUp`: unknown unless every contributor is known. A partial sum
 * under-reports, and an under-report looks like a plausible number rather than an error — which
 * is the failure mode that made the predecessor's corpus total meaningless.
 *
 * TWO THINGS THIS HAS TO GET RIGHT, and both are easy to get wrong in SQL:
 *
 *   1. `SUM()` skips NULLs silently, so the sum alone can never tell you whether a contributor
 *      was missing. `missing` must be counted in the same query, over the same row set, and it
 *      is the only thing this function trusts.
 *   2. `total` must be the size of the population that OUGHT to contribute, not the number of
 *      rows that happen to exist in the aggregate's table. A contributor with no row at all is
 *      indistinguishable from one that contributed zero once the row set has been narrowed.
 *      Callers therefore drive this from the population table with a LEFT JOIN.
 *
 * A null `sum` with `missing === 0` and `total > 0` is arithmetically impossible; if a caller
 * ever produces it the row set and the counters disagree, and the honest answer is unknown
 * rather than the zero that `sum ?? 0` used to hand back.
 */
function sumOrUnknown(sum: number | null, missing: number, total: number, noun: string): WordCount {
  if (total === 0) return unknownWc(`there are no ${noun} to sum`);
  if (missing > 0) {
    return unknownWc(
      `${missing} of ${total} ${noun} have no measured total, so the corpus figure would be a ` +
        'partial sum',
    );
  }
  if (sum === null) {
    return unknownWc(
      `the aggregate over ${total} ${noun} returned no value while reporting nothing missing; ` +
        'the query and its counters disagree',
    );
  }
  return {
    words: sum,
    status: WordCountStatus.RolledUp,
    reason: null,
    method: CountMethod.DescendantSum,
  };
}

// ─── row shapes ──────────────────────────────────────────────────────────────

interface NodeRow extends MeasuredRow {
  citation: string;
  parent_citation: string | null;
  title_number: number;
  node_type: string;
  identifier: string | null;
  label: string | null;
  reserved: number;
  subtitle_id: string | null;
  chapter_id: string | null;
  subchapter_id: string | null;
  part_id: string | null;
  content_key: string | null;
}

interface AgencyDbRow {
  slug: string;
  name: string;
  short_name: string | null;
  display_name: string;
  sortable_name: string;
  parent_slug: string | null;
  depth: number;
  attributed_word_count: number | null;
  deduplicated_word_count: number | null;
  subtree_attributed: number | null;
  subtree_deduplicated: number | null;
  refs_total: number | null;
  refs_counted: number | null;
  shared_refs: number | null;
  children_count: number | null;
  coverage_pct: number | null;
}

const NODE_COLUMNS = `citation, parent_citation, title_number, node_type, identifier, label,
  reserved, subtitle_id, chapter_id, subchapter_id, part_id, content_key,
  word_count, word_count_status, word_count_method, word_count_reason`;

const AGENCY_SELECT = `
  SELECT a.slug, a.name, a.short_name, a.display_name, a.sortable_name, a.parent_slug, a.depth,
         r.attributed_word_count, r.deduplicated_word_count,
         r.subtree_attributed, r.subtree_deduplicated,
         r.refs_total, r.refs_counted, r.shared_refs, r.children_count, r.coverage_pct
  FROM agency a
  LEFT JOIN agency_rollup r ON r.agency_slug = a.slug`;

function toAgencyRow(row: AgencyDbRow): AgencyRow {
  const refsTotal = row.refs_total ?? 0;
  const refsCounted = row.refs_counted ?? 0;
  return {
    slug: row.slug,
    name: row.name,
    short_name: row.short_name,
    display_name: row.display_name,
    sortable_name: row.sortable_name,
    parent_slug: row.parent_slug,
    depth: row.depth,
    children_count: row.children_count ?? 0,
    attributed: wcFromRollup(row.attributed_word_count, refsTotal, refsCounted, 'attributed'),
    deduplicated: wcFromRollup(row.deduplicated_word_count, refsTotal, refsCounted, 'deduplicated'),
    subtree_attributed: wcFromRollup(row.subtree_attributed, refsTotal, refsCounted, 'attributed'),
    subtree_deduplicated: wcFromRollup(
      row.subtree_deduplicated,
      refsTotal,
      refsCounted,
      'deduplicated',
    ),
    coverage: { refs_total: refsTotal, refs_counted: refsCounted, pct: row.coverage_pct ?? 0 },
    shared_refs: row.shared_refs ?? 0,
  };
}

// ─── the source ──────────────────────────────────────────────────────────────

export async function loadD1Source(path: string): Promise<AtlasData> {
  if (!existsSync(path)) {
    throw new Error(`ECFR_D1_SQLITE points at ${path}, which does not exist.`);
  }

  let DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => Database;
  try {
    // Dynamic so the failure is a sentence rather than an unresolved-import stack trace on the
    // Node versions where node:sqlite still needs --experimental-sqlite.
    ({ DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => Database;
    });
  } catch {
    throw new Error(
      'node:sqlite is unavailable in this Node build. Run Node 22.5+ with --experimental-sqlite, ' +
        'upgrade to a release where it is enabled by default, or build from a snapshot by setting ' +
        'ECFR_SNAPSHOT_DIR instead.',
    );
  }

  const db = new DatabaseSync(path, { readOnly: true });

  // ── reference data loaded once; small, and touched by nearly every query ──

  const titleRows = all<{
    number: number;
    name: string;
    reserved: number;
    latest_amended_on: string | null;
    latest_issue_date: string | null;
    up_to_date_as_of: string | null;
  }>(
    db,
    'SELECT number, name, reserved, latest_amended_on, latest_issue_date, up_to_date_as_of FROM title ORDER BY number',
  );

  const titleNames = new Map(titleRows.map((t) => [t.number, t.name]));

  const nodeCountsByTitle = new Map<number, Map<string, number>>();
  for (const row of all<{ title_number: number; node_type: string; n: number }>(
    db,
    'SELECT title_number, node_type, COUNT(*) AS n FROM structure_node GROUP BY 1, 2',
  )) {
    let inner = nodeCountsByTitle.get(row.title_number);
    if (!inner) {
      inner = new Map<string, number>();
      nodeCountsByTitle.set(row.title_number, inner);
    }
    inner.set(row.node_type, row.n);
  }
  const countIn = (title: number, type: string): number =>
    nodeCountsByTitle.get(title)?.get(type) ?? 0;

  const titleNodes = new Map(
    all<NodeRow>(db, `SELECT ${NODE_COLUMNS} FROM structure_node WHERE node_type = 'title'`).map(
      (n) => [n.title_number, n],
    ),
  );

  function titleRowOf(t: (typeof titleRows)[number]): TitleRow {
    return {
      number: t.number,
      name: t.name,
      reserved: t.reserved === 1,
      latest_amended_on: t.latest_amended_on,
      latest_issue_date: t.latest_issue_date,
      up_to_date_as_of: t.up_to_date_as_of,
      word_count: wcFromRow(
        titleNodes.get(t.number) ?? null,
        'no structure node has been recorded for this title yet',
      ),
      chapters: countIn(t.number, 'chapter'),
      parts: countIn(t.number, 'part'),
      sections: countIn(t.number, 'section'),
    };
  }

  // ── agency ↔ scope, and the overlap set ──

  interface RefRow {
    agency_slug: string;
    ref_key: string;
    title_number: number;
    narrowest_level: string;
    subtitle_id: string | null;
    chapter_id: string | null;
    subchapter_id: string | null;
    part_id: string | null;
    node_citation: string | null;
  }

  const refRows = all<RefRow>(
    db,
    `SELECT agency_slug, ref_key, title_number, narrowest_level,
            subtitle_id, chapter_id, subchapter_id, part_id, node_citation
     FROM agency_cfr_reference`,
  );

  const agencyRefs = new Map<string, RefRow[]>();
  const claimantsByRefKey = new Map<string, string[]>();
  for (const ref of refRows) {
    (
      agencyRefs.get(ref.agency_slug) ?? agencyRefs.set(ref.agency_slug, []).get(ref.agency_slug)!
    ).push(ref);
    (
      claimantsByRefKey.get(ref.ref_key) ?? claimantsByRefKey.set(ref.ref_key, []).get(ref.ref_key)!
    ).push(ref.agency_slug);
  }

  const agencyDbRows = all<AgencyDbRow>(db, `${AGENCY_SELECT} ORDER BY a.sortable_name`);
  const agencyRowBySlug = new Map(agencyDbRows.map((r) => [r.slug, toAgencyRow(r)]));
  const agencyRefOf = (slug: string): AgencyRef => {
    const row = agencyRowBySlug.get(slug);
    return { slug, display_name: row?.display_name ?? slug };
  };
  const sortAgencyRefs = (slugs: readonly string[]): AgencyRef[] =>
    [...slugs]
      .sort((a, b) =>
        (agencyRowBySlug.get(a)?.sortable_name ?? a).localeCompare(
          agencyRowBySlug.get(b)?.sortable_name ?? b,
        ),
      )
      .map(agencyRefOf);

  /** Word count for a reference: the resolved node's, or an explanation of why there is none. */
  function scopeWordCount(ref: RefRow): WordCount {
    if (ref.node_citation === null) {
      return unknownWc(
        'this reference does not resolve to a node in the current CFR structure, so there is ' +
          'nothing to measure',
      );
    }
    const node = one<MeasuredRow>(
      db,
      'SELECT word_count, word_count_status, word_count_method, word_count_reason FROM structure_node WHERE citation = ?',
      [ref.node_citation],
    );
    return wcFromRow(node, `no node exists at ${ref.node_citation}`);
  }

  function scopeOf(ref: RefRow): Scope {
    return parseRefKey(ref.ref_key);
  }

  function toAgencyScope(ref: RefRow): AgencyScope {
    const scope = scopeOf(ref);
    const label = ref.node_citation
      ? (one<{ label: string | null }>(db, 'SELECT label FROM structure_node WHERE citation = ?', [
          ref.node_citation,
        ])?.label ?? null)
      : null;

    return {
      ref_key: ref.ref_key,
      title: scope.title,
      subtitle: scope.subtitle ?? null,
      chapter: scope.chapter ?? null,
      subchapter: scope.subchapter ?? null,
      part: scope.part ?? null,
      // Recomputed from the parsed scope rather than trusted from the column, so the site and
      // the pipeline cannot disagree about which level a reference actually names.
      narrowest_level: narrowestLevel(scope),
      display: displayCitation(scope),
      ecfr_url: ecfrUrl(scope),
      word_count: scopeWordCount(ref),
      label,
      node_citation: ref.node_citation,
      shared_with: sortAgencyRefs(
        (claimantsByRefKey.get(ref.ref_key) ?? []).filter((s) => s !== ref.agency_slug),
      ),
    };
  }

  // ── amendment histograms ──

  /** First month of the charted window, `YYYY-MM`, derived from the newest issue_date present. */
  const latestIssueDate =
    one<{ d: string | null }>(db, 'SELECT MAX(issue_date) AS d FROM amendment')?.d ?? null;

  function windowStart(): string | null {
    if (!latestIssueDate) return null;
    const end = new Date(`${latestIssueDate}T00:00:00Z`);
    end.setUTCMonth(end.getUTCMonth() - (AMENDMENT_WINDOW_MONTHS - 1));
    return `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /** Fill zero months so a quiet quarter reads as quiet rather than as missing data. */
  function toSeries(counts: Map<string, number>, unattributable: number): AmendmentSeries {
    const start = windowStart();
    if (!start || !latestIssueDate) {
      return { buckets: [], total: 0, unattributable, from: null, to: null };
    }
    const end = latestIssueDate.slice(0, 7);
    const buckets: { month: string; count: number }[] = [];
    const cursor = new Date(`${start}-01T00:00:00Z`);
    let total = 0;
    // Bounded rather than `while (true)`: the window is AMENDMENT_WINDOW_MONTHS wide by
    // construction, so a run past it means a malformed date and should stop, not spin.
    for (let i = 0; i < AMENDMENT_WINDOW_MONTHS; i++) {
      const month = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`;
      const count = counts.get(month) ?? 0;
      buckets.push({ month, count });
      total += count;
      if (month >= end) break;
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return { buckets, total, unattributable, from: start, to: end };
  }

  // ── AtlasData surface ──

  const manifest = buildManifest(db, titleRows.length, refRows.length, latestIssueDate);

  const routes = (): Promise<RouteIndex> =>
    Promise.resolve({
      agencies: agencyDbRows.map((a) => a.slug),
      titles: titleRows.map((t) => t.number),
      chapters: all<{ title_number: number; identifier: string }>(
        db,
        `SELECT title_number, identifier FROM structure_node
       WHERE node_type = 'chapter' AND identifier IS NOT NULL`,
      ).map((c) => ({ title: c.title_number, chapter: c.identifier })),
      // Always subpart: null. A D1 build has no body text, so there is nothing to slice.
      parts: all<{ title_number: number; identifier: string }>(
        db,
        `SELECT title_number, identifier FROM structure_node
       WHERE node_type = 'part' AND identifier IS NOT NULL`,
      ).map((p) => ({ title: p.title_number, part: p.identifier, subpart: null })),
    });

  return {
    manifest,
    routes,

    listAgencies() {
      return Promise.resolve(agencyDbRows.map((r) => agencyRowBySlug.get(r.slug) as AgencyRow));
    },

    getAgency(slug): Promise<AgencyPage | null> {
      const base = agencyRowBySlug.get(slug);
      if (!base) return Promise.resolve(null);

      const refs = agencyRefs.get(slug) ?? [];
      const scopes = refs
        .map(toAgencyScope)
        .sort((a, b) => a.title - b.title || a.display.localeCompare(b.display));

      const children = agencyDbRows
        .filter((a) => a.parent_slug === slug)
        .map((a) => agencyRowBySlug.get(a.slug) as AgencyRow);

      const parentRow = base.parent_slug ? agencyRowBySlug.get(base.parent_slug) : null;

      return Promise.resolve({
        ...base,
        parent: parentRow ? { slug: parentRow.slug, display_name: parentRow.display_name } : null,
        children,
        scopes,
        amendments: agencyAmendments(db, refs, latestIssueDate, toSeries),
        history: all<{
          snapshot_date: string;
          attributed_word_count: number | null;
          deduplicated_word_count: number | null;
          coverage_pct: number | null;
        }>(
          db,
          `SELECT snapshot_date, attributed_word_count, deduplicated_word_count, coverage_pct
           FROM agency_snapshot WHERE agency_slug = ? ORDER BY snapshot_date`,
          [slug],
        ).map((h) => ({
          snapshot_date: h.snapshot_date,
          attributed: h.attributed_word_count,
          deduplicated: h.deduplicated_word_count,
          coverage_pct: h.coverage_pct,
        })),
      });
    },

    listTitles() {
      return Promise.resolve(titleRows.map(titleRowOf));
    },

    getTitle(titleNumber): Promise<TitlePage | null> {
      const t = titleRows.find((row) => row.number === titleNumber);
      if (!t) return Promise.resolve(null);

      const partsPerChapter = new Map<string, number>();
      for (const row of all<{ chapter_id: string | null; n: number }>(
        db,
        `SELECT chapter_id, COUNT(*) AS n FROM structure_node
         WHERE title_number = ? AND node_type = 'part' GROUP BY chapter_id`,
        [titleNumber],
      )) {
        if (row.chapter_id) partsPerChapter.set(row.chapter_id, row.n);
      }

      const chapterList = all<NodeRow>(
        db,
        `SELECT ${NODE_COLUMNS} FROM structure_node
         WHERE title_number = ? AND node_type = 'chapter' AND identifier IS NOT NULL`,
        [titleNumber],
      )
        .map((n): ChapterRow => chapterRowOf(n, partsPerChapter.get(n.identifier ?? '') ?? 0))
        .sort(byIdentifier);

      const chapterAgencies = new Map<string, Set<string>>();
      const titleAgencies = new Set<string>();
      for (const ref of refRows) {
        if (ref.title_number !== titleNumber) continue;
        titleAgencies.add(ref.agency_slug);
        if (ref.chapter_id) {
          (
            chapterAgencies.get(ref.chapter_id) ??
            chapterAgencies.set(ref.chapter_id, new Set()).get(ref.chapter_id)!
          ).add(ref.agency_slug);
        }
      }
      for (const chapter of chapterList) {
        chapter.agencies = sortAgencyRefs([...(chapterAgencies.get(chapter.identifier) ?? [])]);
      }

      const subtitles = all<NodeRow>(
        db,
        `SELECT ${NODE_COLUMNS} FROM structure_node
         WHERE title_number = ? AND node_type = 'subtitle' AND identifier IS NOT NULL`,
        [titleNumber],
      )
        // The SQL already excludes null identifiers; the predicate re-establishes that for the
        // type system so the sort and the label below need no casts.
        .filter((s): s is NodeRow & { identifier: string } => s.identifier !== null)
        .sort(byIdentifier)
        .map((s) => ({
          identifier: s.identifier,
          label: s.label ?? `Subtitle ${s.identifier}`,
          chapters: all<{ identifier: string | null }>(
            db,
            `SELECT identifier FROM structure_node
             WHERE title_number = ? AND node_type = 'chapter' AND subtitle_id = ?`,
            [titleNumber, s.identifier],
          )
            .map((c) => c.identifier)
            .filter((id): id is string => id !== null)
            .sort(compareIdentifiers),
        }));

      return Promise.resolve({
        // biome-ignore lint/nursery/noMisusedPromises: false positive — titleRowOf is synchronous (returns TitleRow); Biome's own inference misreads the spread
        ...titleRowOf(t),
        chapter_list: chapterList,
        subtitles,
        agencies: sortAgencyRefs([...titleAgencies]),
      });
    },

    getChapter(titleNumber, chapterId): Promise<ChapterPage | null> {
      const node = one<NodeRow>(
        db,
        `SELECT ${NODE_COLUMNS} FROM structure_node
         WHERE title_number = ? AND node_type = 'chapter' AND identifier = ?`,
        [titleNumber, chapterId],
      );
      if (!node) return Promise.resolve(null);

      const parts = all<NodeRow>(
        db,
        `SELECT ${NODE_COLUMNS} FROM structure_node
         WHERE title_number = ? AND chapter_id = ? AND node_type = 'part'`,
        [titleNumber, chapterId],
      );

      const sectionsPerPart = new Map<string, number>();
      for (const row of all<{ part_id: string | null; n: number }>(
        db,
        `SELECT part_id, COUNT(*) AS n FROM structure_node
         WHERE title_number = ? AND chapter_id = ? AND node_type = 'section' GROUP BY part_id`,
        [titleNumber, chapterId],
      )) {
        if (row.part_id) sectionsPerPart.set(row.part_id, row.n);
      }

      // Group by subchapter, preserving the CFR's own two-level shape. A chapter with no
      // subchapters yields one null-identifier group and renders ungrouped.
      const bySubchapter = new Map<string | null, NodeRow[]>();
      for (const p of parts) {
        const key = p.subchapter_id;
        (bySubchapter.get(key) ?? bySubchapter.set(key, []).get(key)!).push(p);
      }

      const subchapterLabels = new Map(
        all<NodeRow>(
          db,
          `SELECT ${NODE_COLUMNS} FROM structure_node
           WHERE title_number = ? AND chapter_id = ? AND node_type = 'subchapter'`,
          [titleNumber, chapterId],
        ).map((s) => [s.identifier, s.label]),
      );

      const groups = [...bySubchapter.entries()]
        .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : compareIdentifiers(a, b)))
        .map(([identifier, rows]) => ({
          identifier,
          label: identifier === null ? null : (subchapterLabels.get(identifier) ?? null),
          part_list: rows
            .map((p): PartRow => partRowOf(p, sectionsPerPart.get(p.identifier ?? '') ?? 0))
            .sort(byIdentifier),
        }));

      const scope: Scope = { title: titleNumber, chapter: chapterId };
      // Both containment directions: an agency claiming the whole chapter, and an agency
      // claiming a single part inside it, both belong on this page. The page labels the list
      // "agencies with references in this chapter" rather than implying either owns the whole
      // thing — conflating a narrower claim with the chapter is the mistake that over-credited
      // one agency 12.7x.
      const agencies = sortAgencyRefs([
        ...new Set(
          refRows
            .filter((r) => {
              const refScope = parseRefKey(r.ref_key);
              return scopeContains(refScope, scope) || scopeContains(scope, refScope);
            })
            .map((r) => r.agency_slug),
        ),
      ]);

      return Promise.resolve({
        ...chapterRowOf(node, parts.length),
        agencies,
        title_number: titleNumber,
        title_name: titleNames.get(titleNumber) ?? `Title ${titleNumber}`,
        ecfr_url: ecfrUrl(scope),
        display: displayCitation(scope),
        groups,
      });
    },

    getPart(titleNumber, partId, subpart): Promise<PartView | null> {
      // A D1 build never emits slice routes, so a request for one is a stale link.
      if (subpart !== null) return Promise.resolve(null);

      const node = one<NodeRow>(
        db,
        `SELECT ${NODE_COLUMNS} FROM structure_node
         WHERE title_number = ? AND node_type = 'part' AND identifier = ?
         ORDER BY citation LIMIT 1`,
        [titleNumber, partId],
      );
      if (!node) return Promise.resolve(null);

      const sections = all<NodeRow>(
        db,
        `SELECT ${NODE_COLUMNS} FROM structure_node
         WHERE title_number = ? AND part_id = ? AND node_type = 'section'`,
        [titleNumber, partId],
      )
        .filter((s): s is NodeRow & { identifier: string } => s.identifier !== null)
        .sort(byIdentifier)
        .map(
          (s): SectionEntry => ({
            citation: s.citation,
            identifier: s.identifier,
            label: s.label ?? s.identifier,
            reserved: s.reserved === 1,
            word_count: wcFromRow(s, 'no measurement recorded'),
            anchor: sectionAnchor(s.identifier),
          }),
        );

      const chapterLabel = node.chapter_id
        ? (one<{ label: string | null }>(
            db,
            `SELECT label FROM structure_node
             WHERE title_number = ? AND node_type = 'chapter' AND identifier = ?`,
            [titleNumber, node.chapter_id],
          )?.label ?? null)
        : null;

      const subchapterLabel = node.subchapter_id
        ? (one<{ label: string | null }>(
            db,
            `SELECT label FROM structure_node
             WHERE title_number = ? AND node_type = 'subchapter' AND identifier = ?`,
            [titleNumber, node.subchapter_id],
          )?.label ?? null)
        : null;

      const scope: Scope = {
        title: titleNumber,
        ...(node.chapter_id ? { chapter: node.chapter_id } : {}),
        part: partId,
      };

      const lastAmended =
        one<{ d: string | null }>(
          db,
          'SELECT MAX(amendment_date) AS d FROM amendment WHERE title_number = ? AND part = ?',
          [titleNumber, partId],
        )?.d ?? null;

      // Only references that CONTAIN this part. A part has nothing below it in the reference
      // hierarchy, so containment is one-directional here.
      const agencies = sortAgencyRefs([
        ...new Set(
          refRows
            .filter((r) => scopeContains(parseRefKey(r.ref_key), scope))
            .map((r) => r.agency_slug),
        ),
      ]);

      return Promise.resolve({
        ...partRowOf(node, sections.length),
        title_number: titleNumber,
        title_name: titleNames.get(titleNumber) ?? `Title ${titleNumber}`,
        chapter: node.chapter_id
          ? { identifier: node.chapter_id, label: chapterLabel ?? `Chapter ${node.chapter_id}` }
          : null,
        subchapter: node.subchapter_id
          ? {
              identifier: node.subchapter_id,
              label: subchapterLabel ?? `Subchapter ${node.subchapter_id}`,
            }
          : null,
        display: displayCitation(scope),
        ecfr_url: ecfrUrl(scope),
        // Authority, source and editorial notes live in the XML, which this source never reads.
        authority: null,
        source_note: null,
        editorial_note: null,
        last_amended_on: lastAmended,
        slice: null,
        slices: [],
        section_list: sections,
        agencies,
        content_key: null,
        content_unavailable_reason:
          'This build reads the local D1 database, which stores a pointer to the regulation text ' +
          'in R2 rather than the text itself. Build from a snapshot (ECFR_SNAPSHOT_DIR) to include ' +
          'the full text, or read this part on the official eCFR.',
        content_html: null,
        slice_by_anchor: null,
      });
    },

    listSharedScopes(): Promise<SharedScope[]> {
      return Promise.resolve(
        all<{
          ref_key: string;
          title_number: number;
          agency_count: number;
          agency_slugs: string;
          word_count: number | null;
        }>(
          db,
          'SELECT ref_key, title_number, agency_count, agency_slugs, word_count FROM scope_overlap',
        )
          .map((row): SharedScope => {
            const scope = parseRefKey(row.ref_key);
            // The column is a JSON array by contract, but a malformed one must not take the build
            // down with a parse error when the claimant list is recoverable from the join table.
            let slugs: string[];
            try {
              const parsed: unknown = JSON.parse(row.agency_slugs);
              slugs = Array.isArray(parsed) ? parsed.map(String) : [];
            } catch {
              slugs = [];
            }
            if (slugs.length === 0) slugs = claimantsByRefKey.get(row.ref_key) ?? [];

            const node = refRows.find((r) => r.ref_key === row.ref_key)?.node_citation ?? null;
            const label = node
              ? (one<{ label: string | null }>(
                  db,
                  'SELECT label FROM structure_node WHERE citation = ?',
                  [node],
                )?.label ?? null)
              : null;

            return {
              ref_key: row.ref_key,
              title_number: row.title_number,
              title_name: titleNames.get(row.title_number) ?? `Title ${row.title_number}`,
              display: displayCitation(scope),
              ecfr_url: ecfrUrl(scope),
              label,
              narrowest_level: narrowestLevel(scope),
              word_count:
                row.word_count === null
                  ? unknownWc('the scope itself has no measured word count')
                  : {
                      words: row.word_count,
                      status: WordCountStatus.RolledUp,
                      reason: null,
                      method: CountMethod.DescendantSum,
                    },
              agencies: sortAgencyRefs(slugs),
            };
          })
          .sort((a, b) => (b.word_count.words ?? -1) - (a.word_count.words ?? -1)),
      );
    },

    getDataQuality(): Promise<DataQuality> {
      const totals = one<{ total: number; unknown: number }>(
        db,
        `SELECT COUNT(*) AS total, SUM(CASE WHEN word_count IS NULL THEN 1 ELSE 0 END) AS unknown
         FROM structure_node`,
      ) ?? { total: 0, unknown: 0 };

      const byStatus = new Map<string, DataQualityGroup>();
      for (const row of all<{ status: string; reason: string; n: number }>(
        db,
        `SELECT word_count_status AS status, word_count_reason AS reason, COUNT(*) AS n
         FROM structure_node WHERE word_count IS NULL
         GROUP BY 1, 2 ORDER BY n DESC`,
      )) {
        const group =
          byStatus.get(row.status) ??
          byStatus
            .set(row.status, {
              status: row.status,
              count: 0,
              reasons: [],
              sample: [],
              sample_truncated: false,
            })
            .get(row.status)!;
        group.count += row.n;
        group.reasons.push({ reason: row.reason, count: row.n });
      }

      for (const group of byStatus.values()) {
        const sample = all<{
          citation: string;
          title_number: number;
          node_type: string;
          label: string | null;
          word_count_reason: string;
        }>(
          db,
          `SELECT citation, title_number, node_type, label, word_count_reason
           FROM structure_node WHERE word_count IS NULL AND word_count_status = ?
           ORDER BY title_number, citation LIMIT ?`,
          [group.status, DQ_SAMPLE_LIMIT],
        );
        group.sample = sample.map((s) => ({
          citation: s.citation,
          title_number: s.title_number,
          node_type: s.node_type,
          label: s.label,
          reason: s.word_count_reason,
        }));
        group.sample_truncated = group.count > sample.length;
      }

      const unknownPerTitle = new Map(
        all<{ title_number: number; n: number }>(
          db,
          `SELECT title_number, COUNT(*) AS n FROM structure_node
           WHERE word_count IS NULL GROUP BY 1`,
        ).map((r) => [r.title_number, r.n]),
      );

      const unresolved = new Map<string, string[]>();
      for (const ref of refRows) {
        if (ref.node_citation !== null) continue;
        (unresolved.get(ref.ref_key) ?? unresolved.set(ref.ref_key, []).get(ref.ref_key)!).push(
          ref.agency_slug,
        );
      }

      return Promise.resolve({
        nodes_total: totals.total,
        nodes_known: totals.total - totals.unknown,
        nodes_unknown: totals.unknown,
        groups: [...byStatus.values()].sort((a, b) => b.count - a.count),
        by_title: titleRows
          .map((t) => ({
            title_number: t.number,
            title_name: t.name,
            unknown: unknownPerTitle.get(t.number) ?? 0,
            total: [...(nodeCountsByTitle.get(t.number)?.values() ?? [])].reduce(
              (a, b) => a + b,
              0,
            ),
          }))
          .filter((t) => t.unknown > 0)
          .sort((a, b) => b.unknown - a.unknown),
        partial_agencies: agencyDbRows
          .filter((a) => (a.refs_total ?? 0) > 0 && (a.coverage_pct ?? 0) < 1)
          .map((a) => ({
            slug: a.slug,
            display_name: a.display_name,
            coverage: {
              refs_total: a.refs_total ?? 0,
              refs_counted: a.refs_counted ?? 0,
              pct: a.coverage_pct ?? 0,
            },
          }))
          .sort((a, b) => a.coverage.pct - b.coverage.pct),
        unresolved_refs: [...unresolved.entries()].map(([ref_key, slugs]) => ({
          ref_key,
          display: displayCitation(parseRefKey(ref_key)),
          agencies: sortAgencyRefs(slugs),
        })),
      });
    },

    getAmendmentActivity(): Promise<AmendmentSeries> {
      const counts = new Map(
        all<{ month: string; n: number }>(
          db,
          `SELECT substr(issue_date, 1, 7) AS month, COUNT(*) AS n FROM amendment GROUP BY 1`,
        ).map((r) => [r.month, r.n]),
      );
      return Promise.resolve(toSeries(counts, 0));
    },
  };

  // ── helpers closing over db ──

  function chapterRowOf(node: NodeRow, parts: number): ChapterRow {
    return {
      citation: node.citation,
      identifier: node.identifier ?? '',
      label: node.label ?? `Chapter ${node.identifier ?? ''}`,
      reserved: node.reserved === 1,
      word_count: wcFromRow(node, 'no measurement recorded'),
      parts,
      agencies: [],
    };
  }

  function partRowOf(node: NodeRow, sections: number): PartRow {
    return {
      citation: node.citation,
      identifier: node.identifier ?? '',
      label: node.label ?? `Part ${node.identifier ?? ''}`,
      reserved: node.reserved === 1,
      word_count: wcFromRow(node, 'no measurement recorded'),
      sections,
    };
  }
}

// ─── free functions ──────────────────────────────────────────────────────────

function buildManifest(
  db: Database,
  titleCount: number,
  refCount: number,
  latestIssueDate: string | null,
): SnapshotManifest {
  const meta = one<{
    published_run_id: number | null;
    published_at: string | null;
    source_date: string | null;
  }>(db, 'SELECT published_run_id, published_at, source_date FROM app_meta WHERE id = 1');

  /**
   * The corpus totals, aggregated over `agency` and NOT over `agency_rollup`.
   *
   * The LEFT JOIN is the whole point. `agency_rollup` is keyed by slug and its row is absent
   * until a sync run has computed one, so `SELECT SUM(...) FROM agency_rollup` aggregates over
   * "the agencies we happened to finish" and reports `missing = 0` while under-reporting by
   * however many agencies never got a row. `SUM()` skipping NULLs and the join dropping rows are
   * two spellings of the same silent-zero bug, and the second one is invisible in the SQL.
   *
   * Driving from `agency` makes both failures identical: an agency with no rollup row and an
   * agency whose rollup is NULL both surface as a NULL on the right-hand side, both increment
   * `*_missing`, and either one is enough to make the published corpus figure unknown-with-a-
   * reason instead of an authoritative-looking undercount.
   */
  const rollup = one<{
    attributed: number | null;
    attributed_missing: number;
    dedup: number | null;
    dedup_missing: number;
    n: number;
  }>(
    db,
    `SELECT SUM(r.attributed_word_count)  AS attributed,
            SUM(CASE WHEN r.attributed_word_count   IS NULL THEN 1 ELSE 0 END) AS attributed_missing,
            SUM(r.deduplicated_word_count) AS dedup,
            SUM(CASE WHEN r.deduplicated_word_count IS NULL THEN 1 ELSE 0 END) AS dedup_missing,
            COUNT(*) AS n
     FROM agency a
     LEFT JOIN agency_rollup r ON r.agency_slug = a.slug`,
  ) ?? { attributed: null, attributed_missing: 0, dedup: null, dedup_missing: 0, n: 0 };

  const overlap = one<{ shared: number | null; missing: number; n: number }>(
    db,
    `SELECT SUM(word_count) AS shared,
            SUM(CASE WHEN word_count IS NULL THEN 1 ELSE 0 END) AS missing,
            COUNT(*) AS n
     FROM scope_overlap`,
  ) ?? { shared: null, missing: 0, n: 0 };

  const nodeCounts = new Map(
    all<{ node_type: string; n: number }>(
      db,
      'SELECT node_type, COUNT(*) AS n FROM structure_node GROUP BY 1',
    ).map((r) => [r.node_type, r.n]),
  );
  const nodesTotal = [...nodeCounts.values()].reduce((a, b) => a + b, 0);

  const scalar = (sql: string): number => one<{ n: number }>(db, sql)?.n ?? 0;

  const corpus: CorpusTotals = {
    deduplicated: sumOrUnknown(rollup.dedup, rollup.dedup_missing, rollup.n, 'agencies'),
    attributed: sumOrUnknown(rollup.attributed, rollup.attributed_missing, rollup.n, 'agencies'),
    shared: sumOrUnknown(overlap.shared, overlap.missing, overlap.n, 'shared scopes'),
    agencies: scalar('SELECT COUNT(*) AS n FROM agency'),
    titles: titleCount,
    titles_reserved: scalar('SELECT COUNT(*) AS n FROM title WHERE reserved = 1'),
    chapters: nodeCounts.get('chapter') ?? 0,
    parts: nodeCounts.get('part') ?? 0,
    sections: nodeCounts.get('section') ?? 0,
    structure_nodes: nodesTotal,
    refs_total: refCount,
    shared_scopes: overlap.n,
    amendments: scalar('SELECT COUNT(*) AS n FROM amendment'),
    nodes_unknown: scalar('SELECT COUNT(*) AS n FROM structure_node WHERE word_count IS NULL'),
  };

  return {
    snapshot_version: 1,
    generated_at: new Date().toISOString(),
    run_id: meta?.published_run_id ?? null,
    source_date: meta?.source_date ?? null,
    latest_issue_date: latestIssueDate,
    fixture: false,
    source: 'd1-sqlite',
    corpus,
  };
}

/**
 * Amendments attributable to an agency.
 *
 * Attribution is exact, not estimated: each of the agency's scopes is expanded to the set of
 * part identifiers that actually sit inside it in the current structure, and only amendments
 * whose `part` is in that set are counted. Rows with no part identifier cannot be placed and are
 * reported separately rather than folded in — which is the difference between a chart and a
 * guess.
 */
function agencyAmendments(
  db: Database,
  refs: readonly {
    title_number: number;
    subtitle_id: string | null;
    chapter_id: string | null;
    subchapter_id: string | null;
    part_id: string | null;
  }[],
  latestIssueDate: string | null,
  toSeries: (counts: Map<string, number>, unattributable: number) => AmendmentSeries,
): AmendmentSeries {
  if (refs.length === 0 || latestIssueDate === null) return toSeries(new Map(), 0);

  /** title → set of part identifiers this agency administers. */
  const partsByTitle = new Map<number, Set<string>>();
  for (const ref of refs) {
    const set =
      partsByTitle.get(ref.title_number) ??
      partsByTitle.set(ref.title_number, new Set()).get(ref.title_number)!;

    if (ref.part_id) {
      set.add(ref.part_id);
      continue;
    }
    // Broader scope: expand it against the denormalised ancestry columns rather than walking
    // the tree. That is what those columns exist for.
    const clauses: string[] = ["node_type = 'part'", 'title_number = ?'];
    const params: unknown[] = [ref.title_number];
    if (ref.subchapter_id) {
      clauses.push('subchapter_id = ?');
      params.push(ref.subchapter_id);
    } else if (ref.chapter_id) {
      clauses.push('chapter_id = ?');
      params.push(ref.chapter_id);
    } else if (ref.subtitle_id) {
      clauses.push('subtitle_id = ?');
      params.push(ref.subtitle_id);
    }
    for (const row of all<{ identifier: string | null }>(
      db,
      `SELECT identifier FROM structure_node WHERE ${clauses.join(' AND ')}`,
      params,
    )) {
      if (row.identifier) set.add(row.identifier);
    }
  }

  const titles = [...partsByTitle.keys()];
  const placeholders = titles.map(() => '?').join(', ');
  const rows = all<{ title_number: number; part: string | null; month: string; n: number }>(
    db,
    `SELECT title_number, part, substr(issue_date, 1, 7) AS month, COUNT(*) AS n
     FROM amendment WHERE title_number IN (${placeholders})
     GROUP BY 1, 2, 3`,
    titles,
  );

  const counts = new Map<string, number>();
  let unattributable = 0;
  for (const row of rows) {
    if (row.part === null) {
      unattributable += row.n;
      continue;
    }
    if (!partsByTitle.get(row.title_number)?.has(row.part)) continue;
    counts.set(row.month, (counts.get(row.month) ?? 0) + row.n);
  }

  return toSeries(counts, unattributable);
}
