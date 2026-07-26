/**
 * OpenAPI-facing schemas.
 *
 * Response shapes come from @ecfr-atlas/core/api-schemas wherever that module defines one, so
 * the Astro build and this Worker cannot disagree about the wire format. Only two categories
 * are defined here:
 *
 *   1. REQUEST schemas — query strings, path params, request bodies. These are an HTTP
 *      concern and have no business in a package the sync pipeline imports.
 *
 *   2. Response shapes core does not (yet) define: parts, search, overlap, word-counts, and
 *      the account resources.
 *
 * Where a core schema is EXTENDED, it is extended additively and the reason is stated inline.
 * Zod objects strip unknown keys rather than rejecting them, so a client validating a response
 * against the core schema still parses successfully; the extra fields are documented in this
 * API's own spec. Every such extension is listed in the module's contract notes as a proposed
 * change to core.
 */

import {
  Amendment as CoreAmendment,
  ApiError as CoreApiError,
  DiffResponse as CoreDiffResponse,
  MetaResponse as CoreMetaResponse,
  WordCount as CoreWordCount,
  Coverage,
  Page,
} from '@ecfr-atlas/core/api-schemas';
import { z } from '@hono/zod-openapi';
import {
  ABSOLUTE_MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  ECFR_BASE_URL,
  STRUCTURE_DEFAULT_INCLUDES_SECTIONS,
  STRUCTURE_MAX_NODES,
} from './constants/config.js';
import { AGENCY_SORT_KEYS } from './db/agencies.js';
import { OVERLAP_SORT_KEYS } from './db/overlap.js';
import { SECTION_ID_PATTERN } from './diff/section-id.js';
// The z.enum tuples below come from src/enums.ts so the wire contract and the dispatch
// vocabulary are one definition — the schema literally cannot drift from the switch cases.
import {
  API_TIERS,
  KEY_TIERS,
  SEARCH_HIT_KINDS,
  SEARCH_KINDS,
  SearchKind,
  WORD_COUNT_GROUPS,
  WordCountGroup,
  WordCountStatus,
} from './enums.js';

/**
 * The measurement envelope, with a worked example.
 *
 * The example deliberately shows the UNKNOWN case rather than a nice round measured number.
 * It is the one every consumer has to handle and the one they will not think about, and
 * "words can be null" reads very differently as prose than as a rendered example sitting in
 * the schema. Every response in this API that carries a count carries this shape.
 */
const WordCount = CoreWordCount.openapi({
  example: {
    words: null,
    status: WordCountStatus.UnavailableFetchFailed,
    reason: 'eCFR returned 429 after the retry budget. This is NOT zero — do not sum it.',
    method: null,
  },
});

export { Coverage, Page, WordCount };

// ─── shared request pieces ───────────────────────────────────────────────────

export const PaginationQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ABSOLUTE_MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .describe(
      `Rows per page. Clamped down to your tier's ceiling; see RateLimit-Policy and /docs.`,
    ),
  offset: z.coerce.number().int().min(0).default(0).describe('Rows to skip.'),
});

export const TitleNumberParam = z.object({
  n: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .describe('CFR title number, 1-50. Title 35 is reserved and has no content.')
    .openapi({ example: 40 }),
});

/**
 * Compact part identifier: `{title}-{part}`, e.g. `40-60` for 40 CFR Part 60.
 *
 * A full node citation (`title-40/chapter-I/subchapter-C/part-60`) contains slashes and
 * cannot be a single path segment. The compact form is unambiguous — a part identifier is
 * unique within its title — and the full citation comes back on the response for callers who
 * want to walk the structure with /v1/titles/{n}/structure?parent=.
 */
export const PartCitationParam = z.object({
  citation: z
    .string()
    .regex(/^([1-9]|[1-4][0-9]|50)-([0-9]{1,4}[A-Za-z]?)$/, 'expected {title}-{part}, e.g. "40-60"')
    .describe('Compact part id: `{title}-{part}`. Example: `40-60` = 40 CFR Part 60.')
    .openapi({ example: '40-60' }),
});

export const AgencySlugParam = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'agency slugs are lowercase, digits and hyphens')
    .describe('eCFR agency slug, e.g. `environmental-protection-agency`.')
    .openapi({ example: 'environmental-protection-agency' }),
});

// ─── agencies ────────────────────────────────────────────────────────────────

export const AgencyListQuery = PaginationQuery.extend({
  sort: z
    .enum(AGENCY_SORT_KEYS)
    .default('name')
    .describe(
      'Sort order. `coverage` ascending surfaces the agencies whose totals you should trust least.',
    ),
  parent: z
    .string()
    .max(120)
    .optional()
    .describe('Filter to children of this agency slug. Pass `root` for top-level agencies only.'),
  title: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Only agencies with at least one CFR reference in this title.'),
  q: z.string().max(200).optional().describe('Case-insensitive substring of the agency name.'),
});

/**
 * Core's `AgencySummary` already carries everything the list needs. Re-exported under this
 * name so a route definition reads as its own resource rather than as an import.
 */
export { AgencyDetail, AgencySummary, paginated } from '@ecfr-atlas/core/api-schemas';

// ─── titles ──────────────────────────────────────────────────────────────────

export const TitleOut = z.object({
  number: z.number().int(),
  name: z.string(),
  /** All three are null for reserved title 35. Null-guard before formatting. */
  latest_amended_on: z.string().nullable(),
  latest_issue_date: z.string().nullable(),
  up_to_date_as_of: z.string().nullable(),
  reserved: z.boolean(),
  word_count: WordCount,
  parts_count: z.number().int(),
  sections_count: z.number().int(),
  ecfr_url: z.string(),
});

export const TitleListOut = z.object({ data: z.array(TitleOut) });

export const StructureQuery = z.object({
  parent: z
    .string()
    .max(300)
    .regex(/^[A-Za-z0-9@._/-]+$/, 'citations contain only letters, digits, and . _ - / @')
    .optional()
    .describe(
      'Return only the subtree at this citation, e.g. `title-40/chapter-I`. Use this to expand the tree lazily.',
    ),
  include_sections: z
    .enum(['true', 'false'])
    .default(STRUCTURE_DEFAULT_INCLUDES_SECTIONS ? 'true' : 'false')
    .describe(
      "Sections are 227,558 of the corpus's 275,271 nodes. Off by default; scope with `parent` before turning it on.",
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(STRUCTURE_MAX_NODES)
    .default(STRUCTURE_MAX_NODES)
    .describe('Maximum nodes returned. The response says whether it was truncated.'),
});

export const StructureOut = z.object({
  title: z.number().int(),
  /** Roots of the returned forest — the title node, or the `parent` you asked for. */
  nodes: z.array(z.unknown()),
  node_count: z.number().int(),
  /** True when the node limit cut the result. Narrow with `parent` and page through. */
  truncated: z.boolean(),
});

// ─── parts ───────────────────────────────────────────────────────────────────

export const PartOut = z.object({
  citation: z.string().describe('Full ancestry path. The natural key in structure_node.'),
  title: z.number().int(),
  part: z.string(),
  label: z.string().nullable(),
  reserved: z.boolean(),
  subtitle: z.string().nullable(),
  chapter: z.string().nullable(),
  subchapter: z.string().nullable(),
  display: z.string(),
  ecfr_url: z.string(),
  word_count: WordCount,
  /** eCFR's own additive byte size. A change fingerprint, not a measurement of content. */
  xml_bytes: z.number().int().nullable(),
  sections_count: z.number().int(),
  subparts_count: z.number().int(),
  agencies: z
    .array(z.object({ slug: z.string(), display_name: z.string() }))
    .describe(
      'Agencies whose CFR references cover this part, resolved by scope containment rather than string equality — a chapter-level reference covers every part beneath it.',
    ),
  content: z.object({
    key: z.string().nullable().describe('R2 object key for the rendered text, if published.'),
    url: z.string().nullable().describe('Absolute URL, or null when no public base is set.'),
  }),
});

// ─── search ──────────────────────────────────────────────────────────────────

export const SearchQuery = z.object({
  q: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'A name ("environmental protection") or a citation ("40 CFR 60", "40 CFR Part 60", "title-40/chapter-I").',
    )
    .openapi({ example: '40 CFR Part 60' }),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  kind: z.enum(SEARCH_KINDS).default(SearchKind.All).describe('Restrict the result set.'),
});

export const SearchHit = z.object({
  kind: z.enum(SEARCH_HIT_KINDS),
  id: z.string().describe('Agency slug, title number, or node citation.'),
  display: z.string(),
  label: z.string().nullable(),
  title: z.number().int().nullable(),
  /** Where to go next in this API. */
  href: z.string(),
  ecfr_url: z.string().nullable(),
  word_count: WordCount.nullable(),
});

export const SearchOut = z.object({
  query: z.string(),
  /** Set when the query was recognised as a citation rather than a name. */
  interpreted_as: z
    .object({
      title: z.number().int(),
      subtitle: z.string().nullable(),
      chapter: z.string().nullable(),
      subchapter: z.string().nullable(),
      part: z.string().nullable(),
      section: z.string().nullable(),
    })
    .nullable(),
  data: z.array(SearchHit),
});

// ─── overlap ─────────────────────────────────────────────────────────────────

export const OverlapQuerySchema = PaginationQuery.extend({
  title: z.coerce.number().int().min(1).max(50).optional(),
  min_agencies: z.coerce.number().int().min(2).max(20).optional(),
  sort: z.enum(OVERLAP_SORT_KEYS).default('words'),
});

export const OverlapOut = z.object({
  ref_key: z.string(),
  title: z.number().int(),
  display: z.string(),
  ecfr_url: z.string(),
  agency_count: z.number().int(),
  /**
   * The claimants, in the canonical order the split uses (sortable_name, then slug).
   *
   * `share` is that agency's contribution to its own deduplicated total: floor(w / k) words,
   * with the remainder w mod k distributed one word each to the first (w mod k) claimants in
   * this order. The shares therefore sum to exactly the scope's `word_count` with no rounding
   * drift — sum them and check.
   *
   * It is a full measurement envelope, not a bare number, for the same reason every other
   * count in this API is: `words: null` with a `reason` when the scope itself is unmeasured,
   * because a share of an unknown is an unknown and never a zero.
   */
  agencies: z.array(z.object({ slug: z.string(), display_name: z.string(), share: WordCount })),
  word_count: WordCount,
});

// ─── amendments ──────────────────────────────────────────────────────────────

export const AmendmentQuerySchema = PaginationQuery.extend({
  title: z.coerce.number().int().min(1).max(50).optional(),
  part: z
    .string()
    .max(20)
    .regex(/^[0-9]{1,4}[A-Za-z]?$/)
    .optional()
    .openapi({ example: '60' }),
  section: z.string().max(48).optional(),
  issue_date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Inclusive lower bound on issue_date (NOT amendment_date).')
    .openapi({ example: '2026-01-01' }),
  issue_date_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  substantive_only: z.enum(['true', 'false']).default('false'),
  include_removed: z.enum(['true', 'false']).default('false'),
});

/**
 * Core's `Amendment` plus the two links a consumer immediately wants. Additive: a client
 * validating against core ignores them.
 */
export const AmendmentOut = CoreAmendment.extend({
  ecfr_url: z.string(),
  diff_url: z
    .string()
    .nullable()
    .describe('Ready-made /v1/diff call against the previous issue, when one exists.'),
});

// ─── word counts ─────────────────────────────────────────────────────────────

export const WordCountQuery = PaginationQuery.extend({
  group: z
    .enum(WORD_COUNT_GROUPS)
    .default(WordCountGroup.Agency)
    .describe('Whether to publish per-agency or per-title figures.'),
  sort: z.enum(['deduplicated', 'attributed', 'name', 'coverage']).default('deduplicated'),
});

export const WordCountRowOut = z.object({
  group: z.enum(WORD_COUNT_GROUPS),
  id: z.string(),
  label: z.string(),
  /** Counts a shared scope in full for each claiming agency. Does NOT sum to the corpus. */
  attributed: WordCount,
  /** Shared scopes split evenly, so the corpus total is conserved. The headline figure. */
  deduplicated: WordCount,
  coverage: Coverage,
  href: z.string(),
});

export const WordCountOut = z.object({
  data: z.array(WordCountRowOut),
  page: Page,
  totals: z.object({
    /** Sum over the 49 title nodes. Unknown unless every one of them is measured. */
    corpus: WordCount,
    attributed: WordCount,
    deduplicated: WordCount,
  }),
});

// ─── meta ────────────────────────────────────────────────────────────────────

/**
 * Core's `MetaResponse` publishes the corpus totals as bare nullable integers, which cannot
 * satisfy this API's rule that every published number arrives with its status. The bare
 * fields are kept for compatibility and the `*_status` companions carry the truth.
 */
export const MetaOut = CoreMetaResponse.extend({
  corpus: CoreMetaResponse.shape.corpus.extend({
    chapters: z.number().int(),
    cfr_references: z.number().int(),
    shared_scopes: z.number().int(),
    structure_nodes: z.number().int(),
    amendments: z.number().int(),
    titles_reserved: z.number().int(),
    /** The honest corpus figure: the sum of the 49 title nodes, with its status attached. */
    total_words: WordCount,
    total_words_attributed_status: WordCount,
    total_words_deduplicated_status: WordCount,
    unknown_by_status: z.record(z.string(), z.number().int()),
  }),
  source: z.literal(ECFR_BASE_URL),
  /** Everything a caller needs to reproduce a figure: what ran, when, over what. */
  last_run: z
    .object({
      id: z.number().int(),
      kind: z.string(),
      status: z.string(),
      started_at: z.string(),
      finished_at: z.string().nullable(),
      source_date: z.string().nullable(),
      titles_touched: z.number().int(),
      fetch_failures: z.number().int(),
      parse_failures: z.number().int(),
    })
    .nullable(),
  tiers: z.array(
    z.object({
      tier: z.enum(API_TIERS),
      daily_quota: z.number().int(),
      burst_per_minute: z.number().int(),
      max_page_size: z.number().int(),
      description: z.string(),
    }),
  ),
});

// ─── diff ────────────────────────────────────────────────────────────────────

export const DiffQuery = z.object({
  title: z.coerce.number().int().min(1).max(50).openapi({ example: 40 }),
  section: z
    .string()
    .max(48)
    .describe(
      `CFR section identifier, validated against a strict allowlist: /${SECTION_ID_PATTERN}/. Examples: 60.1, 1.72-9, 1.401(a)(4)-1.`,
    )
    .openapi({ example: '60.1' }),
  from: z
    .string()
    .describe('Older side, as an eCFR ISSUE date (YYYY-MM-DD). Not an amendment_date.')
    .openapi({ example: '2025-01-02' }),
  to: z
    .string()
    .describe('Newer side, as an eCFR issue date (YYYY-MM-DD).')
    .openapi({ example: '2026-07-17' }),
});

/**
 * Core's `DiffResponse` plus line numbers and per-side availability.
 *
 * Core models a hunk as `{lines: [{type, text}]}` with no positions. A diff without line
 * numbers cannot be rendered next to the source text, which is the entire use case for
 * someone drafting a comment on a rule, so this API returns positions. Additive: `hunks[].lines[]`
 * still contains `type` and `text`, so a core-schema `parse()` succeeds and simply drops them.
 */
export const DiffOut = CoreDiffResponse.extend({
  hunks: z.array(
    z.object({
      old_start: z.number().int(),
      old_lines: z.number().int(),
      new_start: z.number().int(),
      new_lines: z.number().int(),
      lines: z.array(
        z.object({
          type: z.enum(['context', 'add', 'remove']),
          text: z.string(),
          old_line: z.number().int().nullable(),
          new_line: z.number().int().nullable(),
        }),
      ),
    }),
  ),
  old_available: z.boolean(),
  new_available: z.boolean(),
  old_line_count: z.number().int().nullable(),
  new_line_count: z.number().int().nullable(),
  computed_at: z.string(),
  old_ecfr_url: z.string(),
  new_ecfr_url: z.string(),
});

// ─── accounts ────────────────────────────────────────────────────────────────

export const RegisterBody = z.object({
  email: z
    .email()
    .max(320)
    .describe('Where the verification token is sent.')
    .openapi({ example: 'analyst@example.org' }),
  organization: z.string().max(200).optional(),
  intended_use: z
    .string()
    .max(1000)
    .optional()
    .describe('Optional. Helps us decide who to grant the elevated tier to.')
    .openapi({ example: 'Tracking EPA rulemaking volume for a policy brief.' }),
});

export const RegisterOut = z.object({
  status: z.literal('verification_sent'),
  message: z.string(),
  /** Present only outside production, so local development does not need a mail server. */
  dev_token: z.string().nullable(),
});

export const VerifyBody = z.object({
  token: z.string().min(20).max(256),
});

export const ApiKeyOut = z.object({
  id: z.string(),
  label: z.string().nullable(),
  tier: z.enum(KEY_TIERS),
  /** Last 4 characters of the secret, so you can tell your keys apart in a list. */
  suffix: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});

export const ApiKeyWithSecretOut = ApiKeyOut.extend({
  secret: z.string().describe('The full key. Shown once. There is no endpoint that repeats it.'),
  warning: z.string(),
});

export const CreateKeyBody = z.object({
  label: z.string().max(100).optional().describe('For your own bookkeeping.'),
});

export const KeyListOut = z.object({ data: z.array(ApiKeyOut) });

export const KeyIdParam = z.object({
  id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    .describe('Key id, as shown by GET /v1/account/keys.'),
});

export const RevokeOut = z.object({ status: z.literal('revoked'), id: z.string() });

/**
 * Operator-only. The elevated tier is granted by hand, per the product decision, so there has
 * to be something that grants it — otherwise "manually granted" means "by editing the
 * database", which is how a production incident starts.
 */
export const GrantTierBody = z.object({
  email: z.email().max(320),
  tier: z.enum(KEY_TIERS),
});

export const GrantTierOut = z.object({
  account_id: z.string(),
  tier: z.enum(KEY_TIERS),
  keys_updated: z.number().int(),
});

// ─── errors ──────────────────────────────────────────────────────────────────

/** Core's error envelope plus the fields every response here actually carries. */
export const ErrorOut = CoreApiError.extend({
  error: CoreApiError.shape.error.extend({
    details: z.record(z.string(), z.unknown()).nullable(),
    request_id: z.string(),
    docs: z.string(),
  }),
});
