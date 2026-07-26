/**
 * Resumable state in `.sync-cache/`.
 *
 * A backfill is ~5.5 minutes of transfer plus parse time across 49 titles, and two of the
 * measured failure modes are not the pipeline's fault: eCFR returns a 162-byte 429 with no
 * Retry-After under load, and a 246-byte 504 when the origin's XML generation times out on a
 * large title — isolated sequential fetches of title 49 failed 2 of 4 times. A crash on title
 * 47 must not throw away titles 1 through 46.
 *
 * Two distinct things are cached:
 *
 *   TitleCheckpoint — "this title is done for this source date", with the SQL segments it
 *   produced. A resumed run skips it.
 *
 *   NodeStore — every node and its measurement, per title. The rollup needs the measurement
 *   of ANY node a scope might name (a chapter, a subchapter), not just the ones this run
 *   touched. Keeping it on disk means the nightly delta does not have to read 275,271 rows
 *   back out of D1 through wrangler's JSON output just to add up 487 references. When a
 *   title's cache file is missing the store falls back to D1, so a cold runner is correct,
 *   just slower.
 *
 * The fingerprint is a hash of the structure JSON, not the source date. Two runs on the same
 * date must reuse the checkpoint; a run after eCFR republishes the same date with different
 * content must not.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Measurement, MeasurementRow } from '@ecfr-atlas/core';
import { fromRow, toRow, WordCountStatus } from '@ecfr-atlas/core';

import type { D1 } from './d1.js';
import type { Logger } from './log.js';
import { sqlInt, sqlString } from './sql.js';
import type { FlatNode } from './structure.js';

export function fingerprint(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

// ─── per-title checkpoint ────────────────────────────────────────────────────

export interface TitleCheckpoint {
  titleNumber: number;
  sourceDate: string;
  structureFingerprint: string;
  nodeCount: number;
  leavesMeasured: number;
  fetchFailures: number;
  parseFailures: number;
  sqlFiles: string[];
  completedAt: string;
}

export class CheckpointStore {
  #dir: string;
  #log: Logger;

  constructor(cacheDir: string, log: Logger) {
    this.#dir = join(cacheDir, 'checkpoints');
    this.#log = log.child('checkpoint');
  }

  async init(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
  }

  #path(titleNumber: number): string {
    return join(this.#dir, `title-${titleNumber}.json`);
  }

  async read(titleNumber: number): Promise<TitleCheckpoint | null> {
    const path = this.#path(titleNumber);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(await readFile(path, 'utf8')) as TitleCheckpoint;
    } catch {
      // A truncated checkpoint from a hard kill is worth exactly nothing; redo the title.
      this.#log.warn('discarding unreadable checkpoint', { titleNumber });
      return null;
    }
  }

  /** True when the title can be skipped: same source date AND same structure content. */
  async isComplete(
    titleNumber: number,
    sourceDate: string,
    structureFingerprint: string,
  ): Promise<TitleCheckpoint | null> {
    const checkpoint = await this.read(titleNumber);
    if (!checkpoint) return null;
    if (checkpoint.sourceDate !== sourceDate) return null;
    if (checkpoint.structureFingerprint !== structureFingerprint) return null;
    return checkpoint;
  }

  async write(checkpoint: TitleCheckpoint): Promise<void> {
    await writeFile(this.#path(checkpoint.titleNumber), JSON.stringify(checkpoint), 'utf8');
  }

  async clear(): Promise<void> {
    await rm(this.#dir, { recursive: true, force: true });
    await mkdir(this.#dir, { recursive: true });
  }
}

// ─── node store ──────────────────────────────────────────────────────────────

/**
 * Tuple form, not objects.
 *
 * 275,271 nodes as `{citation: ..., nodeType: ...}` JSON is several hundred MB of repeated
 * key names. Positional arrays cut it by roughly two thirds, and this file is written once
 * and read once per run — legibility is worth less here than the I/O.
 */
type NodeTuple = [
  citation: string,
  parentCitation: string | null,
  nodeType: string,
  identifier: string | null,
  label: string,
  reserved: 0 | 1,
  subtitleId: string | null,
  chapterId: string | null,
  subchapterId: string | null,
  partId: string | null,
  xmlBytes: number | null,
  wordCount: number | null,
  status: WordCountStatus,
  method: string | null,
  reason: string | null,
];

interface TitleNodeFile {
  titleNumber: number;
  sourceDate: string;
  nodes: NodeTuple[];
}

export interface StoredNode {
  node: FlatNode;
  measurement: Measurement;
}

function toTuple(node: FlatNode, measurement: Measurement): NodeTuple {
  const row: MeasurementRow = toRow(measurement);
  return [
    node.citation,
    node.parentCitation,
    node.nodeType,
    node.identifier,
    node.label,
    node.reserved ? 1 : 0,
    node.subtitleId,
    node.chapterId,
    node.subchapterId,
    node.partId,
    node.xmlBytes,
    row.word_count,
    row.word_count_status,
    row.word_count_method,
    row.word_count_reason,
  ];
}

function fromTuple(tuple: NodeTuple, titleNumber: number): StoredNode {
  const [
    citation,
    parentCitation,
    nodeType,
    identifier,
    label,
    reserved,
    subtitleId,
    chapterId,
    subchapterId,
    partId,
    xmlBytes,
    wordCount,
    status,
    method,
    reason,
  ] = tuple;

  return {
    node: {
      citation,
      parentCitation,
      titleNumber,
      nodeType,
      identifier,
      label,
      reserved: reserved === 1,
      subtitleId,
      chapterId,
      subchapterId,
      partId,
      xmlBytes,
      depth: citation.split('/').length - 1,
      // Child links are not persisted: the rollup already happened, and the resolver only
      // needs to look nodes up. Rebuilding them from parentCitation is one pass if ever needed.
      childCitations: [],
    },
    measurement: fromRow({
      word_count: wordCount,
      word_count_status: status,
      word_count_method: method as MeasurementRow['word_count_method'],
      word_count_reason: reason,
    }),
  };
}

/** Shape of a `structure_node` row as it comes back from `wrangler d1 execute --json`. */
interface NodeRow {
  citation: string;
  parent_citation: string | null;
  node_type: string;
  identifier: string | null;
  label: string | null;
  reserved: number;
  subtitle_id: string | null;
  chapter_id: string | null;
  subchapter_id: string | null;
  part_id: string | null;
  xml_bytes: number | null;
  word_count: number | null;
  word_count_status: string;
  word_count_method: string | null;
  word_count_reason: string | null;
}

export class NodeStore {
  #dir: string;
  #log: Logger;
  #d1: D1;

  constructor(cacheDir: string, d1: D1, log: Logger) {
    this.#dir = join(cacheDir, 'nodes');
    this.#d1 = d1;
    this.#log = log.child('nodes');
  }

  async init(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
  }

  #path(titleNumber: number): string {
    return join(this.#dir, `title-${titleNumber}.json`);
  }

  async save(
    titleNumber: number,
    sourceDate: string,
    nodes: readonly FlatNode[],
    measurements: ReadonlyMap<string, Measurement>,
  ): Promise<void> {
    const file: TitleNodeFile = {
      titleNumber,
      sourceDate,
      nodes: nodes.map((node) =>
        toTuple(
          node,
          measurements.get(node.citation) ?? {
            known: false,
            words: null,
            status: WordCountStatus.NotComputed,
            reason: 'no measurement produced for this node',
          },
        ),
      ),
    };
    await writeFile(this.#path(titleNumber), JSON.stringify(file), 'utf8');
  }

  async loadLocal(titleNumber: number): Promise<StoredNode[] | null> {
    const path = this.#path(titleNumber);
    if (!existsSync(path)) return null;
    try {
      const file = JSON.parse(await readFile(path, 'utf8')) as TitleNodeFile;
      return file.nodes.map((tuple) => fromTuple(tuple, titleNumber));
    } catch {
      this.#log.warn('discarding unreadable node cache', { titleNumber });
      return null;
    }
  }

  /**
   * Read a title's nodes back out of D1.
   *
   * Paged, because a title's node count runs to tens of thousands and wrangler materialises
   * the whole result set as JSON on stdout. Keyed on `citation` rather than `id` so the page
   * boundaries are stable even if a concurrent write reorders rowids.
   */
  async loadFromD1(titleNumber: number): Promise<StoredNode[]> {
    const pageSize = 10_000;
    const out: StoredNode[] = [];
    let after = '';

    for (;;) {
      // Every literal goes through sql.ts. A citation is corpus-derived text and there is
      // exactly one audited escaper in this codebase; a second, weaker one here — even a
      // correct-looking `replaceAll("'", "''")` — is how an injection bug survives review,
      // because the reviewer checks the escaper that is under test and never sees this one.
      const predicate = after === '' ? '' : ` AND citation > ${sqlString(after)}`;
      const rows = await this.#d1.query<NodeRow>(
        `SELECT citation, parent_citation, node_type, identifier, label, reserved,
                subtitle_id, chapter_id, subchapter_id, part_id, xml_bytes,
                word_count, word_count_status, word_count_method, word_count_reason
         FROM structure_node
         WHERE title_number = ${sqlInt(titleNumber)}${predicate}
         ORDER BY citation
         LIMIT ${sqlInt(pageSize)};`,
        `nodes:title-${titleNumber}`,
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        out.push(
          fromTuple(
            [
              row.citation,
              row.parent_citation,
              row.node_type,
              row.identifier,
              row.label ?? '',
              row.reserved === 1 ? 1 : 0,
              row.subtitle_id,
              row.chapter_id,
              row.subchapter_id,
              row.part_id,
              row.xml_bytes,
              row.word_count,
              row.word_count_status as WordCountStatus,
              row.word_count_method,
              row.word_count_reason,
            ],
            titleNumber,
          ),
        );
      }

      const last = rows[rows.length - 1];
      if (!last || rows.length < pageSize) break;
      after = last.citation;
    }

    return out;
  }

  /** Local cache if present, D1 otherwise. */
  async load(titleNumber: number): Promise<StoredNode[]> {
    const local = await this.loadLocal(titleNumber);
    if (local) return local;
    this.#log.info('node cache miss; reading from D1', { titleNumber });
    return this.loadFromD1(titleNumber);
  }

  async loadMany(titleNumbers: readonly number[]): Promise<StoredNode[]> {
    const out: StoredNode[] = [];
    for (const titleNumber of titleNumbers) out.push(...(await this.load(titleNumber)));
    return out;
  }
}
