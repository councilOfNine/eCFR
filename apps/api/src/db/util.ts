/**
 * Narrow accessors for D1 results.
 *
 * `db.batch()` returns an array, and `noUncheckedIndexedAccess` is on repo-wide, so every
 * positional read is `D1Result | undefined`. Rather than sprinkling non-null assertions
 * through the query modules — where a wrong index would be a silent mis-read of a different
 * statement's rows — the indexing happens here and an out-of-range read throws a message that
 * names the problem.
 */

export function rowsOf<T>(result: D1Result<unknown> | undefined, label: string): T[] {
  if (!result) throw new Error(`D1 batch is missing the result for "${label}"`);
  return (result.results as T[] | undefined) ?? [];
}

export function firstOf<T>(result: D1Result<unknown> | undefined, label: string): T | null {
  const rows = rowsOf<T>(result, label);
  return rows.length > 0 ? (rows[0] as T) : null;
}

/** `SELECT COUNT(*) AS n` — the shape used by every pagination total in this API. */
export function countOf(result: D1Result<unknown> | undefined, label: string): number {
  return firstOf<{ n: number }>(result, label)?.n ?? 0;
}

/** Rows affected by a write. Null `changes` is treated as zero, which is what it means. */
export function changesOf(result: D1Result<unknown> | undefined, label: string): number {
  if (!result) throw new Error(`D1 batch is missing the result for "${label}"`);
  return result.meta.changes ?? 0;
}
