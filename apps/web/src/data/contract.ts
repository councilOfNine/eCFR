/**
 * THE BUILD-TIME DATA CONTRACT FOR apps/web.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * If you are the sync pipeline and you are emitting a snapshot, this file is the spec.
 * If you are a page in src/pages, `AtlasData` below is the only thing you may import.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHY A CONTRACT FILE AND NOT JUST SQL IN THE PAGES
 *
 * Two independent sources have to produce identical page output: a JSON snapshot emitted by
 * scripts/sync (the deploy path) and a local D1 sqlite file (the contributor path). If pages
 * queried directly, those two would drift and the drift would show up as numbers that differ
 * between environments — which is the exact failure mode this rewrite exists to eliminate.
 * Both sources implement `AtlasData`; pages cannot tell them apart.
 *
 * THE MEASUREMENT ENVELOPE
 *
 * Every count on the wire is a `WordCount` from `@ecfr-atlas/core/api-schemas` — an object of
 * `{ words, status, reason, method }`, never a bare number. `words: null` means "not measured"
 * and is rendered as an em dash with its reason, never as 0. This is not a style preference:
 * the predecessor stored a guessed count in the same INTEGER column as a measured one, and
 * every consumer downstream then treated the guess as fact. Reusing the API's envelope here
 * rather than inventing a web-local one means the snapshot files are byte-for-byte the same
 * shapes the public API serves, so there is one definition and two consumers.
 *
 * A NULL AGGREGATE MUST STILL EXPLAIN ITSELF. `agency_rollup.attributed_word_count` is a plain
 * nullable INTEGER with no status column of its own, so an exporter reading that table MUST
 * synthesise a reason when it is null. The conventional one, and what sources/d1-sqlite.ts
 * emits, is `"N of M scopes are not counted"` with status `not_computed`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * ON-DISK SNAPSHOT LAYOUT  (ECFR_SNAPSHOT_DIR)
 *
 *   manifest.json                            SnapshotManifest
 *   routes.json                              RouteIndex — everything getStaticPaths needs
 *   agencies.json                            AgencyRow[]
 *   agency/<slug>.json                       AgencyPage
 *   titles.json                              TitleRow[]
 *   title/<n>.json                           TitlePage
 *   title/<n>/chapter/<id>.json              ChapterPage
 *   title/<n>/part/<part>.json               PartPage           (whole part, or slice index)
 *   title/<n>/part/<part>/<subpart>.json     PartPage           (one slice of a split part)
 *   shared-jurisdiction.json                 SharedScope[]
 *   data-quality.json                        DataQuality
 *   amendments.json                          AmendmentSeries    (corpus-wide)
 *   content/<content_key>.html               rendered body HTML, already sanitised
 *
 * Path segments derived from CFR identifiers are `encodeURIComponent`-escaped, because part
 * identifiers are not guaranteed to be bare integers (`50a`, `1926`, appendix suffixes).
 *
 * Body text is a separate file per `content_key` rather than inlined, for a measured reason:
 * 26 CFR Part 1 is 69,598,633 bytes and six sections individually exceed 2 MB. The loader
 * reads exactly the one content file a page needs and never holds the corpus in memory.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT AN EXPORTER MAY NOT DO
 *
 *   - Emit `words: <number>` with a status in UNKNOWN_STATUSES, or `words: null` with a status
 *     in KNOWN_STATUSES. src/data/schema.ts rejects the file and the build fails.
 *   - Emit a rolled-up total over a partially-counted set. Use `rollUp()` from core; it
 *     returns unavailable unless every child is known. A partial sum under-reports, and an
 *     under-report looks like a plausible number rather than an error.
 *   - Emit a `PartPage` with `content_key` pointing at a file that does not exist. Write the
 *     content file first, then the JSON that references it.
 */

import { HIERARCHY } from '@ecfr-atlas/core';
import {
  AgencySummary as CoreAgencySummary,
  Coverage as CoverageSchema,
  ScopeSchema,
  WordCount,
} from '@ecfr-atlas/core/api-schemas';
import { z } from 'zod';

/**
 * core exports `Coverage` as a Zod schema only, with no companion type. Deriving it once here
 * saves every component that renders a coverage badge from doing its own `z.infer`.
 */
export type Coverage = z.infer<typeof CoverageSchema>;

// ─── shared leaf shapes ──────────────────────────────────────────────────────

/** Just enough of an agency to render a link. Used wherever agencies are cross-referenced. */
export const AgencyRef = z.object({
  slug: z.string(),
  display_name: z.string(),
});
export type AgencyRef = z.infer<typeof AgencyRef>;

/**
 * `AgencySummary` from core plus the two fields the site's tables need and the API's does not:
 * `sortable_name` drives the default table order (eCFR's own ordering, which puts "Department
 * of Agriculture" under A), and `depth` lets the table indent sub-agencies under their parent
 * without a second query.
 */
export const AgencyRow = CoreAgencySummary.extend({
  sortable_name: z.string(),
  depth: z.number().int().nonnegative(),
});
export type AgencyRow = z.infer<typeof AgencyRow>;

// ─── manifest ────────────────────────────────────────────────────────────────

/**
 * Corpus-level figures for the dashboard.
 *
 * `deduplicated` is the headline. It is the sum over every agency's deduplicated rollup, which
 * divides each shared scope evenly among its claimants so the corpus total is conserved.
 * `attributed` counts a shared scope in full for every agency claiming it, so it is larger; both
 * are published because which one is correct depends on the question, and picking one silently is
 * how the predecessor produced a corpus total that was the sum of 17 double- to sextuple-counted
 * scopes.
 *
 * HOW THE THREE RELATE, precisely, because an earlier version of this comment and of the
 * dashboard copy claimed an identity that is false:
 *
 *     shared        = Σ  w(s)              over shared scopes s
 *     attributed    − deduplicated
 *                   = Σ (n(s) − 1) · w(s)  over shared scopes s,  n(s) = claimant count
 *
 * `shared` is therefore the gap ONLY where every shared scope has exactly two claimants. In this
 * corpus they have two to six, so the gap is strictly larger than `shared` and no page may state
 * otherwise. (Even for n = 2 the two differ by the rounding residual, since the per-agency even
 * split is rounded to whole words: up to one word per claimant.)
 */
export const CorpusTotals = z.object({
  deduplicated: WordCount,
  attributed: WordCount,
  /**
   * Words living in scopes claimed by 2+ agencies, counted ONCE. Comparable with
   * `deduplicated` — both count each scope once — and not equal to
   * `attributed − deduplicated`; see the note above.
   */
  shared: WordCount,
  agencies: z.number().int().nonnegative(),
  titles: z.number().int().nonnegative(),
  titles_reserved: z.number().int().nonnegative(),
  chapters: z.number().int().nonnegative(),
  parts: z.number().int().nonnegative(),
  sections: z.number().int().nonnegative(),
  structure_nodes: z.number().int().nonnegative(),
  refs_total: z.number().int().nonnegative(),
  shared_scopes: z.number().int().nonnegative(),
  amendments: z.number().int().nonnegative(),
  /** Structure nodes whose count is null. Linked straight to /data-quality. */
  nodes_unknown: z.number().int().nonnegative(),
});
export type CorpusTotals = z.infer<typeof CorpusTotals>;

export const SnapshotManifest = z.object({
  snapshot_version: z.literal(1),
  /** When the snapshot was written, ISO 8601. Distinct from `source_date`. */
  generated_at: z.string(),
  /** `sync_run.id` that produced it, for auditing a suspicious figure back to a run. */
  run_id: z.number().int().nullable(),
  /** eCFR's own snapshot date. Rendered as "current as of". Null on a fixture build. */
  source_date: z.string().nullable(),
  /** Most recent issue_date seen in `amendment`. eCFR publishes on business days only. */
  latest_issue_date: z.string().nullable(),
  /**
   * TRUE when the build was fed by the committed fixture rather than a sync. Every page then
   * renders a persistent banner. A demo build must never be mistakable for measured data.
   */
  fixture: z.boolean(),
  /** Which `AtlasData` implementation produced this. Shown on /data-quality. */
  source: z.enum(['snapshot', 'd1-sqlite', 'fixture']),
  corpus: CorpusTotals,
});
export type SnapshotManifest = z.infer<typeof SnapshotManifest>;

// ─── routing index ───────────────────────────────────────────────────────────

/**
 * Everything `getStaticPaths` needs, in one small file.
 *
 * Without this, enumerating the 9,664 part routes would mean globbing and opening 9,664 JSON
 * files before the first page renders. Astro calls every route's getStaticPaths up front, so
 * that cost lands entirely in build startup.
 */
export const RouteIndex = z.object({
  agencies: z.array(z.string()),
  titles: z.array(z.number().int()),
  chapters: z.array(z.object({ title: z.number().int(), chapter: z.string() })),
  parts: z.array(
    z.object({
      title: z.number().int(),
      part: z.string(),
      /**
       * Null renders the whole part on one page. For a part that was split, the null route is
       * ALSO emitted and renders a slice index — so `/title/26/part/1` always resolves rather
       * than 404ing on the most-cited part in the CFR.
       */
      subpart: z.string().nullable(),
    }),
  ),
});
export type RouteIndex = z.infer<typeof RouteIndex>;

// ─── agency page ─────────────────────────────────────────────────────────────

/**
 * One CFR scope an agency administers.
 *
 * Built on core's `ScopeSchema`, which already carries `narrowest_level` — the field whose
 * absence caused the 12.7x over-credit. 12 of 487 references name a chapter *and* something
 * narrower; honouring the narrowest is mandatory and the schema makes it un-forgettable.
 */
export const AgencyScope = ScopeSchema.extend({
  /** Label from the structure tree, e.g. "Environmental Protection Agency". */
  label: z.string().nullable(),
  /**
   * Resolved structure node. Null when the reference points at a scope that is not in the
   * current structure — eCFR references occasionally outlive the thing they reference, and
   * that is a data-quality fact to show, not an error to swallow.
   */
  node_citation: z.string().nullable(),
  /** Co-claimants of this exact scope. Empty for the 470 sole-claim scopes. */
  shared_with: z.array(AgencyRef),
});
export type AgencyScope = z.infer<typeof AgencyScope>;

/** One month of amendment activity. `month` is `YYYY-MM`. */
export const AmendmentBucket = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  count: z.number().int().nonnegative(),
});
export type AmendmentBucket = z.infer<typeof AmendmentBucket>;

export const AmendmentSeries = z.object({
  /** Contiguous months oldest→newest, including zero months so the chart has no false gaps. */
  buckets: z.array(AmendmentBucket),
  total: z.number().int().nonnegative(),
  /**
   * Amendment rows inside this agency's titles that carry no part identifier and therefore
   * cannot be attributed to a scope. Surfaced next to the chart rather than quietly dropped.
   */
  unattributable: z.number().int().nonnegative(),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type AmendmentSeries = z.infer<typeof AmendmentSeries>;

export const AgencyPage = AgencyRow.extend({
  parent: AgencyRef.nullable(),
  children: z.array(AgencyRow),
  scopes: z.array(AgencyScope),
  amendments: AmendmentSeries,
  /** Per-run history, oldest→newest, for the "change over time" line. */
  history: z.array(
    z.object({
      snapshot_date: z.string(),
      attributed: z.number().int().nullable(),
      deduplicated: z.number().int().nullable(),
      coverage_pct: z.number().nullable(),
    }),
  ),
});
export type AgencyPage = z.infer<typeof AgencyPage>;

// ─── titles, chapters, parts ─────────────────────────────────────────────────

export const TitleRow = z.object({
  number: z.number().int().positive(),
  name: z.string(),
  /** Title 35 is reserved and all three dates below are null. Null-guard or throw nightly. */
  reserved: z.boolean(),
  latest_amended_on: z.string().nullable(),
  latest_issue_date: z.string().nullable(),
  up_to_date_as_of: z.string().nullable(),
  word_count: WordCount,
  chapters: z.number().int().nonnegative(),
  parts: z.number().int().nonnegative(),
  sections: z.number().int().nonnegative(),
});
export type TitleRow = z.infer<typeof TitleRow>;

export const ChapterRow = z.object({
  /** Full ancestry path, e.g. `title-40/chapter-I`. The natural key in `structure_node`. */
  citation: z.string(),
  identifier: z.string(),
  label: z.string(),
  reserved: z.boolean(),
  word_count: WordCount,
  parts: z.number().int().nonnegative(),
  /** Agencies claiming this chapter or something inside it. */
  agencies: z.array(AgencyRef),
});
export type ChapterRow = z.infer<typeof ChapterRow>;

export const TitlePage = TitleRow.extend({
  chapter_list: z.array(ChapterRow),
  /** Subtitle grouping when the title has one (e.g. 7 CFR Subtitle A/B). Often empty. */
  subtitles: z.array(
    z.object({
      identifier: z.string(),
      label: z.string(),
      chapters: z.array(z.string()).describe('chapter identifiers in this subtitle'),
    }),
  ),
  agencies: z.array(AgencyRef),
});
export type TitlePage = z.infer<typeof TitlePage>;

export const PartRow = z.object({
  citation: z.string(),
  identifier: z.string(),
  label: z.string(),
  reserved: z.boolean(),
  word_count: WordCount,
  sections: z.number().int().nonnegative(),
});
export type PartRow = z.infer<typeof PartRow>;

/**
 * Parts grouped under their subchapter. Chapters that have no subchapters emit a single group
 * with a null identifier — the page renders that ungrouped rather than inventing a heading.
 */
export const SubchapterGroup = z.object({
  identifier: z.string().nullable(),
  label: z.string().nullable(),
  part_list: z.array(PartRow),
});
export type SubchapterGroup = z.infer<typeof SubchapterGroup>;

export const ChapterPage = ChapterRow.extend({
  title_number: z.number().int().positive(),
  title_name: z.string(),
  ecfr_url: z.string(),
  display: z.string(),
  groups: z.array(SubchapterGroup),
});
export type ChapterPage = z.infer<typeof ChapterPage>;

/** One entry in the reader's table of contents. `anchor` is the in-page fragment id. */
export const SectionEntry = z.object({
  citation: z.string(),
  identifier: z.string(),
  label: z.string(),
  reserved: z.boolean(),
  word_count: WordCount,
  anchor: z.string(),
});
export type SectionEntry = z.infer<typeof SectionEntry>;

/** One slice of a split part. `subpart` null identifies the slice index page itself. */
export const PartSliceRef = z.object({
  subpart: z.string().nullable(),
  label: z.string(),
  word_count: WordCount,
});
export type PartSliceRef = z.infer<typeof PartSliceRef>;

export const PartPage = PartRow.extend({
  title_number: z.number().int().positive(),
  title_name: z.string(),
  chapter: z.object({ identifier: z.string(), label: z.string() }).nullable(),
  subchapter: z.object({ identifier: z.string(), label: z.string() }).nullable(),
  display: z.string(),
  ecfr_url: z.string(),

  /** Statutory authority for the part, verbatim from the AUTH element. */
  authority: z.string().nullable(),
  /** Federal Register source note, verbatim from the SOURCE element. */
  source_note: z.string().nullable(),
  editorial_note: z.string().nullable(),
  /** Most recent `amendment.amendment_date` touching this part. */
  last_amended_on: z.string().nullable(),

  /** Which slice this page is. Null on a whole part and on a slice index. */
  slice: z.string().nullable(),
  /**
   * Every slice of this part. Empty when the part is published whole. Non-empty means the
   * part exceeded the per-page ceiling — 36 parts exceed 2 MB and 26 CFR Part 1 is 69.6 MB,
   * which is also over Cloudflare's 25 MiB per-asset cap.
   */
  slices: z.array(PartSliceRef),

  /**
   * Named `section_list` rather than `sections` because `PartRow.sections` is the COUNT, and a
   * field that is a number in a list view and an array in a detail view is a trap. Same reason
   * `TitlePage.chapter_list` and `ChapterPage.part_list` are spelled that way.
   */
  section_list: z.array(SectionEntry),
  agencies: z.array(AgencyRef),

  /**
   * R2 key for this page's rendered body, resolved by the loader into `content_html`.
   * Null means this build has no text for the page, and the reader says so explicitly.
   */
  content_key: z.string().nullable(),
  /** Required when `content_key` is null. Rendered verbatim in the reader's notice. */
  content_unavailable_reason: z.string().nullable(),
});
export type PartPage = z.infer<typeof PartPage>;

/** What the loader hands a page: `PartPage` with the body already read off disk. */
export interface PartView extends PartPage {
  content_html: string | null;
  /**
   * Split-part index pages only: which slice page carries each section anchor, so the TOC
   * can link into the right slice instead of emitting same-page fragments that land nowhere.
   * Null everywhere else — whole parts, slice pages, and sources without slice files.
   */
  slice_by_anchor: Record<string, string> | null;
}

// ─── shared jurisdiction ─────────────────────────────────────────────────────

/**
 * A scope claimed by two or more agencies. 17 of 487 scopes, claimed by 2-6 agencies each.
 *
 * This is a first-class research finding, not a footnote: someone preparing a proposal to
 * change 42 CFR Chapter I needs to know it answers to both the Indian Health Service and the
 * Public Health Service.
 */
export const SharedScope = z.object({
  ref_key: z.string(),
  title_number: z.number().int().positive(),
  title_name: z.string(),
  display: z.string(),
  ecfr_url: z.string(),
  label: z.string().nullable(),
  /**
   * `HIERARCHY`, not a literal list: this schema and `ScopeSchema.narrowest_level` in core
   * describe the same field, and a second spelling of the vocabulary would let the exporter
   * and the reader disagree about what a scope level is.
   */
  narrowest_level: z.enum(HIERARCHY),
  word_count: WordCount,
  /** Ordered by sortable_name, matching `scope_overlap.agency_slugs`. */
  agencies: z.array(AgencyRef),
});
export type SharedScope = z.infer<typeof SharedScope>;

// ─── data quality ────────────────────────────────────────────────────────────

/**
 * The transparency page's payload.
 *
 * `sample` is bounded because a status can cover tens of thousands of nodes and the page must
 * stay a single fast document. The page prints the full `count` next to the truncated sample
 * and links to the API for the complete list — showing 50 of 12,000 without saying so would be
 * its own small dishonesty.
 */
export const DataQualityGroup = z.object({
  status: z.string(),
  count: z.number().int().nonnegative(),
  reasons: z.array(z.object({ reason: z.string(), count: z.number().int().nonnegative() })),
  sample: z.array(
    z.object({
      citation: z.string(),
      title_number: z.number().int(),
      node_type: z.string(),
      label: z.string().nullable(),
      reason: z.string(),
    }),
  ),
  sample_truncated: z.boolean(),
});
export type DataQualityGroup = z.infer<typeof DataQualityGroup>;

export const DataQuality = z.object({
  nodes_total: z.number().int().nonnegative(),
  nodes_known: z.number().int().nonnegative(),
  nodes_unknown: z.number().int().nonnegative(),
  groups: z.array(DataQualityGroup),
  /** Unknown nodes per title, so a systematically broken title is visible at a glance. */
  by_title: z.array(
    z.object({
      title_number: z.number().int(),
      title_name: z.string(),
      unknown: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  ),
  /** Agencies below 100% scope coverage, worst first. */
  partial_agencies: z.array(
    z.object({
      slug: z.string(),
      display_name: z.string(),
      coverage: CoverageSchema,
    }),
  ),
  /** References that resolve to no node in the current structure. */
  unresolved_refs: z.array(
    z.object({ ref_key: z.string(), display: z.string(), agencies: z.array(AgencyRef) }),
  ),
});
export type DataQuality = z.infer<typeof DataQuality>;

// ─── the interface every page imports ────────────────────────────────────────

/**
 * The only surface src/pages may touch.
 *
 * Every method is async because one implementation reads files off disk lazily. Accessors that
 * a `getStaticPaths` needs are cheap and cached; per-entity getters open exactly one file.
 *
 * A getter returning `null` means "this route does not exist in this dataset", and the page
 * must fall through to a 404 rather than render an empty shell.
 */
export interface AtlasData {
  readonly manifest: SnapshotManifest;

  routes(): Promise<RouteIndex>;

  listAgencies(): Promise<AgencyRow[]>;
  getAgency(slug: string): Promise<AgencyPage | null>;

  listTitles(): Promise<TitleRow[]>;
  getTitle(titleNumber: number): Promise<TitlePage | null>;
  getChapter(titleNumber: number, chapterId: string): Promise<ChapterPage | null>;
  getPart(titleNumber: number, partId: string, subpart: string | null): Promise<PartView | null>;

  listSharedScopes(): Promise<SharedScope[]>;
  getDataQuality(): Promise<DataQuality>;
  /** Corpus-wide monthly amendment activity for the dashboard. */
  getAmendmentActivity(): Promise<AmendmentSeries>;
}

export { CoverageSchema, ScopeSchema, WordCount };
