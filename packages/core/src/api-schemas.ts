/**
 * The public API's response shapes.
 *
 * These live in core rather than in apps/api because the Astro build consumes the same
 * shapes when it prerenders. One definition, two consumers, no drift.
 *
 * The governing rule: a word count NEVER appears in a response as a bare number. It appears
 * as a `WordCount` object carrying its status. An API consumer must not be able to write
 * `sum += row.words` and silently treat "we couldn't measure this" as zero — the predecessor
 * site did exactly that to itself.
 */

import { z } from 'zod';
import { COUNT_METHODS, DIFF_STATUSES, HIERARCHY, WORD_COUNT_STATUSES } from './enums.js';

// ─── the measurement envelope ────────────────────────────────────────────────

export const WordCount = z
  .object({
    /** Null means not measured. It does NOT mean zero. Check `status` before arithmetic. */
    words: z.number().int().nonnegative().nullable(),
    status: z.enum(WORD_COUNT_STATUSES),
    /** Present only when `words` is null. Human-readable cause. */
    reason: z.string().nullable(),
    method: z.enum(COUNT_METHODS).nullable(),
  })
  .describe(
    'A word count with provenance. `words: null` means the value is unknown, not zero — ' +
      'see `status` and `reason`. Never sum these without filtering on status first.',
  );

export type WordCount = z.infer<typeof WordCount>;

/**
 * Coverage is published next to every aggregate so partial data is visible rather than
 * silently folded into a smaller-looking number.
 */
export const Coverage = z.object({
  refs_total: z.number().int().nonnegative(),
  refs_counted: z.number().int().nonnegative(),
  pct: z.number().min(0).max(1),
});

// ─── scopes and citations ────────────────────────────────────────────────────

export const ScopeSchema = z.object({
  ref_key: z.string().describe('Canonical scope key, e.g. "title-40/chapter-I/part-60"'),
  title: z.number().int().positive(),
  subtitle: z.string().nullable(),
  chapter: z.string().nullable(),
  subchapter: z.string().nullable(),
  part: z.string().nullable(),
  narrowest_level: z.enum(HIERARCHY),
  display: z.string().describe('Human citation, e.g. "40 CFR Part 60"'),
  ecfr_url: z.string().url().describe('Canonical link to the official eCFR'),
  word_count: WordCount,
});

// ─── agencies ────────────────────────────────────────────────────────────────

export const AgencySummary = z.object({
  slug: z.string(),
  name: z.string(),
  short_name: z.string().nullable(),
  display_name: z.string(),
  parent_slug: z.string().nullable(),
  children_count: z.number().int().nonnegative(),
  /** Counts a scope in full for every agency claiming it. Answers "what is this agency responsible for?" */
  attributed: WordCount,
  /** Shared scopes split evenly so the corpus total is conserved. The dashboard headline. */
  deduplicated: WordCount,
  /** Including sub-agencies. */
  subtree_attributed: WordCount,
  subtree_deduplicated: WordCount,
  coverage: Coverage,
  /** How many of this agency's scopes are co-claimed by another agency. */
  shared_refs: z.number().int().nonnegative(),
});

export const AgencyDetail = AgencySummary.extend({
  sortable_name: z.string(),
  scopes: z.array(ScopeSchema),
  children: z.array(AgencySummary),
  /** Scopes this agency shares, with co-claimants. Surfaced, not hidden. */
  shared_jurisdiction: z.array(
    z.object({
      ref_key: z.string(),
      display: z.string(),
      word_count: WordCount,
      agencies: z.array(z.object({ slug: z.string(), name: z.string() })),
    }),
  ),
  history: z.array(
    z.object({
      snapshot_date: z.string(),
      attributed: z.number().int().nullable(),
      deduplicated: z.number().int().nullable(),
      coverage_pct: z.number().nullable(),
    }),
  ),
});

// ─── structure ───────────────────────────────────────────────────────────────

export interface StructureNodeOut {
  citation: string;
  node_type: string;
  identifier: string | null;
  label: string | null;
  reserved: boolean;
  word_count: WordCount;
  ecfr_url: string;
  children?: StructureNodeOut[];
}

export const StructureNodeOut: z.ZodType<StructureNodeOut> = z.object({
  citation: z.string(),
  node_type: z.string(),
  identifier: z.string().nullable(),
  label: z.string().nullable(),
  reserved: z.boolean(),
  word_count: WordCount,
  ecfr_url: z.string().url(),
  children: z.lazy(() => z.array(StructureNodeOut)).optional(),
});

// ─── amendments ──────────────────────────────────────────────────────────────

export const Amendment = z.object({
  title: z.number().int(),
  section: z.string(),
  /** When the change legally took effect. */
  amendment_date: z.string(),
  /**
   * When eCFR issued the text. Use THIS to fetch content: it differs from amendment_date in
   * ~49.7% of rows, and 40.4% of amendment_dates predate eCFR's 2017-01-01 full-text horizon.
   */
  issue_date: z.string(),
  part: z.string().nullable(),
  subpart: z.string().nullable(),
  name: z.string().nullable(),
  removed: z.boolean(),
  substantive: z.boolean(),
});

// ─── freshness ───────────────────────────────────────────────────────────────

export const MetaResponse = z.object({
  published_run_id: z.number().int().nullable(),
  published_at: z.string().nullable(),
  /** eCFR's own snapshot date for the published data. */
  source_date: z.string().nullable(),
  schema_version: z.number().int(),
  corpus: z.object({
    agencies: z.number().int(),
    titles: z.number().int(),
    parts: z.number().int(),
    sections: z.number().int(),
    total_words_attributed: z.number().int().nullable(),
    total_words_deduplicated: z.number().int().nullable(),
    nodes_with_unknown_counts: z.number().int(),
  }),
});

// ─── diff ────────────────────────────────────────────────────────────────────

export const DiffHunk = z.object({
  lines: z.array(
    z.object({
      type: z.enum(['context', 'add', 'remove']),
      text: z.string(),
    }),
  ),
});

export const DiffResponse = z.object({
  title: z.number().int(),
  section: z.string(),
  /** Keyed on issue_date, never amendment_date. */
  issue_date: z.string(),
  compared_to: z.string().nullable(),
  /** See `DiffStatus` in enums.ts for what `unavailable` and `too_large` promise. */
  status: z.enum(DIFF_STATUSES),
  added: z.number().int().nullable(),
  removed: z.number().int().nullable(),
  hunks: z.array(DiffHunk),
  /** Present on `unavailable` and `too_large`. */
  note: z.string().nullable(),
  cached: z.boolean(),
});

// ─── errors and quota ────────────────────────────────────────────────────────

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Present on 429: how to raise the ceiling. */
    docs: z.string().url().optional(),
  }),
});

export const QuotaState = z.object({
  tier: z.enum(['anonymous', 'registered', 'elevated']),
  limit: z.number().int(),
  remaining: z.number().int(),
  /** Unix seconds when the daily window rolls over (UTC midnight). */
  reset: z.number().int(),
});

// ─── pagination ──────────────────────────────────────────────────────────────

export const Page = z.object({
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({ data: z.array(item), page: Page });
}
