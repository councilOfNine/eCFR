/**
 * SQL emission.
 *
 * Writes go to D1 through `wrangler d1 execute --file`, so this module generates text rather
 * than binding parameters to a driver. That makes literal escaping the entire security
 * boundary of the pipeline: every byte of eCFR's response ends up inside a quoted literal in
 * a file we then execute with full write privileges. It is unit tested in sql.test.ts.
 *
 * Three structural decisions, all forced by how D1 behaves:
 *
 *   1. Output is CHUNKED into numbered segment files. A backfill emits ~275k structure_node
 *      rows; a single .sql file of that size is both slow to apply and, past a point, refused.
 *      Segments cap at a few MB and are applied in emission order.
 *
 *   2. No BEGIN/COMMIT. D1 rejects explicit transaction control over its HTTP API, and
 *      `--file` already applies each segment as one implicit batch. Atomicity across segments
 *      comes from insert-then-prune, not from a transaction.
 *
 *   3. Prunes are held back and emitted separately, after the caller has confirmed the unit
 *      that produced them actually succeeded. See `planPrune`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ─── literals ────────────────────────────────────────────────────────────────

/**
 * Control characters that must not appear raw inside a generated literal.
 *
 * These are legal in a SQLite string literal, but they travel badly: newlines defeat every
 * line-oriented tool anyone will ever point at the generated .sql, and the rest are invisible
 * in a diff. They take the hex-blob path instead. NUL is excluded from this class because it
 * cannot take that path either — see `sanitizeForSqliteText`.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is precisely the point
const NEEDS_HEX_ENCODING = /[\u0001-\u001f\u007f]/;

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The two things a JS string can hold that a SQLite TEXT value cannot.
 *
 * NUL: verified against a real SQLite in sql.test.ts — `CAST(x'610062' AS TEXT)` returns `'a'`,
 * not `'a\0b'`. The cast stops at the first zero byte and silently drops everything after it,
 * which is precisely the quiet-truncation failure this codebase exists to prevent. No encoding
 * preserves it, so the honest options are "visibly substitute" or "refuse" — and refusing would
 * fail a nightly sync over one corrupt byte in one label. U+FFFD it is.
 *
 * Lone surrogates: cannot be encoded to UTF-8 at all. `toWellFormed()` substitutes U+FFFD, which
 * also makes the two escaping paths below agree — otherwise one input could produce two
 * different literals depending on which path it took.
 */
export function sanitizeForSqliteText(value: string): string {
  return value.toWellFormed().replaceAll('\u0000', '\uFFFD');
}

/**
 * Quote a string as a SQLite literal.
 *
 * Two paths. The common one doubles single quotes, which is the whole of SQLite's escaping
 * rule — there is no backslash escape in standard SQLite string literals, so a backslash is an
 * ordinary character and needs no handling. The rare one, for control characters, emits
 * `CAST(x'<utf8 hex>' AS TEXT)`: SQLite reads the blob's bytes in the database encoding (UTF-8)
 * and reproduces them exactly.
 */
export function sqlString(value: string): string {
  const text = sanitizeForSqliteText(value);
  if (NEEDS_HEX_ENCODING.test(text)) {
    return `CAST(x'${Buffer.from(text, 'utf8').toString('hex')}' AS TEXT)`;
  }
  return `'${text.replaceAll("'", "''")}'`;
}

/** An INTEGER column. Rejects anything that would print as `NaN`, `Infinity`, or `1e21`. */
export function sqlInt(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`not a safe integer for a SQLite INTEGER column: ${value}`);
  }
  return String(value);
}

/** A REAL column. `NaN` would emit a bare identifier and either fail or bind to NULL. */
export function sqlReal(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`not a finite number for a SQLite REAL column: ${value}`);
  }
  return String(value);
}

/** SQLite has no boolean type; the schema's CHECK constraints all expect 0/1. */
export function sqlBool(value: boolean): string {
  return value ? '1' : '0';
}

export type SqlValue = string | number | boolean | null | undefined;

/**
 * Dispatch by runtime type. `undefined` and `null` both become NULL — a missing optional
 * field and an explicit null mean the same thing at this boundary, and conflating them here
 * is safer than letting `undefined` stringify to the identifier `undefined`.
 */
export function sqlValue(value: SqlValue): string {
  if (value === null || value === undefined) return 'NULL';
  switch (typeof value) {
    case 'string':
      return sqlString(value);
    case 'boolean':
      return sqlBool(value);
    case 'number':
      return Number.isInteger(value) ? sqlInt(value) : sqlReal(value);
  }
}

/**
 * Table and column names are compiled in, never user data — but this pipeline builds a few
 * predicates by concatenation, and an allow-list is one line of defence that cannot rot.
 */
export function sqlIdent(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`refusing to emit a non-identifier as SQL: ${JSON.stringify(name)}`);
  }
  return name;
}

// ─── table specs ─────────────────────────────────────────────────────────────

export interface TableSpec {
  readonly name: string;
  readonly columns: readonly string[];
  /**
   * Conflict target. Must name a real UNIQUE constraint or PRIMARY KEY, otherwise SQLite
   * raises "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint" at apply
   * time rather than emission time.
   */
  readonly conflict: readonly string[];
  /** Columns updated on conflict. Defaults to every non-conflict column. */
  readonly update?: readonly string[];
}

export type Row = Readonly<Record<string, SqlValue>>;

/**
 * Rows per INSERT statement.
 *
 * SQLite compiles a multi-row VALUES list as a compound SELECT, historically capped at
 * SQLITE_MAX_COMPOUND_SELECT (500). 200 leaves headroom under any build D1 might be running
 * and still gets a 275k-row backfill down to ~1,400 statements.
 */
const DEFAULT_ROWS_PER_STATEMENT = 200;

/** Segment file cap. Small enough to apply quickly, large enough not to make thousands. */
const DEFAULT_BYTES_PER_FILE = 4 * 1024 * 1024;

export function buildUpsert(spec: TableSpec, rows: readonly Row[]): string {
  if (rows.length === 0) return '';
  const columns = spec.columns.map(sqlIdent);
  const conflict = spec.conflict.map(sqlIdent);
  const updateColumns = (spec.update ?? spec.columns.filter((c) => !spec.conflict.includes(c))).map(
    sqlIdent,
  );

  const values = rows
    .map((row) => `  (${columns.map((column) => sqlValue(row[column])).join(', ')})`)
    .join(',\n');

  // DO NOTHING rather than an empty SET when every column is part of the key: SQLite rejects
  // `DO UPDATE SET` with no assignments.
  const action =
    updateColumns.length === 0
      ? 'DO NOTHING'
      : `DO UPDATE SET ${updateColumns.map((c) => `${c} = excluded.${c}`).join(', ')}`;

  return `INSERT INTO ${sqlIdent(spec.name)} (${columns.join(', ')}) VALUES\n${values}\nON CONFLICT (${conflict.join(', ')}) ${action};`;
}

// ─── insert-then-prune ───────────────────────────────────────────────────────

export interface PruneSpec {
  readonly table: string;
  /**
   * Scope predicate, REQUIRED and code-built.
   *
   * An unscoped `DELETE ... WHERE last_seen_run_id < :run` is correct only when the run
   * touched every row in the table. A nightly delta touches a handful of titles, so an
   * unscoped prune would delete the other 45 titles' worth of nodes — every row whose
   * last_seen_run_id is legitimately older. Pass `TRUE` explicitly to opt into a global
   * prune; there is no default.
   */
  readonly where: string;
}

/**
 * Delete order. Children before parents so a prune cannot trip a foreign key, regardless of
 * whether D1 has FK enforcement on for this connection (ON DELETE CASCADE only fires when it
 * does, so relying on the cascade would be relying on a setting we do not control).
 *
 * `agency_snapshot` and `title_watermark` are deliberately absent: neither carries
 * `last_seen_run_id`, because neither is a projection of the current corpus. A snapshot is a
 * historical fact that must survive every future run, and a watermark is per-title state that
 * a run updates rather than re-derives.
 */
const PRUNE_ORDER: readonly string[] = [
  'agency_rollup',
  'scope_overlap',
  'agency_cfr_reference',
  'amendment',
  'structure_node',
  'agency',
  'title',
];

function pruneRank(table: string): number {
  const index = PRUNE_ORDER.indexOf(table);
  return index === -1 ? PRUNE_ORDER.length : index;
}

export function buildPrune(spec: PruneSpec, runId: number): string {
  return `DELETE FROM ${sqlIdent(spec.table)} WHERE (${spec.where}) AND last_seen_run_id < ${sqlInt(runId)};`;
}

/** The count a prune WOULD delete. Run before the prune so `nodes_pruned` is measured. */
export function buildPruneCount(spec: PruneSpec, runId: number): string {
  return `SELECT COUNT(*) AS n FROM ${sqlIdent(spec.table)} WHERE (${spec.where}) AND last_seen_run_id < ${sqlInt(runId)};`;
}

// ─── writer ──────────────────────────────────────────────────────────────────

export interface SqlWriterOptions {
  readonly outDir: string;
  readonly runId: number;
  readonly rowsPerStatement?: number;
  readonly bytesPerFile?: number;
}

export interface SqlBundle {
  /** Upserts and touches, in emission order. Apply these first. */
  readonly dataFiles: readonly string[];
  /** Prunes for committed units only. Apply last, after counting. */
  readonly pruneFile: string | null;
  readonly prunes: readonly PruneSpec[];
  readonly statements: number;
  readonly rowsUpserted: number;
  /** Units whose prunes were withheld because the unit did not commit. */
  readonly withheldUnits: readonly string[];
}

/**
 * Accumulates statements, splits them across segment files, and enforces the
 * insert-then-prune discipline: a prune is only ever written for a unit that called
 * `commitUnit`. A crashed or failed unit therefore leaves a superset of the truth in D1 —
 * stale rows, never missing ones — which is the failure mode the schema was designed around.
 */
export class SqlWriter {
  readonly runId: number;
  #outDir: string;
  #rowsPerStatement: number;
  #bytesPerFile: number;

  #buffer: string[] = [];
  #bufferBytes = 0;
  #files: string[] = [];

  #statements = 0;
  #rowsUpserted = 0;

  /** unit id -> prunes to emit iff the unit commits. */
  #plannedPrunes = new Map<string, PruneSpec[]>();
  #committed = new Set<string>();

  constructor(options: SqlWriterOptions) {
    this.runId = options.runId;
    this.#outDir = options.outDir;
    this.#rowsPerStatement = options.rowsPerStatement ?? DEFAULT_ROWS_PER_STATEMENT;
    this.#bytesPerFile = options.bytesPerFile ?? DEFAULT_BYTES_PER_FILE;
  }

  /** Append a complete statement. Caller owns the trailing semicolon. */
  statement(sql: string): void {
    if (sql.trim() === '') return;
    this.#buffer.push(sql);
    this.#bufferBytes += Buffer.byteLength(sql, 'utf8') + 1;
    this.#statements += 1;
  }

  /** Chunked upsert. Returns the row count emitted. */
  upsert(spec: TableSpec, rows: readonly Row[]): number {
    for (let i = 0; i < rows.length; i += this.#rowsPerStatement) {
      this.statement(buildUpsert(spec, rows.slice(i, i + this.#rowsPerStatement)));
    }
    this.#rowsUpserted += rows.length;
    return rows.length;
  }

  /*
   * There is deliberately no `touch(table, where)` helper that bulk-bumps last_seen_run_id.
   *
   * It is the obvious way to protect rows a run verified but did not rewrite, and it is a
   * trap: a blanket bump also revives every row that has legitimately left the source, and
   * revives it permanently, because it then survives all future prunes too. The correct
   * discipline is to upsert every row that still exists — which the pipeline does, even for a
   * delta that only refetched some of them — and let the scoped prune take the rest.
   */

  /** Register a prune to be emitted only if `commitUnit(unit)` is later called. */
  planPrune(unit: string, spec: PruneSpec): void {
    const existing = this.#plannedPrunes.get(unit);
    if (existing) existing.push(spec);
    else this.#plannedPrunes.set(unit, [spec]);
  }

  /** The unit wrote everything it intended to. Its prunes become eligible. */
  commitUnit(unit: string): void {
    this.#committed.add(unit);
  }

  get statementCount(): number {
    return this.#statements;
  }

  get rowCount(): number {
    return this.#rowsUpserted;
  }

  async #flush(label: string): Promise<void> {
    if (this.#buffer.length === 0) return;
    const index = String(this.#files.length + 1).padStart(4, '0');
    const path = join(this.#outDir, `${index}-${label}.sql`);
    const header = `-- ecfr-atlas sync run ${this.runId} · segment ${index} · ${label}\n-- generated ${new Date().toISOString()}\n\n`;
    await writeFile(path, `${header + this.#buffer.join('\n')}\n`, 'utf8');
    this.#files.push(path);
    this.#buffer = [];
    this.#bufferBytes = 0;
  }

  /**
   * Close the current segment if it has grown past the cap. Call between logical units; the
   * writer never splits mid-statement.
   */
  async rotateIfLarge(label: string): Promise<void> {
    if (this.#bufferBytes >= this.#bytesPerFile) await this.#flush(label);
  }

  async finish(label = 'data'): Promise<SqlBundle> {
    await mkdir(this.#outDir, { recursive: true });
    await this.#flush(label);

    const eligible: PruneSpec[] = [];
    const withheld: string[] = [];
    for (const [unit, specs] of this.#plannedPrunes) {
      if (this.#committed.has(unit)) eligible.push(...specs);
      else withheld.push(unit);
    }
    eligible.sort((a, b) => pruneRank(a.table) - pruneRank(b.table));

    let pruneFile: string | null = null;
    if (eligible.length > 0) {
      pruneFile = join(this.#outDir, '9999-prune.sql');
      const body = eligible.map((spec) => buildPrune(spec, this.runId)).join('\n');
      await writeFile(
        pruneFile,
        `-- ecfr-atlas sync run ${this.runId} · prune\n-- ${eligible.length} scoped deletes; ${withheld.length} unit(s) withheld\n\n${body}\n`,
        'utf8',
      );
    }

    return {
      dataFiles: this.#files,
      pruneFile,
      prunes: eligible,
      statements: this.#statements,
      rowsUpserted: this.#rowsUpserted,
      withheldUnits: withheld,
    };
  }
}

// ─── the tables this pipeline writes ─────────────────────────────────────────

export const TITLE: TableSpec = {
  name: 'title',
  columns: [
    'number',
    'name',
    'latest_amended_on',
    'latest_issue_date',
    'up_to_date_as_of',
    'reserved',
    'last_seen_run_id',
  ],
  conflict: ['number'],
};

export const AGENCY: TableSpec = {
  name: 'agency',
  columns: [
    'slug',
    'name',
    'short_name',
    'display_name',
    'sortable_name',
    'parent_slug',
    'depth',
    'last_seen_run_id',
  ],
  conflict: ['slug'],
};

export const STRUCTURE_NODE: TableSpec = {
  name: 'structure_node',
  columns: [
    'citation',
    'parent_citation',
    'title_number',
    'node_type',
    'identifier',
    'label',
    'reserved',
    'subtitle_id',
    'chapter_id',
    'subchapter_id',
    'part_id',
    'xml_bytes',
    'content_key',
    'word_count',
    'word_count_status',
    'word_count_method',
    'word_count_reason',
    'word_count_run_id',
    'last_seen_run_id',
  ],
  conflict: ['citation'],
  // `content_key` is deliberately NOT updated by the upsert. The schema promises that a
  // non-null value always resolves to a real R2 object, and an upsert runs before the PUT.
  // It is set by a targeted UPDATE after a verified write, and a nightly delta that does not
  // re-render an unchanged part must leave the existing pointer alone.
  update: [
    'parent_citation',
    'title_number',
    'node_type',
    'identifier',
    'label',
    'reserved',
    'subtitle_id',
    'chapter_id',
    'subchapter_id',
    'part_id',
    'xml_bytes',
    'word_count',
    'word_count_status',
    'word_count_method',
    'word_count_reason',
    'word_count_run_id',
    'last_seen_run_id',
  ],
};

export const AGENCY_CFR_REFERENCE: TableSpec = {
  name: 'agency_cfr_reference',
  columns: [
    'agency_slug',
    'ref_key',
    'title_number',
    'narrowest_level',
    'subtitle_id',
    'chapter_id',
    'subchapter_id',
    'part_id',
    'node_citation',
    'last_seen_run_id',
  ],
  conflict: ['agency_slug', 'ref_key'],
};

export const SCOPE_OVERLAP: TableSpec = {
  name: 'scope_overlap',
  columns: [
    'ref_key',
    'title_number',
    'agency_count',
    'agency_slugs',
    'word_count',
    'last_seen_run_id',
  ],
  conflict: ['ref_key'],
};

export const AGENCY_ROLLUP: TableSpec = {
  name: 'agency_rollup',
  columns: [
    'agency_slug',
    'attributed_word_count',
    'deduplicated_word_count',
    'subtree_attributed',
    'subtree_deduplicated',
    'refs_total',
    'refs_counted',
    'shared_refs',
    'children_count',
    'coverage_pct',
    'last_seen_run_id',
  ],
  conflict: ['agency_slug'],
};

export const AGENCY_SNAPSHOT: TableSpec = {
  name: 'agency_snapshot',
  columns: [
    'agency_slug',
    'snapshot_date',
    'run_id',
    'attributed_word_count',
    'deduplicated_word_count',
    'coverage_pct',
  ],
  conflict: ['agency_slug', 'snapshot_date'],
};

export const AMENDMENT: TableSpec = {
  name: 'amendment',
  columns: [
    'title_number',
    'section_identifier',
    'amendment_date',
    'issue_date',
    'part',
    'subpart',
    'name',
    'removed',
    'substantive',
    'last_seen_run_id',
  ],
  conflict: ['title_number', 'section_identifier', 'amendment_date', 'issue_date'],
};

export const TITLE_WATERMARK: TableSpec = {
  name: 'title_watermark',
  columns: [
    'title_number',
    'latest_amended_on',
    'latest_issue_date',
    'last_synced_at',
    'last_synced_run_id',
  ],
  conflict: ['title_number'],
};
