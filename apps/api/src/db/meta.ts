/**
 * Freshness and corpus-wide counters.
 *
 * `app_meta` is a single row that advances only when a sync run passes the publish gate, so a
 * failed sync degrades to stale-but-correct. Every response in the API stamps its
 * `source_date` in a header for exactly that reason: a number quoted in a rulemaking comment
 * needs the date the government published, not the date we fetched.
 */

import { APP_META_TTL_MS } from '../constants/config.js';
import { StructureNodeType } from '../enums.js';
import { countOf, firstOf, rowsOf } from './util.js';

export interface AppMeta {
  published_run_id: number | null;
  published_at: string | null;
  source_date: string | null;
  schema_version: number;
}

/**
 * Isolate-local memo.
 *
 * Global mutable state in a Worker is normally a smell, but this is a read-only cache of a
 * row that changes at most once a business day (57 eCFR issue dates in 84 days, zero
 * weekends) and contains nothing request-specific. Without it, every single response pays a
 * D1 round trip to learn a date it already knew.
 */
let cached: { value: AppMeta; expiresAt: number } | null = null;

export async function getAppMeta(db: D1Database, now = Date.now()): Promise<AppMeta> {
  if (cached && cached.expiresAt > now) return cached.value;

  const row = await db
    .prepare(
      `SELECT published_run_id, published_at, source_date, schema_version
         FROM app_meta WHERE id = 1`,
    )
    .first<AppMeta>();

  // A missing row means migrations have not been applied. Reporting schema_version 0 is more
  // useful to whoever is debugging that than throwing on every request.
  const value: AppMeta = row ?? {
    published_run_id: null,
    published_at: null,
    source_date: null,
    schema_version: 0,
  };

  cached = { value, expiresAt: now + APP_META_TTL_MS };
  return value;
}

/** Test seam; also used by the retention cron so it never serves its own stale copy. */
export function clearAppMetaCache(): void {
  cached = null;
}

export interface CorpusCounts {
  agencies: number;
  titles: number;
  titles_reserved: number;
  cfr_references: number;
  shared_scopes: number;
  structure_nodes: number;
  parts: number;
  chapters: number;
  sections: number;
  amendments: number;
  nodes_with_unknown_counts: number;
  /** Sum over the 49 title-level nodes, or null if any one of them is unmeasured. */
  corpus_words: number | null;
  corpus_titles_unknown: number;
  /** Sum over agency_rollup. Counts a shared scope once per claiming agency. */
  attributed_words: number | null;
  attributed_unknown: number;
  deduplicated_words: number | null;
  deduplicated_unknown: number;
}

interface SumRow {
  total: number | null;
  unknown: number;
}
interface RollupSumRow {
  attributed: number | null;
  attributed_unknown: number;
  deduplicated: number | null;
  deduplicated_unknown: number;
}
interface NodeTypeRow {
  node_type: string;
  n: number;
}

export async function getCorpusCounts(db: D1Database): Promise<CorpusCounts> {
  const r = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM agency`),
    db.prepare(`SELECT COUNT(*) AS n FROM title`),
    db.prepare(`SELECT COUNT(*) AS n FROM title WHERE reserved = 1`),
    db.prepare(`SELECT COUNT(*) AS n FROM agency_cfr_reference`),
    db.prepare(`SELECT COUNT(*) AS n FROM scope_overlap`),
    db.prepare(`SELECT COUNT(*) AS n FROM structure_node`),
    db.prepare(
      `SELECT node_type, COUNT(*) AS n FROM structure_node
        WHERE node_type IN ('part', 'chapter', 'section') GROUP BY node_type`,
    ),
    // Uses idx_node_unknown, which is partial on `word_count IS NULL` — a scan of only the
    // rows the data-quality page cares about rather than all 275,271.
    db.prepare(`SELECT COUNT(*) AS n FROM structure_node WHERE word_count IS NULL`),
    db.prepare(`SELECT COUNT(*) AS n FROM amendment`),
    // Same trap, same fix, different table. The population is the `title` table — which is what
    // `corpus_titles_unknown` is reported against ("N of {counts.titles} titles") — not the set
    // of titles that happen to have a node in `structure_node`. A title that was never synced
    // has no node at all, and aggregating over `structure_node` alone would omit it from the
    // sum and from the counter simultaneously, publishing a 30-title figure as the corpus while
    // claiming nothing was missing.
    db.prepare(
      // A reserved title (title 35) has no structure JSON at all, so it has no node row and
      // the LEFT JOIN yields NULL — but reserved is a KNOWN zero, not an unknown. Without the
      // reserved carve-out the corpus total is permanently unpublishable, because exactly one
      // title can never have a measured node.
      `SELECT SUM(CASE WHEN t.reserved = 1 THEN COALESCE(n.word_count, 0)
                       ELSE n.word_count END) AS total,
              SUM(CASE WHEN t.reserved = 0 AND n.word_count IS NULL THEN 1 ELSE 0 END) AS unknown
         FROM title t
         LEFT JOIN structure_node n
                ON n.title_number = t.number AND n.node_type = 'title'`,
    ),
    // DRIVEN FROM `agency`, NOT FROM `agency_rollup`. This is the project's founding bug in its
    // most dangerous position — the public API's corpus headline — and the join is the whole fix.
    //
    // `agency_rollup` is keyed by slug and has NO ROW for an agency until a sync computes one.
    // Aggregating over that table alone means an agency with no row contributes nothing to the
    // sum AND increments no unknown counter, so the total comes back short while reporting
    // itself complete. SUM-skips-NULL is the well-known half of this trap; the row set is the
    // half that actually bites, because a missing row is invisible to every counter you can
    // write over the narrowed table. The LEFT JOIN collapses "no row" and "NULL count" into the
    // same NULL, so either one flips the published figure to unknown-with-a-reason.
    db.prepare(
      `SELECT SUM(r.attributed_word_count)   AS attributed,
              SUM(CASE WHEN r.attributed_word_count   IS NULL THEN 1 ELSE 0 END) AS attributed_unknown,
              SUM(r.deduplicated_word_count) AS deduplicated,
              SUM(CASE WHEN r.deduplicated_word_count IS NULL THEN 1 ELSE 0 END) AS deduplicated_unknown
         FROM agency a
         LEFT JOIN agency_rollup r ON r.agency_slug = a.slug`,
    ),
  ]);

  const byType = new Map<string, number>();
  for (const row of rowsOf<NodeTypeRow>(r[6], 'nodes by type')) byType.set(row.node_type, row.n);

  const words = firstOf<SumRow>(r[9], 'title word sum') ?? { total: null, unknown: 0 };
  const roll = firstOf<RollupSumRow>(r[10], 'rollup sums') ?? {
    attributed: null,
    attributed_unknown: 0,
    deduplicated: null,
    deduplicated_unknown: 0,
  };

  return {
    agencies: countOf(r[0], 'agency count'),
    titles: countOf(r[1], 'title count'),
    titles_reserved: countOf(r[2], 'reserved title count'),
    cfr_references: countOf(r[3], 'cfr reference count'),
    shared_scopes: countOf(r[4], 'shared scope count'),
    structure_nodes: countOf(r[5], 'structure node count'),
    parts: byType.get(StructureNodeType.Part) ?? 0,
    chapters: byType.get(StructureNodeType.Chapter) ?? 0,
    sections: byType.get(StructureNodeType.Section) ?? 0,
    amendments: countOf(r[8], 'amendment count'),
    nodes_with_unknown_counts: countOf(r[7], 'unknown node count'),
    // SQLite's SUM ignores NULLs, so a partial sum looks exactly like a complete one. That is
    // the shape of the original bug, so the unknown counter is what decides, not the sum.
    corpus_words: words.unknown > 0 ? null : words.total,
    corpus_titles_unknown: words.unknown,
    attributed_words: roll.attributed_unknown > 0 ? null : roll.attributed,
    attributed_unknown: roll.attributed_unknown,
    deduplicated_words: roll.deduplicated_unknown > 0 ? null : roll.deduplicated,
    deduplicated_unknown: roll.deduplicated_unknown,
  };
}

/** Nodes with no count, grouped by why. The data-quality ledger. */
export async function getUnknownNodeBreakdown(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT word_count_status AS status, COUNT(*) AS n
         FROM structure_node
        WHERE word_count IS NULL
        GROUP BY word_count_status
        ORDER BY n DESC`,
    )
    .all<{ status: string; n: number }>();

  const out: Record<string, number> = {};
  for (const row of results) out[row.status] = row.n;
  return out;
}
