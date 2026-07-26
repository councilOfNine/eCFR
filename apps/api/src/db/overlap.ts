/**
 * Shared jurisdiction.
 *
 * 17 of 487 scopes are claimed by 2-6 agencies. The predecessor counted each of those scopes
 * in full for every claimant and then SUMMED the per-agency totals into a corpus figure, so
 * the published corpus was larger than the corpus. `scope_overlap` is the materialised answer
 * to "which scopes are shared", and the product treats it as a feature with its own endpoint
 * rather than a caveat in a footnote — a researcher who learns that 42 CFR I is jointly run
 * by IHS and PHS has learned something they came for.
 */

import { countOf, rowsOf } from './util.js';

export interface OverlapRow {
  ref_key: string;
  title_number: number;
  agency_count: number;
  /** JSON array of slugs, ordered by sortable_name. Written by the sync pipeline. */
  agency_slugs: string;
  word_count: number | null;
}

/**
 * Sort allowlist. Values are SQL fragments; only the keys are nameable by a caller, and the
 * ORDER BY is chosen by map lookup so nothing a caller sends reaches the query text.
 */
const OVERLAP_SORTS = {
  words: 'word_count DESC NULLS LAST, ref_key',
  agencies: 'agency_count DESC, word_count DESC NULLS LAST, ref_key',
  citation: 'title_number, ref_key',
} as const;

export type OverlapSort = keyof typeof OVERLAP_SORTS;

/** The same keys as an ordered tuple, so src/schemas.ts does not hand-copy them into z.enum. */
export const OVERLAP_SORT_KEYS = [
  'words',
  'agencies',
  'citation',
] as const satisfies readonly OverlapSort[];

export interface OverlapQuery {
  limit: number;
  offset: number;
  title?: number;
  /** Only scopes with at least this many claimants. */
  minAgencies?: number;
  sort: OverlapSort;
}

export async function listOverlaps(
  db: D1Database,
  q: OverlapQuery,
): Promise<{ rows: OverlapRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (typeof q.title === 'number') {
    where.push('title_number = ?');
    params.push(q.title);
  }
  if (typeof q.minAgencies === 'number') {
    where.push('agency_count >= ?');
    params.push(q.minAgencies);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = OVERLAP_SORTS[q.sort] ?? OVERLAP_SORTS.words;

  const results = await db.batch([
    db
      .prepare(
        `SELECT ref_key, title_number, agency_count, agency_slugs, word_count
           FROM scope_overlap
           ${whereSql}
          ORDER BY ${orderSql}
          LIMIT ? OFFSET ?`,
      )
      .bind(...params, q.limit, q.offset),
    db.prepare(`SELECT COUNT(*) AS n FROM scope_overlap ${whereSql}`).bind(...params),
  ]);

  return {
    rows: rowsOf<OverlapRow>(results[0], 'overlap page'),
    total: countOf(results[1], 'overlap count'),
  };
}

/**
 * Parse the stored `agency_slugs` JSON.
 *
 * Defensive because the column is TEXT with no CHECK behind it: a malformed value should cost
 * one empty co-claimant list, not a 500 on the shared-jurisdiction page.
 */
export function parseAgencySlugs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}
