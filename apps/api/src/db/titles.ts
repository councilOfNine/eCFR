/**
 * Title and structure-tree reads.
 *
 * The structure endpoint serves the table of contents from D1. It never calls ecfr.gov — not
 * as an optimisation but because `?chapter=` and `?subtitle=` VALIDATE without SLICING on the
 * eCFR full-text endpoint, and building a user-facing path on that behaviour is how the
 * predecessor ended up publishing `substring(0, estimatedWords * 6)`.
 */

import type { MeasurementRow } from '@ecfr-atlas/core';
import { StructureNodeType } from '../enums.js';

export interface TitleRow extends MeasurementRow {
  number: number;
  name: string;
  /** All three are NULL for reserved title 35. */
  latest_amended_on: string | null;
  latest_issue_date: string | null;
  up_to_date_as_of: string | null;
  reserved: number;
  parts_count: number;
  sections_count: number;
}

/**
 * A title's own word count lives on its `structure_node` row, whose citation is exactly
 * `title-{number}` — the root of the ancestry path built by `childCitation`.
 */
const TITLE_SELECT = `
  SELECT t.number, t.name, t.latest_amended_on, t.latest_issue_date, t.up_to_date_as_of,
         t.reserved,
         n.word_count, n.word_count_status, n.word_count_method, n.word_count_reason,
         COALESCE(c.parts, 0)    AS parts_count,
         COALESCE(c.sections, 0) AS sections_count
    FROM title t
    LEFT JOIN structure_node n
           ON n.citation = 'title-' || t.number
    LEFT JOIN (
      SELECT title_number,
             SUM(CASE WHEN node_type = 'part'    THEN 1 ELSE 0 END) AS parts,
             SUM(CASE WHEN node_type = 'section' THEN 1 ELSE 0 END) AS sections
        FROM structure_node
       WHERE node_type IN ('part', 'section')
       GROUP BY title_number
    ) c ON c.title_number = t.number`;

export async function listTitles(db: D1Database): Promise<TitleRow[]> {
  const { results } = await db.prepare(`${TITLE_SELECT} ORDER BY t.number`).all<TitleRow>();
  return results;
}

export async function getTitle(db: D1Database, number: number): Promise<TitleRow | null> {
  return db.prepare(`${TITLE_SELECT} WHERE t.number = ?`).bind(number).first<TitleRow>();
}

export interface StructureRow extends MeasurementRow {
  citation: string;
  parent_citation: string | null;
  title_number: number;
  node_type: string;
  identifier: string | null;
  label: string | null;
  reserved: number;
  subtitle_id: string | null;
  chapter_id: string | null;
  subchapter_id: string | null;
  part_id: string | null;
  xml_bytes: number | null;
  content_key: string | null;
}

const STRUCTURE_SELECT = `
  SELECT citation, parent_citation, title_number, node_type, identifier, label, reserved,
         subtitle_id, chapter_id, subchapter_id, part_id, xml_bytes, content_key,
         word_count, word_count_status, word_count_method, word_count_reason
    FROM structure_node`;

export interface StructureQuery {
  title: number;
  /** Restrict to the subtree rooted at this citation (inclusive). */
  parent?: string;
  /**
   * Sections and appendices are 227,558 of the corpus's 275,271 nodes. Excluding them by
   * default is the difference between a 3 KB response and a 40 MB one for title 40.
   */
  includeSections: boolean;
  limit: number;
}

/**
 * Flat node list for a title, already ordered so a caller can build a tree in one pass.
 *
 * Ordering by citation is not cosmetic: a node's citation contains its parent's citation as a
 * prefix, so lexical order is a valid pre-order traversal — parents always precede their
 * children, and the tree builder never has to buffer orphans.
 */
export async function queryStructure(
  db: D1Database,
  q: StructureQuery,
): Promise<{ rows: StructureRow[]; truncated: boolean }> {
  const where: string[] = ['title_number = ?'];
  const params: unknown[] = [q.title];

  if (q.parent) {
    // Either the subtree root itself, or anything whose ancestry path descends from it. The
    // `/` guard stops `part-6` matching `part-60`.
    where.push(`(citation = ? OR citation LIKE ? ESCAPE '\\')`);
    params.push(q.parent, `${escapeLike(q.parent)}/%`);
  }

  if (!q.includeSections) {
    where.push(`node_type NOT IN ('section', 'appendix')`);
  }

  // One row over the limit, so "there is more" is a fact rather than an inference from
  // rows.length === limit.
  const { results } = await db
    .prepare(`${STRUCTURE_SELECT} WHERE ${where.join(' AND ')} ORDER BY citation LIMIT ?`)
    .bind(...params, q.limit + 1)
    .all<StructureRow>();

  const truncated = results.length > q.limit;
  return { rows: truncated ? results.slice(0, q.limit) : results, truncated };
}

/** Resolve a part by its title and identifier, which is what a human citation gives you. */
export async function getPart(
  db: D1Database,
  title: number,
  part: string,
): Promise<StructureRow | null> {
  return db
    .prepare(
      `${STRUCTURE_SELECT}
        WHERE title_number = ? AND node_type = 'part' AND identifier = ?
        LIMIT 1`,
    )
    .bind(title, part)
    .first<StructureRow>();
}

export interface ChildCounts {
  sections: number;
  subparts: number;
}

export async function getPartChildCounts(
  db: D1Database,
  partCitation: string,
): Promise<ChildCounts> {
  const { results } = await db
    .prepare(
      `SELECT node_type, COUNT(*) AS n
         FROM structure_node
        WHERE citation LIKE ? ESCAPE '\\'
          AND node_type IN ('section', 'subpart')
        GROUP BY node_type`,
    )
    .bind(`${escapeLike(partCitation)}/%`)
    .all<{ node_type: string; n: number }>();

  let sections = 0;
  let subparts = 0;
  for (const row of results) {
    if (row.node_type === StructureNodeType.Section) sections = row.n;
    if (row.node_type === StructureNodeType.Subpart) subparts = row.n;
  }
  return { sections, subparts };
}

/** Every CFR reference in a title. 487 corpus-wide, so a whole title's worth is tiny. */
export interface TitleRefRow {
  agency_slug: string;
  display_name: string;
  ref_key: string;
  narrowest_level: string;
  subtitle_id: string | null;
  chapter_id: string | null;
  subchapter_id: string | null;
  part_id: string | null;
}

export async function getReferencesForTitle(db: D1Database, title: number): Promise<TitleRefRow[]> {
  const { results } = await db
    .prepare(
      `SELECT r.agency_slug, a.display_name, r.ref_key, r.narrowest_level,
              r.subtitle_id, r.chapter_id, r.subchapter_id, r.part_id
         FROM agency_cfr_reference r
         JOIN agency a ON a.slug = r.agency_slug
        WHERE r.title_number = ?
        ORDER BY a.sortable_name`,
    )
    .bind(title)
    .all<TitleRefRow>();
  return results;
}

/** Escape LIKE metacharacters in a value that is data, not a pattern. */
export function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
