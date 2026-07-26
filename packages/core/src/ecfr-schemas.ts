/**
 * Zod schemas for the eCFR API boundary.
 *
 * These serve three jobs from one definition:
 *   1. runtime validation in the sync pipeline (fail loudly on a shape change, rather than
 *      writing `undefined` into a word count);
 *   2. the scheduled contract test, which fetches live and parses against these;
 *   3. static types via `z.infer`.
 *
 * Policy: object schemas are LOOSE (unknown keys pass) because eCFR adds fields without
 * notice and we don't want a new field to break the nightly sync. But every field we
 * actually read is required and typed. That asymmetry is deliberate — additive upstream
 * changes are safe, changes to fields we depend on are not.
 *
 * Docs: https://www.ecfr.gov/developer/documentation/api/v1
 * NOTE: that page 302s to a bot-block for automated clients; open it in a real browser.
 */

import { z } from 'zod';

/** eCFR dates are bare `YYYY-MM-DD`, never ISO timestamps. */
export const EcfrDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

// ─── /api/admin/v1/agencies.json ──────────────────────────────────────────────

/**
 * A slice of the CFR an agency administers.
 *
 * Every field below `title` is optional and they nest: a reference may be a whole title, a
 * title+chapter, or a title+chapter+part. Honouring the NARROWEST present field is
 * mandatory — the predecessor read only `chapter` and so credited one agency 12.7x its
 * actual words.
 */
export const CfrReference = z
  .object({
    title: z.number().int().positive(),
    subtitle: z.string().optional(),
    chapter: z.string().optional(),
    subchapter: z.string().optional(),
    part: z.string().optional(),
  })
  .loose();

export type CfrReference = z.infer<typeof CfrReference>;

const AgencyBase = z.object({
  name: z.string(),
  short_name: z.string().nullish(),
  display_name: z.string(),
  sortable_name: z.string(),
  slug: z.string().min(1),
  cfr_references: z.array(CfrReference).default([]),
});

export type Agency = z.infer<typeof AgencyBase> & { children: Agency[] };

/** eCFR nests sub-agencies one level deep today; recursive to survive them going deeper. */
export const Agency: z.ZodType<Agency> = AgencyBase.extend({
  children: z.lazy(() => z.array(Agency)).default([]),
}).loose();

export const AgenciesResponse = z.object({ agencies: z.array(Agency) }).loose();

// ─── /api/versioner/v1/titles.json ────────────────────────────────────────────

/**
 * Title 35 is reserved: `name` is present but all three date fields are null. Any code
 * touching these dates must null-guard or it throws on exactly one title, nightly.
 */
export const Title = z
  .object({
    number: z.number().int().positive(),
    name: z.string(),
    latest_amended_on: EcfrDate.nullable(),
    latest_issue_date: EcfrDate.nullable(),
    up_to_date_as_of: EcfrDate.nullable(),
    reserved: z.boolean(),
  })
  .loose();

export type Title = z.infer<typeof Title>;

export const TitlesResponse = z
  .object({
    titles: z.array(Title),
    meta: z
      .object({
        date: EcfrDate.optional(),
        /**
         * TRUE means eCFR is mid-import and the data is in flux. The sync MUST abort on
         * this rather than capture a half-written corpus.
         */
        import_in_progress: z.boolean().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

// ─── /api/versioner/v1/structure/{date}/title-{n}.json ────────────────────────

// Re-exported so this subpath stays a complete description of the structure endpoint; the
// canonical definition lives in enums.ts alongside the other frozen vocabularies.
export { STRUCTURE_NODE_TYPES, StructureNodeType } from './enums.js';

export interface StructureNode {
  type: string;
  identifier?: string | null;
  label: string;
  label_level?: string | null;
  label_description?: string | null;
  reserved?: boolean;
  /**
   * Additive byte size of this node's XML subtree. This is the change fingerprint that lets
   * the nightly delta skip untouched parts without downloading any XML. Correlates with
   * measured word counts at r=0.99936 — good enough to detect change, NOT good enough to
   * publish as a word count.
   */
  size?: number | null;
  descendant_range?: string | null;
  children?: StructureNode[];
}

export const StructureNode: z.ZodType<StructureNode> = z
  .object({
    type: z.string(),
    /** Null on `hed1` nodes (151 of them corpus-wide) and on generated subject groups. */
    identifier: z.string().nullish(),
    label: z.string(),
    label_level: z.string().nullish(),
    label_description: z.string().nullish(),
    reserved: z.boolean().optional(),
    size: z.number().int().nonnegative().nullish(),
    descendant_range: z.string().nullish(),
    children: z.lazy(() => z.array(StructureNode)).optional(),
  })
  .loose();

export const StructureResponse = StructureNode;

// ─── /api/versioner/v1/versions/title-{n}.json ────────────────────────────────

/**
 * One amendment to one section.
 *
 * `amendment_date` and `issue_date` differ in ~49.7% of rows. Key on `issue_date` for
 * anything that fetches content: 40.4% of amendment_dates predate eCFR's 2017-01-01
 * full-text horizon, so fetching at amendment_date returns nothing and a naive diff renders
 * "section added" for a section that has existed for decades.
 */
export const ContentVersion = z
  .object({
    date: EcfrDate,
    amendment_date: EcfrDate,
    issue_date: EcfrDate,
    identifier: z.string(),
    name: z.string(),
    part: z.string().nullish(),
    subpart: z.string().nullish(),
    title: z.union([z.string(), z.number()]).nullish(),
    type: z.string().nullish(),
    removed: z.boolean().default(false),
    substantive: z.boolean().default(true),
  })
  .loose();

export type ContentVersion = z.infer<typeof ContentVersion>;

/**
 * eCFR serialises every numeric field in /versions `meta` as a STRING — `"total_pages": "19"`,
 * not `19`. Verified live and against the committed capture in fixtures/raw/versions-12.json.
 * Declaring these as `z.number()` fails validation on any title with more than one page of
 * versions, which is every large title. Coerce rather than widen the type, so callers get a
 * real number and the string-ness stays contained here.
 */
const NumericString = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform((v) => (typeof v === 'number' ? v : Number.parseInt(v, 10)))
  .pipe(z.number().int().nonnegative());

export const VersionsResponse = z
  .object({
    content_versions: z.array(ContentVersion),
    meta: z
      .object({
        /**
         * Pagination fields are present only when the result set actually spans pages —
         * title-1 (421 rows) omits all three, title-12 (18,752 rows) carries them. They are
         * also omitted from FILTERED responses, so when you pass `issue_date[gte]=` a
         * truncated 1,000-row page is indistinguishable from a complete one. Keep delta
         * windows short and treat exactly VERSIONS_PAGE_SIZE rows as suspicious.
         */
        total_pages: NumericString.optional(),
        page: NumericString.optional(),
        per_page: NumericString.optional(),
        result_count: NumericString.optional(),
        latest_amendment_date: EcfrDate.nullish(),
        latest_issue_date: EcfrDate.nullish(),
      })
      .loose()
      .optional(),
  })
  .loose();

/** Page size eCFR uses for /versions. A full page means the window may be truncated. */
export const VERSIONS_PAGE_SIZE = 1000;

export type EcfrSchemaName = 'agencies' | 'titles' | 'structure' | 'versions';

export const ECFR_SCHEMAS = {
  agencies: AgenciesResponse,
  titles: TitlesResponse,
  structure: StructureResponse,
  versions: VersionsResponse,
} as const;
