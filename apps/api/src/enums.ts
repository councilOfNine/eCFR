/**
 * Closed string unions the API dispatches on, written as const objects.
 *
 * Not TypeScript `enum`s — banned repo-wide, because scripts/sync runs TypeScript through
 * Node's strip-only type stripping where `enum` is a runtime error, and one vocabulary
 * pattern across the repository beats two. The const-object + union pattern is the erasable
 * equivalent: a value namespace to write `ApiTier.Anonymous` against, and a union type the
 * compiler can prove a `switch` exhausts (ending `default: assertNever(...)`).
 *
 * Only API-LOCAL vocabularies live here. The measurement contract (WordCountStatus,
 * CountMethod), the CFR hierarchy vocabularies, DiffStatus, and `assertNever` itself belong
 * to `@ecfr-atlas/core` (packages/core/src/enums.ts) and are re-exported below so route code
 * has one import path for "a closed vocabulary this API dispatches on".
 *
 * THE LITERAL VALUES ARE FROZEN, with exactly one exception. `AccountStatus` and `KeyTier` are
 * CHECK constraints on `api_account.status` and `api_key.tier` (packages/db/migrations); the
 * tiers travel in the `X-Api-Tier` header and the /v1/meta body; `ErrorCode` is the field every
 * client branches on; `SearchKind`, `SearchHitKind` and `WordCountGroup` are query parameters
 * and response discriminators; `MemoKind` discriminates every diff memo already sitting in R2.
 * Renaming a KEY is a refactor; changing a VALUE is a migration, a bucket rewrite, or a broken
 * client. The exception is `PrincipalKind`, which never leaves this process.
 *
 * Where a Zod schema declares the same union, the schema consumes the as-const tuple exported
 * beside the object (`z.enum(API_TIERS)`, `z.enum(SEARCH_KINDS)`), so the wire contract and the
 * dispatch vocabulary cannot drift apart. The same trick is used for the sort allowlists, whose
 * tuples live beside the SQL fragments they select (src/db/agencies.ts, src/db/overlap.ts).
 */

import { StructureNodeType } from '@ecfr-atlas/core';

export {
  assertNever,
  CountMethod,
  DIFF_STATUSES,
  DiffStatus,
  HierarchyLevel,
  StructureNodeType,
  WordCountStatus,
} from '@ecfr-atlas/core';

// ─── metering ────────────────────────────────────────────────────────────────

/** Who is calling, for quota purposes. Ordered from least to most trusted. */
export const ApiTier = {
  Anonymous: 'anonymous',
  Registered: 'registered',
  Elevated: 'elevated',
} as const;
export type ApiTier = (typeof ApiTier)[keyof typeof ApiTier];

/** Tuple for `z.enum` and ordered iteration (docs render the tiers in this order). */
export const API_TIERS = [
  ApiTier.Anonymous,
  ApiTier.Registered,
  ApiTier.Elevated,
] as const satisfies readonly ApiTier[];

/**
 * The tiers a stored key may carry — `api_key.tier`'s CHECK constraint. Anonymous is a tier
 * but never a key: it exists only as the absence of one, which is what keeps "no credential"
 * meterable instead of free.
 */
export const KeyTier = {
  Registered: ApiTier.Registered,
  Elevated: ApiTier.Elevated,
} as const;
export type KeyTier = (typeof KeyTier)[keyof typeof KeyTier];

export const KEY_TIERS = [
  KeyTier.Registered,
  KeyTier.Elevated,
] as const satisfies readonly KeyTier[];

// ─── deployment ──────────────────────────────────────────────────────────────

/**
 * What `ENVIRONMENT` (a plain var, wrangler.jsonc) may name.
 *
 * Only `production` and `staging` are set by wrangler.jsonc; the other two are what a laptop
 * or a preview deploy leaves behind, and they are enumerated so the predicate below is written
 * against a vocabulary rather than against two hard-coded inequalities in two files.
 */
export const DeployEnvironment = {
  Development: 'development',
  Staging: 'staging',
  Production: 'production',
} as const;
export type DeployEnvironment = (typeof DeployEnvironment)[keyof typeof DeployEnvironment];

/** Environments that must never see a credential in a log or a response body. */
const CONFIDENTIAL_ENVIRONMENTS: readonly string[] = [
  DeployEnvironment.Staging,
  DeployEnvironment.Production,
];

/**
 * Whether a verification token must be withheld from logs and from the registration response.
 *
 * Two call sites decide the same question about the same token — the mailer's log line and
 * `dev_token` on POST /v1/account/register — and each carried its own copy of
 * `=== 'production' || === 'staging'`. If those two ever drifted apart the token would be
 * withheld from the log and returned in the response body, which is the worse half of each.
 *
 * Takes a `string` because `ENVIRONMENT` is operator-supplied and is not validated anywhere.
 */
export function isConfidentialEnvironment(environment: string): boolean {
  return CONFIDENTIAL_ENVIRONMENTS.includes(environment);
}

/**
 * Discriminant of `Principal` (src/env.ts) — how the caller was identified.
 *
 * `Anonymous` is a principal, not the absence of one, which is what makes unauthenticated
 * traffic meterable instead of free. Purely internal: unlike every other vocabulary in this
 * file these strings never reach the wire, so they are the one set here that could be renamed
 * without a migration.
 */
export const PrincipalKind = {
  Anonymous: 'anonymous',
  Key: 'key',
} as const;
export type PrincipalKind = (typeof PrincipalKind)[keyof typeof PrincipalKind];

// ─── accounts ────────────────────────────────────────────────────────────────

/** `api_account.status`'s CHECK constraint. */
export const AccountStatus = {
  /** Registered, verification token outstanding. Keys (if any) do not authenticate. */
  Pending: 'pending',
  Active: 'active',
  /** Operator action. Sticky: verification cannot resurrect a suspended account. */
  Suspended: 'suspended',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

export const ACCOUNT_STATUSES = [
  AccountStatus.Pending,
  AccountStatus.Active,
  AccountStatus.Suspended,
] as const satisfies readonly AccountStatus[];

// ─── error envelope ──────────────────────────────────────────────────────────

/**
 * `error.code` on every failure this API can return.
 *
 * The one field a client is expected to BRANCH on — the message is prose and may be improved,
 * the code may not — so these strings are as frozen as any database constraint, and they are
 * published in the OpenAPI error schema. `ErrorOut` in src/schemas.ts and the `commonErrors`
 * block in src/routes/shared.ts describe the same set.
 */
export const ErrorCode = {
  BadRequest: 'bad_request',
  Unauthorized: 'unauthorized',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  /** Burst limiter. Abuse protection, not a quota balance. */
  RateLimited: 'rate_limited',
  /** The daily D1 counter. This one IS the quota. */
  QuotaExceeded: 'quota_exceeded',
  PayloadTooLarge: 'payload_too_large',
  UpstreamUnavailable: 'upstream_unavailable',
  InternalError: 'internal_error',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Which of the two limiters refused a 429, as published in `error.details.limiter`.
 *
 * Named rather than inferred from the status because the two mean different things to a
 * client: `burst` clears in under a minute, `daily_quota` does not clear until UTC midnight.
 * Every route's 429 description points at this field, so it is one vocabulary, not two spellings.
 */
export const RateLimiter = {
  Burst: 'burst',
  DailyQuota: 'daily_quota',
} as const;
export type RateLimiter = (typeof RateLimiter)[keyof typeof RateLimiter];

// ─── search ──────────────────────────────────────────────────────────────────

/** `?kind=` on /v1/search — which of the three result families the caller wants. */
export const SearchKind = {
  All: 'all',
  Agency: 'agency',
  Title: 'title',
  Node: 'node',
} as const;
export type SearchKind = (typeof SearchKind)[keyof typeof SearchKind];

export const SEARCH_KINDS = [
  SearchKind.All,
  SearchKind.Agency,
  SearchKind.Title,
  SearchKind.Node,
] as const satisfies readonly SearchKind[];

/**
 * `kind` on a search HIT — a different vocabulary from the query filter above.
 *
 * Agencies and titles are their own kinds; every other hit is a structure node reported at the
 * level it sits at. Deliberately NOT all of `StructureNodeType`: /v1/search never returns a
 * subpart, subject group, section or appendix, so publishing those as possible hit kinds would
 * document a response that cannot occur.
 */
export const SearchHitKind = {
  Agency: 'agency',
  Title: StructureNodeType.Title,
  Subtitle: StructureNodeType.Subtitle,
  Chapter: StructureNodeType.Chapter,
  Subchapter: StructureNodeType.Subchapter,
  Part: StructureNodeType.Part,
} as const;
export type SearchHitKind = (typeof SearchHitKind)[keyof typeof SearchHitKind];

export const SEARCH_HIT_KINDS = [
  SearchHitKind.Agency,
  SearchHitKind.Title,
  SearchHitKind.Subtitle,
  SearchHitKind.Chapter,
  SearchHitKind.Subchapter,
  SearchHitKind.Part,
] as const satisfies readonly SearchHitKind[];

/**
 * The node levels /v1/search will name as a hit, innermost-first for the ranking `CASE`.
 *
 * A node whose type is not in here is reported at title level, which is the honest fallback:
 * a newer snapshot may introduce a level this API does not model, and that must degrade to a
 * coarser citation rather than take the endpoint down.
 */
export const SEARCHABLE_NODE_TYPES = [
  StructureNodeType.Chapter,
  StructureNodeType.Subchapter,
  StructureNodeType.Subtitle,
  StructureNodeType.Part,
] as const satisfies readonly StructureNodeType[];

// ─── word counts ─────────────────────────────────────────────────────────────

/** `?group=` on /v1/word-counts, and the `group` discriminator on every row it returns. */
export const WordCountGroup = {
  Agency: 'agency',
  Title: 'title',
} as const;
export type WordCountGroup = (typeof WordCountGroup)[keyof typeof WordCountGroup];

export const WORD_COUNT_GROUPS = [
  WordCountGroup.Agency,
  WordCountGroup.Title,
] as const satisfies readonly WordCountGroup[];

// ─── diff service ────────────────────────────────────────────────────────────

/** How `getDiff` resolved a request — served a body, or refused to spend an upstream fetch. */
export const DiffOutcome = {
  Served: 'served',
  ComputeNotAllowed: 'compute_not_allowed',
} as const;
export type DiffOutcome = (typeof DiffOutcome)[keyof typeof DiffOutcome];

/**
 * Discriminant of the R2 diff memo. Frozen harder than the rest: existing objects in the
 * bucket carry these strings, and a rename would turn every stored memo into a cache miss —
 * or worse, into a misread.
 */
export const MemoKind = {
  Diff: 'diff',
  Negative: 'negative',
} as const;
export type MemoKind = (typeof MemoKind)[keyof typeof MemoKind];

// ─── upstream fetch ──────────────────────────────────────────────────────────

/**
 * How one eCFR fetch ended. `Absent` is reserved for an explicit HTTP 404 — the one signal
 * that means "did not exist" rather than "could not tell" — and `Failed` is everything else,
 * which downstream must render as unknown, never as a change.
 */
export const FetchOutcomeKind = {
  Ok: 'ok',
  Absent: 'absent',
  Failed: 'failed',
} as const;
export type FetchOutcomeKind = (typeof FetchOutcomeKind)[keyof typeof FetchOutcomeKind];

/** One side of a diff after fetch + extraction. Same trichotomy, post-parse. */
export const SideKind = {
  Present: 'present',
  Absent: 'absent',
  Failed: 'failed',
} as const;
export type SideKind = (typeof SideKind)[keyof typeof SideKind];
