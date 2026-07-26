/**
 * Amendment reads.
 *
 * The table has 478,050 rows and the primary key is
 * (title_number, section_identifier, amendment_date, issue_date) — all four, because
 * (title, section, amendment_date) collides 1,619 times in title 21 alone.
 */

import { countOf, rowsOf } from './util.js';

export interface AmendmentRow {
  title_number: number;
  section_identifier: string;
  amendment_date: string;
  issue_date: string;
  part: string | null;
  subpart: string | null;
  name: string | null;
  removed: number;
  substantive: number;
}

export interface AmendmentQuery {
  limit: number;
  offset: number;
  title?: number;
  part?: string;
  section?: string;
  /** Inclusive bounds on issue_date, the date content is actually fetchable at. */
  issueDateFrom?: string;
  issueDateTo?: string;
  substantiveOnly?: boolean;
  includeRemoved?: boolean;
}

export async function listAmendments(
  db: D1Database,
  q: AmendmentQuery,
): Promise<{ rows: AmendmentRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (typeof q.title === 'number') {
    where.push('title_number = ?');
    params.push(q.title);
  }
  if (q.part) {
    where.push('part = ?');
    params.push(q.part);
  }
  if (q.section) {
    where.push('section_identifier = ?');
    params.push(q.section);
  }
  // Filtering on issue_date rather than amendment_date is not a preference. amendment_date
  // and issue_date differ in 49.7% of rows and 40.4% of amendment_dates predate eCFR's
  // 2017-01-01 full-text horizon, so a window over amendment_date returns rows whose content
  // cannot be fetched at the date it names.
  if (q.issueDateFrom) {
    where.push('issue_date >= ?');
    params.push(q.issueDateFrom);
  }
  if (q.issueDateTo) {
    where.push('issue_date <= ?');
    params.push(q.issueDateTo);
  }
  if (q.substantiveOnly) where.push('substantive = 1');
  if (!q.includeRemoved) where.push('removed = 0');

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const results = await db.batch([
    db
      .prepare(
        `SELECT title_number, section_identifier, amendment_date, issue_date,
                part, subpart, name, removed, substantive
           FROM amendment
           ${whereSql}
          ORDER BY issue_date DESC, title_number, section_identifier
          LIMIT ? OFFSET ?`,
      )
      .bind(...params, q.limit, q.offset),
    db.prepare(`SELECT COUNT(*) AS n FROM amendment ${whereSql}`).bind(...params),
  ]);

  return {
    rows: rowsOf<AmendmentRow>(results[0], 'amendments page'),
    total: countOf(results[1], 'amendments count'),
  };
}

/**
 * Which of the given dates eCFR has actually published as an issue date.
 *
 * `amendment.issue_date` is the corpus's record of the dates eCFR will serve full text for.
 * Nothing else in the database enumerates them, and eCFR does not publish one date per
 * calendar day — 57 issue dates in an 84-day window, no weekends.
 *
 * This exists so /v1/diff can reject a date nobody ever issued BEFORE it spends anything.
 * Without it every syntactically valid date in the last nine years is a cache miss, and a
 * cache miss is two upstream fetches of up to 5 MB plus a permanent R2 object — an
 * unauthenticated amplifier pointed at eCFR and at our own storage bill.
 *
 * The placeholder list is built from the ARRAY LENGTH, never from the values, so no caller
 * input reaches the SQL text. `idx_amendment_issue` makes each probe an index seek.
 */
export async function knownIssueDates(
  db: D1Database,
  dates: readonly string[],
): Promise<Set<string>> {
  const wanted = [...new Set(dates)];
  if (wanted.length === 0) return new Set();

  const placeholders = wanted.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT DISTINCT issue_date FROM amendment WHERE issue_date IN (${placeholders})`)
    .bind(...wanted)
    .all<{ issue_date: string }>();

  return new Set(results.map((row) => row.issue_date));
}

/**
 * The two issue dates bracketing a section's state, used to offer a default diff window.
 *
 * Returns the most recent issue_date at or before `on`, and the one before that. A caller
 * asking "what changed most recently in 40 CFR 60.1" wants exactly this pair.
 */
export async function getAdjacentIssueDates(
  db: D1Database,
  title: number,
  section: string,
  on?: string,
): Promise<{ current: string | null; previous: string | null }> {
  const params: unknown[] = [title, section];
  let bound = '';
  if (on) {
    bound = 'AND issue_date <= ?';
    params.push(on);
  }

  const { results } = await db
    .prepare(
      `SELECT DISTINCT issue_date
         FROM amendment
        WHERE title_number = ? AND section_identifier = ? ${bound}
        ORDER BY issue_date DESC
        LIMIT 2`,
    )
    .bind(...params)
    .all<{ issue_date: string }>();

  return {
    current: results[0]?.issue_date ?? null,
    previous: results[1]?.issue_date ?? null,
  };
}
