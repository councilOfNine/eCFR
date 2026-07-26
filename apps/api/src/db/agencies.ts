/**
 * Agency reads.
 *
 * The join that matters is `agency LEFT JOIN agency_rollup`: the rollup row is absent until a
 * sync run has produced one, and an absent rollup must surface as "not computed", not as an
 * agency with no regulations. The LEFT is load-bearing.
 */

import type { MeasurementRow } from '@ecfr-atlas/core';
import { countOf, rowsOf } from './util.js';

export interface AgencyRollupRow {
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

const AGENCY_SELECT = `
  SELECT a.slug, a.name, a.short_name, a.display_name, a.sortable_name,
         a.parent_slug, a.depth,
         r.attributed_word_count, r.deduplicated_word_count,
         r.subtree_attributed, r.subtree_deduplicated,
         r.refs_total, r.refs_counted, r.shared_refs, r.children_count, r.coverage_pct
    FROM agency a
    LEFT JOIN agency_rollup r ON r.agency_slug = a.slug`;

/**
 * Sort allowlist.
 *
 * The values are SQL fragments and the keys are the only thing a caller can name. User input
 * never reaches the query text — the ORDER BY is chosen by map lookup, and an unknown key
 * falls back to the default rather than being interpolated.
 */
export const AGENCY_SORTS = {
  name: 'a.sortable_name ASC',
  // NULLS LAST so "we don't know" sorts below "we measured zero-ish", instead of topping a
  // descending list because SQLite orders NULL first.
  deduplicated: 'r.deduplicated_word_count DESC NULLS LAST, a.sortable_name ASC',
  attributed: 'r.attributed_word_count DESC NULLS LAST, a.sortable_name ASC',
  refs: 'r.refs_total DESC NULLS LAST, a.sortable_name ASC',
  coverage: 'r.coverage_pct ASC NULLS FIRST, a.sortable_name ASC',
} as const;

export type AgencySort = keyof typeof AGENCY_SORTS;

/**
 * The same allowlist as an ordered tuple, for `z.enum` in src/schemas.ts.
 *
 * Zod needs literal element types and `Object.keys()` widens to `string[]`, so the tuple is
 * written out and `satisfies` proves every element is a real key. Without this the query
 * schema carried its own hand-copied list, and a sort the schema accepted but this map did not
 * know would silently fall back to `name` instead of being a 400.
 */
export const AGENCY_SORT_KEYS = [
  'name',
  'deduplicated',
  'attributed',
  'refs',
  'coverage',
] as const satisfies readonly AgencySort[];

export interface ListAgenciesOptions {
  limit: number;
  offset: number;
  sort: AgencySort;
  /** `null` selects top-level agencies; `undefined` means "no filter". */
  parent?: string | null;
  /** Restrict to agencies with at least one CFR reference in this title. */
  title?: number;
  /** Case-insensitive substring over name/short_name/display_name. */
  q?: string;
}

export interface Page<T> {
  rows: T[];
  total: number;
}

export async function listAgencies(
  db: D1Database,
  opts: ListAgenciesOptions,
): Promise<Page<AgencyRollupRow>> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.parent === null) {
    where.push('a.parent_slug IS NULL');
  } else if (typeof opts.parent === 'string') {
    where.push('a.parent_slug = ?');
    params.push(opts.parent);
  }

  if (typeof opts.title === 'number') {
    where.push(
      `EXISTS (SELECT 1 FROM agency_cfr_reference x
                WHERE x.agency_slug = a.slug AND x.title_number = ?)`,
    );
    params.push(opts.title);
  }

  if (opts.q) {
    // Bound three times rather than named once: the WHERE is assembled in pieces, so
    // anonymous placeholders stay aligned with `params` without a numbering scheme to get
    // wrong. The pattern itself is escaped, so `%` in the query text matches a literal `%`.
    const pattern = likePattern(opts.q);
    where.push(
      `(a.name LIKE ? ESCAPE '\\'
        OR a.short_name LIKE ? ESCAPE '\\'
        OR a.display_name LIKE ? ESCAPE '\\')`,
    );
    params.push(pattern, pattern, pattern);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = AGENCY_SORTS[opts.sort] ?? AGENCY_SORTS.name;

  const results = await db.batch([
    db
      .prepare(`${AGENCY_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
      .bind(...params, opts.limit, opts.offset),
    db.prepare(`SELECT COUNT(*) AS n FROM agency a ${whereSql}`).bind(...params),
  ]);

  return {
    rows: rowsOf<AgencyRollupRow>(results[0], 'agencies page'),
    total: countOf(results[1], 'agencies count'),
  };
}

export async function getAgency(db: D1Database, slug: string): Promise<AgencyRollupRow | null> {
  return db.prepare(`${AGENCY_SELECT} WHERE a.slug = ?`).bind(slug).first<AgencyRollupRow>();
}

export async function getAgencyChildren(
  db: D1Database,
  parentSlug: string,
): Promise<AgencyRollupRow[]> {
  const { results } = await db
    .prepare(`${AGENCY_SELECT} WHERE a.parent_slug = ? ORDER BY a.sortable_name`)
    .bind(parentSlug)
    .all<AgencyRollupRow>();
  return results;
}

/** A scope an agency claims, with the target node's measurement and any co-claimants. */
export interface AgencyScopeRow extends MeasurementRow {
  ref_key: string;
  title_number: number;
  narrowest_level: string;
  subtitle_id: string | null;
  chapter_id: string | null;
  subchapter_id: string | null;
  part_id: string | null;
  node_citation: string | null;
  label: string | null;
  agency_count: number | null;
  agency_slugs: string | null;
}

export async function getAgencyScopes(db: D1Database, slug: string): Promise<AgencyScopeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT r.ref_key, r.title_number, r.narrowest_level,
              r.subtitle_id, r.chapter_id, r.subchapter_id, r.part_id,
              r.node_citation,
              n.label,
              n.word_count, n.word_count_status, n.word_count_method, n.word_count_reason,
              o.agency_count, o.agency_slugs
         FROM agency_cfr_reference r
         LEFT JOIN structure_node n ON n.citation = r.node_citation
         LEFT JOIN scope_overlap   o ON o.ref_key  = r.ref_key
        WHERE r.agency_slug = ?
        ORDER BY r.title_number, r.ref_key`,
    )
    .bind(slug)
    .all<AgencyScopeRow>();
  return results;
}

/** Display names for a set of slugs, for rendering co-claimants without an N+1. */
export async function getAgencyNames(
  db: D1Database,
  slugs: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (slugs.length === 0) return out;

  // D1 caps bound parameters per statement; 316 agencies means the worst realistic case is
  // small, but chunking keeps a future 5,000-agency corpus from producing a 5,000-parameter
  // statement that fails at bind time rather than at review time.
  const CHUNK = 100;
  for (let i = 0; i < slugs.length; i += CHUNK) {
    const chunk = slugs.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await db
      .prepare(`SELECT slug, display_name FROM agency WHERE slug IN (${placeholders})`)
      .bind(...chunk)
      .all<{ slug: string; display_name: string }>();
    for (const row of results) out.set(row.slug, row.display_name);
  }
  return out;
}

export interface AgencySnapshotRow {
  snapshot_date: string;
  attributed_word_count: number | null;
  deduplicated_word_count: number | null;
  coverage_pct: number | null;
}

export async function getAgencyHistory(
  db: D1Database,
  slug: string,
  limit = 90,
): Promise<AgencySnapshotRow[]> {
  const { results } = await db
    .prepare(
      `SELECT snapshot_date, attributed_word_count, deduplicated_word_count, coverage_pct
         FROM agency_snapshot
        WHERE agency_slug = ?
        ORDER BY snapshot_date DESC
        LIMIT ?`,
    )
    .bind(slug, limit)
    .all<AgencySnapshotRow>();
  // Chronological for charting; the query is DESC only so LIMIT takes the recent end.
  return results.reverse();
}

/**
 * Escape a user string for use as a LIKE operand.
 *
 * `%` and `_` are LIKE metacharacters. Leaving them in lets a caller turn a substring search
 * into a full-table wildcard scan — not a ReDoS, but the same category of mistake, and the
 * fix is the same: the user supplies data, never syntax.
 */
export function likePattern(q: string): string {
  const escaped = q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  return `%${escaped}%`;
}
