/**
 * Lookup by name or by citation.
 *
 * Two different questions wear the same input box. "environmental protection" is a name
 * search; "40 CFR 60" is a citation. Citations are recognised by a small set of anchored,
 * fixed-shape patterns and answered with an exact lookup, because a researcher who types a
 * citation wants that node, not a list of things whose label contains "60".
 *
 * Every pattern below is a STATIC regex applied TO user input. Nothing here ever builds a
 * regex FROM user input — that is what made the predecessor's /diff an unauthenticated ReDoS
 * (2,462 ms of CPU on a 1,600-character query).
 */

import type { MeasurementRow } from '@ecfr-atlas/core';
import { StructureNodeType } from '../enums.js';
import { escapeLike } from './titles.js';

export interface ParsedCitation {
  title: number;
  chapter?: string;
  subchapter?: string;
  subtitle?: string;
  part?: string;
  section?: string;
}

// Roman numerals and letters are both legal chapter identifiers; bounded length keeps every
// alternation linear. No nested quantifiers anywhere in this file.
const CITATION_PATTERNS: readonly { re: RegExp; build: (m: RegExpMatchArray) => ParsedCitation }[] =
  [
    // "40 CFR 60.1", "26 CFR 1.72-9"
    {
      re: /^(\d{1,2})\s*cfr\s*(?:§\s*)?(\d{1,4}[a-z]?\.[0-9a-z]{1,12}(?:-[0-9a-z]{1,12}){0,4})$/i,
      build: (m) => ({ title: num(m[1]), section: m[2] }),
    },
    // "40 CFR Part 60", "40 CFR pt. 60"
    {
      re: /^(\d{1,2})\s*cfr\s*(?:part|pt\.?)\s*([0-9]{1,4}[a-z]?)$/i,
      build: (m) => ({ title: num(m[1]), part: m[2] }),
    },
    // "40 CFR Chapter I"
    {
      re: /^(\d{1,2})\s*cfr\s*(?:chapter|ch\.?)\s*([0-9a-z]{1,8})$/i,
      build: (m) => ({ title: num(m[1]), chapter: (m[2] as string).toUpperCase() }),
    },
    // "40 CFR Subchapter C"
    {
      re: /^(\d{1,2})\s*cfr\s*(?:subchapter|subch\.?)\s*([0-9a-z]{1,8})$/i,
      build: (m) => ({ title: num(m[1]), subchapter: (m[2] as string).toUpperCase() }),
    },
    // "40 CFR Subtitle A"
    {
      re: /^(\d{1,2})\s*cfr\s*subtitle\s*([0-9a-z]{1,8})$/i,
      build: (m) => ({ title: num(m[1]), subtitle: (m[2] as string).toUpperCase() }),
    },
    // "40 CFR 60" — bare number after CFR is a part by convention.
    {
      re: /^(\d{1,2})\s*cfr\s*([0-9]{1,4}[a-z]?)$/i,
      build: (m) => ({ title: num(m[1]), part: m[2] }),
    },
    // "title 40", "title-40"
    {
      re: /^title[\s-]*(\d{1,2})$/i,
      build: (m) => ({ title: num(m[1]) }),
    },
    // The canonical refKey form, e.g. "title-40/chapter-I/part-60". Each level is optional
    // but they must appear in hierarchy order, which is exactly what refKey() emits.
    {
      re: /^title-(\d{1,2})(?:\/subtitle-([0-9a-z]{1,8}))?(?:\/chapter-([0-9a-z]{1,8}))?(?:\/subchapter-([0-9a-z]{1,8}))?(?:\/part-([0-9]{1,4}[a-z]?))?$/i,
      build: (m) => ({
        title: num(m[1]),
        ...(m[2] ? { subtitle: m[2].toUpperCase() } : {}),
        ...(m[3] ? { chapter: m[3].toUpperCase() } : {}),
        ...(m[4] ? { subchapter: m[4].toUpperCase() } : {}),
        ...(m[5] ? { part: m[5] } : {}),
      }),
    },
  ];

function num(raw: string | undefined): number {
  return Number.parseInt(raw ?? '', 10);
}

/** Returns null when the input is not a citation, which is the normal case for name search. */
export function parseCitationQuery(raw: string): ParsedCitation | null {
  const q = raw.trim();
  // 64 characters is longer than any real CFR citation. The bound is belt-and-braces on top
  // of the linear patterns: a fixed input ceiling makes worst-case matching cost a constant.
  if (q.length === 0 || q.length > 64) return null;

  for (const { re, build } of CITATION_PATTERNS) {
    const m = q.match(re);
    if (!m) continue;
    const parsed = build(m);
    if (Number.isNaN(parsed.title) || parsed.title < 1 || parsed.title > 50) return null;
    return parsed;
  }
  return null;
}

export interface AgencyHitRow {
  slug: string;
  display_name: string;
  name: string;
  deduplicated_word_count: number | null;
  refs_total: number | null;
  refs_counted: number | null;
}

export async function searchAgencies(
  db: D1Database,
  q: string,
  limit: number,
): Promise<AgencyHitRow[]> {
  const pattern = `%${escapeLike(q)}%`;
  const { results } = await db
    .prepare(
      `SELECT a.slug, a.display_name, a.name,
              r.deduplicated_word_count, r.refs_total, r.refs_counted
         FROM agency a
         LEFT JOIN agency_rollup r ON r.agency_slug = a.slug
        WHERE a.name LIKE ? ESCAPE '\\'
           OR a.short_name LIKE ? ESCAPE '\\'
           OR a.display_name LIKE ? ESCAPE '\\'
        ORDER BY
          -- Prefix matches first: someone typing "epa" means the agency, not every agency
          -- whose description happens to contain those letters.
          CASE WHEN a.display_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
          a.sortable_name
        LIMIT ?`,
    )
    .bind(pattern, pattern, pattern, `${escapeLike(q)}%`, limit)
    .all<AgencyHitRow>();
  return results;
}

export interface TitleHitRow {
  number: number;
  name: string;
  reserved: number;
}

export async function searchTitles(
  db: D1Database,
  q: string,
  limit: number,
): Promise<TitleHitRow[]> {
  const pattern = `%${escapeLike(q)}%`;
  const { results } = await db
    .prepare(
      `SELECT number, name, reserved FROM title
        WHERE name LIKE ? ESCAPE '\\'
        ORDER BY number LIMIT ?`,
    )
    .bind(pattern, limit)
    .all<TitleHitRow>();
  return results;
}

export interface NodeHitRow extends MeasurementRow {
  citation: string;
  title_number: number;
  node_type: string;
  identifier: string | null;
  label: string | null;
}

/**
 * Name search over the structural nodes worth naming.
 *
 * Restricted to part/chapter/subchapter/subtitle — about 10,500 rows, reachable through
 * idx_node_type — rather than all 275,271, because 227,558 of those are sections and a
 * section label match is noise at this altitude. Sections are addressable by citation and via
 * /v1/titles/{n}/structure.
 *
 * There is no FTS index in the schema, so this is a LIKE scan over that narrowed set. It is
 * fast enough at this size and is the obvious thing to revisit if search gets popular.
 */
export async function searchNodes(db: D1Database, q: string, limit: number): Promise<NodeHitRow[]> {
  const pattern = `%${escapeLike(q)}%`;
  const { results } = await db
    .prepare(
      `SELECT citation, title_number, node_type, identifier, label,
              word_count, word_count_status, word_count_method, word_count_reason
         FROM structure_node
        WHERE node_type IN ('part', 'chapter', 'subchapter', 'subtitle')
          AND label LIKE ? ESCAPE '\\'
        ORDER BY
          CASE node_type WHEN 'chapter' THEN 0 WHEN 'subchapter' THEN 1
                         WHEN 'subtitle' THEN 2 ELSE 3 END,
          title_number, citation
        LIMIT ?`,
    )
    .bind(pattern, limit)
    .all<NodeHitRow>();
  return results;
}

/** Exact resolution of a parsed citation to a structure node, when one exists. */
export async function resolveCitation(
  db: D1Database,
  parsed: ParsedCitation,
): Promise<NodeHitRow | null> {
  if (parsed.part) {
    return db
      .prepare(
        `SELECT citation, title_number, node_type, identifier, label,
                word_count, word_count_status, word_count_method, word_count_reason
           FROM structure_node
          WHERE title_number = ? AND node_type = 'part' AND identifier = ? LIMIT 1`,
      )
      .bind(parsed.title, parsed.part)
      .first<NodeHitRow>();
  }

  // Narrowest level first: a citation naming both a chapter and a subchapter resolves to the
  // subchapter, which is the same rule `narrowestLevel()` applies in the sync pipeline.
  const level = parsed.subchapter
    ? { type: StructureNodeType.Subchapter, id: parsed.subchapter }
    : parsed.chapter
      ? { type: StructureNodeType.Chapter, id: parsed.chapter }
      : parsed.subtitle
        ? { type: StructureNodeType.Subtitle, id: parsed.subtitle }
        : { type: StructureNodeType.Title, id: String(parsed.title) };

  return db
    .prepare(
      `SELECT citation, title_number, node_type, identifier, label,
              word_count, word_count_status, word_count_method, word_count_reason
         FROM structure_node
        WHERE title_number = ? AND node_type = ? AND identifier = ? LIMIT 1`,
    )
    .bind(parsed.title, level.type, level.id)
    .first<NodeHitRow>();
}
