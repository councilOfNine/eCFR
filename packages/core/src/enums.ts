/**
 * The canonical string vocabularies, as const objects.
 *
 * The `enum` keyword is banned in this repository: scripts/sync runs TypeScript through
 * Node's native type stripping (erasableSyntaxOnly), and an `enum` emits runtime code that
 * stripping cannot erase. A const object plus a derived union type gives the same dotted
 * access and the same exhaustiveness checking with zero emit.
 *
 * The string VALUES here are frozen. They live in the D1 CHECK constraints
 * (packages/db/migrations/0001_init.sql), in the Zod schemas, and on the public API wire, so
 * renaming one is a migration plus an API break — never a refactor. Only the access pattern
 * (`WordCountStatus.Counted` instead of a scattered `'counted'`) is this module's to change.
 *
 * Each vocabulary is exported in three shapes derived from one definition: the object for
 * dotted access, the union type, and an ordered `as const` tuple whose elements reference the
 * object. The tuple exists because Zod 4's `z.enum` requires literal element types and
 * `Object.values()` widens to `X[]`, which it rejects. `satisfies` proves every tuple element
 * is a member; packages/core/test/enums.test.ts proves the reverse inclusion and that the Zod
 * inferences stay identical.
 */

/** Why a node does or does not have a word count. */
export const WordCountStatus = {
  /** Measured directly by parsing this node's own XML. */
  Counted: 'counted',
  /** Summed from descendants, all of which are themselves known. */
  RolledUp: 'rolled_up',
  /** The node exists in the CFR structure but is reserved and has no text. Genuinely 0. */
  ReservedEmpty: 'reserved_empty',
  /**
   * The structure declares this node's XML subtree as zero bytes: an editorial `hed1`
   * heading or a note shell whose only content is its own label — and headings are excluded
   * from word counts by design. Genuinely 0. Distinct from `reserved_empty` because the node
   * is not flagged reserved; reusing that status would store self-contradicting rows.
   */
  StructurallyEmpty: 'structurally_empty',
  /** Previously counted; the source has since changed and the recount has not run yet. */
  Stale: 'stale',
  /** In scope, but no sync run has reached it yet. */
  NotComputed: 'not_computed',
  /** eCFR did not return the XML (429/504/network) after the retry budget. */
  UnavailableFetchFailed: 'unavailable_fetch_failed',
  /** XML returned but could not be parsed into a countable subtree. */
  UnavailableParseFailed: 'unavailable_parse_failed',
  /** The node exceeds the per-node processing ceiling and was skipped deliberately. */
  UnavailableTooLarge: 'unavailable_too_large',
} as const;

export type WordCountStatus = (typeof WordCountStatus)[keyof typeof WordCountStatus];

/**
 * Kept in sync with the CHECK constraint on `structure_node.word_count_status`
 * (packages/db/migrations/0001_init.sql). Adding a variant means writing a migration.
 */
export const WORD_COUNT_STATUSES = [
  WordCountStatus.Counted,
  WordCountStatus.RolledUp,
  WordCountStatus.ReservedEmpty,
  WordCountStatus.StructurallyEmpty,
  WordCountStatus.Stale,
  WordCountStatus.NotComputed,
  WordCountStatus.UnavailableFetchFailed,
  WordCountStatus.UnavailableParseFailed,
  WordCountStatus.UnavailableTooLarge,
] as const satisfies readonly WordCountStatus[];

/** Statuses that MUST carry a number. */
export const KNOWN_STATUSES = [
  WordCountStatus.Counted,
  WordCountStatus.RolledUp,
  WordCountStatus.ReservedEmpty,
  WordCountStatus.StructurallyEmpty,
  WordCountStatus.Stale,
] as const satisfies readonly WordCountStatus[];

/** Statuses that MUST NOT carry a number. */
export const UNKNOWN_STATUSES = [
  WordCountStatus.NotComputed,
  WordCountStatus.UnavailableFetchFailed,
  WordCountStatus.UnavailableParseFailed,
  WordCountStatus.UnavailableTooLarge,
] as const satisfies readonly WordCountStatus[];

export type KnownStatus = (typeof KNOWN_STATUSES)[number];
export type UnknownStatus = (typeof UNKNOWN_STATUSES)[number];

/** How a known count was arrived at. Recorded so a total can be audited later. */
export const CountMethod = {
  /** Parsed the node's own XML subtree with a real XML parser. */
  XmlParse: 'xml_parse',
  /** Summed measured descendants. */
  DescendantSum: 'descendant_sum',
  /** The node is reserved; zero by definition, nothing was parsed. */
  Reserved: 'reserved',
  /** eCFR's structure fingerprint declares zero XML bytes for this subtree; zero words follows. */
  DeclaredEmpty: 'declared_empty',
} as const;

export type CountMethod = (typeof CountMethod)[keyof typeof CountMethod];

/** Mirrors the CHECK constraint on `structure_node.word_count_method`. */
export const COUNT_METHODS = [
  CountMethod.XmlParse,
  CountMethod.DescendantSum,
  CountMethod.Reserved,
  CountMethod.DeclaredEmpty,
] as const satisfies readonly CountMethod[];

/**
 * A level an agency CFR reference can name. This is the SCOPE vocabulary — what
 * `agency_cfr_reference.narrowest_level` may hold — not the structure-tree vocabulary below,
 * which additionally has subpart, subject_group, section and appendix.
 */
export const HierarchyLevel = {
  Title: 'title',
  Subtitle: 'subtitle',
  Chapter: 'chapter',
  Subchapter: 'subchapter',
  Part: 'part',
} as const;

export type HierarchyLevel = (typeof HierarchyLevel)[keyof typeof HierarchyLevel];

/** Ordered outermost-to-innermost. The narrowest present level defines a reference's scope. */
export const HIERARCHY = [
  HierarchyLevel.Title,
  HierarchyLevel.Subtitle,
  HierarchyLevel.Chapter,
  HierarchyLevel.Subchapter,
  HierarchyLevel.Part,
] as const satisfies readonly HierarchyLevel[];

/** The CFR structure-tree vocabulary, as stored in `structure_node.node_type`. */
export const StructureNodeType = {
  Title: 'title',
  Subtitle: 'subtitle',
  Chapter: 'chapter',
  Subchapter: 'subchapter',
  Part: 'part',
  Subpart: 'subpart',
  SubjectGroup: 'subject_group',
  Section: 'section',
  Appendix: 'appendix',
} as const;

export type StructureNodeType = (typeof StructureNodeType)[keyof typeof StructureNodeType];

/** Ordered outermost-to-innermost, matching eCFR's DIV1..DIV9 levels. */
export const STRUCTURE_NODE_TYPES = [
  StructureNodeType.Title,
  StructureNodeType.Subtitle,
  StructureNodeType.Chapter,
  StructureNodeType.Subchapter,
  StructureNodeType.Part,
  StructureNodeType.Subpart,
  StructureNodeType.SubjectGroup,
  StructureNodeType.Section,
  StructureNodeType.Appendix,
] as const satisfies readonly StructureNodeType[];

/** Outcome of one section diff on the public API (`DiffResponse.status`). */
export const DiffStatus = {
  Modified: 'modified',
  Added: 'added',
  Removed: 'removed',
  Unchanged: 'unchanged',
  /** Old side could not be fetched. Explicitly NOT reported as `added`. */
  Unavailable: 'unavailable',
  /** Above the per-section line cap; the full diff is not computed inline. */
  TooLarge: 'too_large',
} as const;

export type DiffStatus = (typeof DiffStatus)[keyof typeof DiffStatus];

export const DIFF_STATUSES = [
  DiffStatus.Modified,
  DiffStatus.Added,
  DiffStatus.Removed,
  DiffStatus.Unchanged,
  DiffStatus.Unavailable,
  DiffStatus.TooLarge,
] as const satisfies readonly DiffStatus[];

/**
 * Exhaustiveness backstop for `switch` statements over these unions.
 *
 * Two audiences: the compiler rejects the call while `x` is anything narrower than `never`,
 * so a switch missing a variant fails to build; and the throw catches data that arrives wider
 * than its declared type at runtime — a row written by a future migration, a response from a
 * newer API — instead of letting it fall through as a silently unhandled case.
 */
export function assertNever(x: never, context: string): never {
  throw new Error(`unreachable ${context} variant: ${JSON.stringify(x)}`);
}
