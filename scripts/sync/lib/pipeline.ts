/**
 * Orchestration shared by `backfill.ts` and `delta.ts`.
 *
 * The two entry points differ only in which titles they process and how they decide. Every
 * stage after that — agencies, rollups, render, gate, apply — is identical, and keeping it
 * identical is deliberate: a nightly delta that computed totals differently from a backfill
 * would produce a step change in the time series every time someone re-ran a full pull.
 *
 * Ordering is fixed by foreign keys and by the insert-then-prune rule:
 *
 *   title -> agency -> structure_node -> agency_cfr_reference / rollups -> prune
 *
 * GATE FIRST, THEN WRITE. This is the load-bearing property of the whole file.
 *
 * A run generates SQL to disk as it goes and applies NOTHING until the publish gate has
 * accepted it. Two things were wrong before and both were fatal to the gate's purpose:
 *
 *   1. Every rollup and prune was applied before the gate ran, so a REFUSED run had already
 *      replaced the served data. Refusal withheld only the `app_meta` pointer bump — the rows
 *      underneath were gone. A gate that cannot stop the write is decoration.
 *
 *   2. The baseline the gate compared against was read from D1 AFTER the run's own writes
 *      landed, so `previous` was the current run. Four of the six checks were comparing the
 *      run to itself and could never fire.
 *
 * So: the baseline is read once, first, before anything this run does touches D1; the gate is
 * evaluated from the run's IN-MEMORY output against that baseline; and only an accepted run
 * applies its generated segments, prunes, advances `published_run_id`, and promotes its
 * rendered HTML into the snapshot the site is built from. A refused run leaves the previously
 * published data byte-for-byte intact, which is the only thing "refused" can honestly mean.
 *
 * A title is still the unit of both work and recovery. Its SQL is written to disk and its
 * checkpoint recorded before the next title starts, and the checkpoint carries the list of
 * segments it produced — so a resumed run re-queues a skipped title's segments rather than
 * assuming they are already in D1. That is what lets the apply move to the end without a crash
 * silently dropping the titles that finished before it.
 */

import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Measurement } from '@ecfr-atlas/core';
import { toRow, WordCountStatus } from '@ecfr-atlas/core';
import type { Agency, ContentVersion, Title } from '@ecfr-atlas/core/ecfr-schemas';

import { CheckpointStore, fingerprint, NodeStore } from './checkpoint.js';
import type { SyncConfig } from './config.js';
import { D1 } from './d1.js';
import type { TitleWatermark } from './delta.js';
import {
  diffStructureSizes,
  ImportInProgressError,
  planRefetch,
  planTitleDelta,
  summariseVersions,
  versionsWindowStart,
} from './delta.js';
import type { EcfrClientLike, EcfrModule } from './ecfr-adapter.js';
import { installSharedRateGovernor, loadEcfr } from './ecfr-adapter.js';
import { RunKind, TitleStatus } from './enums.js';
import type { Logger } from './log.js';
import { createLogger } from './log.js';
import {
  APPLY_HALTED,
  BASELINE_UNREADABLE,
  CHECKPOINT_MATCH,
  CHECKPOINT_SEGMENTS_MISSING,
  GATE_REFUSED_DISCARDING,
  PARTIAL_APPLY_REFUSAL,
  RUN_PUBLISHED,
  RUN_REFUSED_BY_GATE,
} from './messages.js';
import { processTitleXml } from './process-title.js';
import type { GateStats } from './publish-gate.js';
import { evaluatePublishGate } from './publish-gate.js';
import type { ObjectSink } from './r2.js';
import { NullObjectSink, R2Client } from './r2.js';
import type { RenderUnit } from './render.js';
import { buildManifest, planRender, writeManifest } from './render.js';
import type { AgencyInput } from './rollup.js';
import { buildSnapshots, computeRollups, createScopeResolver } from './rollup.js';
import { SyncRun } from './run.js';
import { ContentStaging, readAmendmentIndex, writeSnapshot } from './snapshot.js';
import type { Row } from './sql.js';
import {
  AGENCY,
  AGENCY_CFR_REFERENCE,
  AGENCY_ROLLUP,
  AGENCY_SNAPSHOT,
  AMENDMENT,
  buildPruneCount,
  SCOPE_OVERLAP,
  SqlWriter,
  STRUCTURE_NODE,
  sqlInt,
  sqlString,
  TITLE,
  TITLE_WATERMARK,
} from './sql.js';
import type { FlatNode } from './structure.js';
import {
  containersOf,
  flattenStructure,
  indexByCitation,
  leavesOf,
  rollUpTree,
} from './structure.js';
import { fetchAllVersions } from './versions.js';

/** Pages Astro emits that are not derived from the corpus. Counted against the file budget. */
const STATIC_PAGE_COUNT = 8;

export interface PipelineContext {
  config: SyncConfig;
  log: Logger;
  d1: D1;
  ecfr: EcfrModule;
  client: EcfrClientLike;
  sink: ObjectSink;
  checkpoints: CheckpointStore;
  nodes: NodeStore;
  /**
   * Rendered HTML for this run, held outside the published snapshot until the gate accepts it.
   * Null until a run opens, because it is keyed on the run id.
   */
  staging: ContentStaging | null;
}

export async function createContext(config: SyncConfig): Promise<PipelineContext> {
  const log = createLogger('sync');
  const d1 = new D1(config, log);
  const ecfr = await loadEcfr();

  // The rate ceiling is set on the SHARED governor, before any client exists, so every request
  // this process makes draws on one bucket. eCFR's limiter is a token bucket rather than a
  // concurrency gate: two clients each "limited" to 8 req/s would really be running at 16 and
  // both would look correctly configured. `ECFR_MAX_RPS` is therefore a process setting, and
  // the effective rate is logged because a value that was accepted and then ignored is worse
  // than one that was never set.
  const effectiveRate = installSharedRateGovernor(ecfr, config.maxRps, log);
  log.info('request pacing', {
    configured: config.maxRps,
    effective: effectiveRate ?? 'package default',
  });
  const client = new ecfr.EcfrClient({ userAgent: config.userAgent });

  let sink: ObjectSink;
  if (config.r2) {
    sink = new R2Client(config.r2, log);
  } else {
    log.warn('no R2 credentials; rendering will plan and measure but not upload');
    sink = new NullObjectSink();
  }

  const checkpoints = new CheckpointStore(config.cacheDir, log);
  const nodes = new NodeStore(config.cacheDir, d1, log);
  await checkpoints.init();
  await nodes.init();
  await mkdir(config.outDir, { recursive: true });

  return { config, log, d1, ecfr, client, sink, checkpoints, nodes, staging: null };
}

// ─── deferred application ────────────────────────────────────────────────────

/**
 * Every generated segment this run intends to apply, in emission order.
 *
 * Nothing here reaches D1 until the publish gate says so. Grouping by unit — a title, the
 * metadata bundle, the rollup — is what lets a mid-apply failure name the title it broke, so
 * `partial_titles` still catches the one failure aggregates cannot see.
 */
export class ApplyQueue {
  #groups: Array<{ unit: string; titleNumber: number | null; files: readonly string[] }> = [];

  add(unit: string, files: readonly string[], titleNumber: number | null = null): void {
    if (files.length === 0) return;
    this.#groups.push({ unit, titleNumber, files });
  }

  get fileCount(): number {
    return this.#groups.reduce((sum, group) => sum + group.files.length, 0);
  }

  /**
   * Apply everything, in order, stopping at the first failure.
   *
   * A group that fails part-way leaves that title's rows a mixture of two runs, which is
   * exactly the `partial` outcome the gate blocks on — recorded here so the caller can refuse
   * to advance the published pointer even though the gate itself already passed.
   */
  async applyAll(ctx: PipelineContext, run: SyncRun, log: Logger): Promise<boolean> {
    for (const group of this.#groups) {
      try {
        await ctx.d1.applyFiles(group.files);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.error(APPLY_HALTED, {
          unit: group.unit,
          reason,
        });
        if (group.titleNumber !== null) run.markPartial(group.titleNumber, reason);
        return false;
      }
    }
    return true;
  }
}

// ─── reference data ──────────────────────────────────────────────────────────

/**
 * Flatten eCFR's nested agency tree.
 *
 * Nesting is one level deep today; the schema is recursive because "today" is not a
 * guarantee. Duplicate slugs would silently collapse two agencies into one row, so they are
 * detected and reported rather than deduplicated away.
 */
export function flattenAgencies(agencies: readonly Agency[], log: Logger): AgencyInput[] {
  const out: AgencyInput[] = [];
  const seen = new Set<string>();

  const visit = (agency: Agency, parentSlug: string | null, depth: number): void => {
    if (seen.has(agency.slug)) {
      log.warn('duplicate agency slug in eCFR response', { slug: agency.slug, parentSlug });
      return;
    }
    seen.add(agency.slug);
    out.push({
      slug: agency.slug,
      displayName: agency.display_name,
      sortableName: agency.sortable_name,
      parentSlug,
      depth,
      references: agency.cfr_references,
    });
    for (const child of agency.children ?? []) visit(child, agency.slug, depth + 1);
  };

  for (const agency of agencies) visit(agency, null, 0);
  return out;
}

function titleRows(titles: readonly Title[], runId: number): Row[] {
  return titles.map((title) => ({
    number: title.number,
    name: title.name,
    // Null on title 35 and on any future reserved title. Passed through as NULL rather than
    // coerced to a date, because "reserved" and "not yet amended" are different facts.
    latest_amended_on: title.latest_amended_on,
    latest_issue_date: title.latest_issue_date,
    up_to_date_as_of: title.up_to_date_as_of,
    reserved: title.reserved,
    last_seen_run_id: runId,
  }));
}

function agencyRows(
  agencies: readonly AgencyInput[],
  raw: readonly Agency[],
  runId: number,
): Row[] {
  const byName = new Map<string, Agency>();
  const collect = (list: readonly Agency[]): void => {
    for (const agency of list) {
      byName.set(agency.slug, agency);
      collect(agency.children ?? []);
    }
  };
  collect(raw);

  return agencies.map((agency) => {
    const source = byName.get(agency.slug);
    return {
      slug: agency.slug,
      name: source?.name ?? agency.displayName,
      short_name: source?.short_name ?? null,
      display_name: agency.displayName,
      sortable_name: agency.sortableName,
      parent_slug: agency.parentSlug,
      depth: agency.depth,
      last_seen_run_id: runId,
    };
  });
}

function nodeRows(
  nodes: readonly FlatNode[],
  measurements: ReadonlyMap<string, Measurement>,
  runId: number,
): Row[] {
  return nodes.map((node) => {
    const measurement = measurements.get(node.citation);
    const row = measurement
      ? toRow(measurement)
      : toRow({
          known: false,
          words: null,
          status: WordCountStatus.NotComputed,
          reason: 'no measurement produced for this node',
        });
    return {
      citation: node.citation,
      parent_citation: node.parentCitation,
      title_number: node.titleNumber,
      node_type: node.nodeType,
      identifier: node.identifier,
      label: node.label,
      reserved: node.reserved,
      subtitle_id: node.subtitleId,
      chapter_id: node.chapterId,
      subchapter_id: node.subchapterId,
      part_id: node.partId,
      xml_bytes: node.xmlBytes,
      // Never written by the upsert. See the note on STRUCTURE_NODE.update.
      content_key: null,
      word_count: row.word_count,
      word_count_status: row.word_count_status,
      word_count_method: row.word_count_method,
      word_count_reason: row.word_count_reason,
      word_count_run_id: runId,
      last_seen_run_id: runId,
    };
  });
}

function amendmentRows(
  titleNumber: number,
  versions: readonly ContentVersion[],
  runId: number,
): Row[] {
  return versions.map((version) => ({
    title_number: titleNumber,
    section_identifier: version.identifier,
    amendment_date: version.amendment_date,
    // Part of the primary key. (title, section, amendment_date) alone collides 1,619 times in
    // title 21 — issue_date is what makes the row unique.
    issue_date: version.issue_date,
    part: version.part ?? null,
    subpart: version.subpart ?? null,
    name: version.name,
    removed: version.removed,
    substantive: version.substantive,
    last_seen_run_id: runId,
  }));
}

// ─── per-title work ──────────────────────────────────────────────────────────

interface TitleWork {
  nodes: FlatNode[];
  measurements: Map<string, Measurement>;
  units: RenderUnit[];
  /** Verified R2 writes. Emitted by `stageTitle` AFTER the node upsert, never before. */
  contentKeys: Array<{ citation: string; contentKey: string }>;
  parseFailures: number;
  fetchFailures: number;
}

/**
 * Upload one rendered unit, stage its HTML for the snapshot, and record where it landed.
 *
 * The key is recorded against the FIRST node of the unit: for an unsplit part that is the
 * part itself, for a split part it is the subpart or section the piece begins at. Either way
 * the pointer resolves to the exact object containing that node, which is what the schema
 * promises.
 *
 * Recorded, not emitted. The UPDATE has to run after the row exists, and it must only run for
 * a PUT that actually returned — `content_key` is excluded from the upsert precisely so that
 * a non-null value can never outrun the object it points at.
 *
 * The same bytes go to two places for two different consumers: R2 serves the API's
 * `content.url`, and the staged copy becomes `content/<key>.html` in the snapshot the Astro
 * build reads. Staged rather than written directly, because a run the gate refuses must not
 * replace the text the published snapshot is currently serving.
 */
async function uploadUnit(
  ctx: PipelineContext,
  contentKeys: TitleWork['contentKeys'],
  unit: RenderUnit,
  html: string,
): Promise<void> {
  await ctx.sink.put(unit.contentKey, html, 'text/html; charset=utf-8');
  await ctx.staging?.write(unit.contentKey, html);
  contentKeys.push({
    citation: unit.citations[0] ?? unit.partCitation,
    contentKey: unit.contentKey,
  });
}

/** Backfill: the whole title in one XML fetch. */
async function processWholeTitle(
  ctx: PipelineContext,
  titleNumber: number,
  sourceDate: string,
  nodes: FlatNode[],
): Promise<TitleWork> {
  const byCitation = indexByCitation(nodes);
  const plan = planRender(nodes);
  const leafMeasurements = new Map<string, Measurement>();
  const ownText = new Map<string, Measurement>();
  const contentKeys: TitleWork['contentKeys'] = [];

  let xml: string;
  try {
    xml = await ctx.client.fetchTitleXml(titleNumber, sourceDate);
  } catch (error) {
    // The client owns retry and backoff; reaching here means the budget was spent. 429s come
    // back in ~0.13s with no Retry-After, 504s after ~50s when origin XML generation times
    // out on a large title — either way the honest record is that every leaf is unknown.
    const reason = `title ${titleNumber} XML fetch failed: ${error instanceof Error ? error.message : String(error)}`;
    ctx.log.error('title XML fetch failed', { titleNumber, reason });
    for (const leaf of leavesOf(nodes)) {
      leafMeasurements.set(leaf.citation, {
        known: false,
        words: null,
        status: WordCountStatus.UnavailableFetchFailed,
        reason,
      });
    }
    return {
      nodes,
      measurements: rollUpTree(nodes, leafMeasurements),
      units: plan.units,
      contentKeys,
      parseFailures: 0,
      fetchFailures: 1,
    };
  }

  const result = await processTitleXml(
    ctx.ecfr,
    {
      titleNumber,
      sourceDate,
      xml,
      leaves: leavesOf(nodes),
      containers: containersOf(nodes),
      units: plan.units,
      byCitation,
      onLeaf: (citation, measurement) => leafMeasurements.set(citation, measurement),
      onOwnText: (citation, measurement) => ownText.set(citation, measurement),
      onUnit: (unit, html) => uploadUnit(ctx, contentKeys, unit, html),
    },
    ctx.log,
  );

  if (result.containersWithOwnText > 0) {
    ctx.log.info('containers carrying text of their own', {
      titleNumber,
      containers: result.containersWithOwnText,
      of: result.containersMeasured,
    });
  }

  return {
    nodes,
    measurements: rollUpTree(nodes, leafMeasurements, ownText),
    units: plan.units,
    contentKeys,
    parseFailures: result.parseFailures,
    fetchFailures: 0,
  };
}

/**
 * Delta: only the parts whose fingerprint moved, fetched with `?part=`.
 *
 * `?part=` and `?section=` are the only query parameters that actually slice a title.
 * `?chapter=` and `?subtitle=` VALIDATE and then return the entire title — that is the trap
 * the predecessor fell into, and the reason there is no chapter-level fetch anywhere here.
 *
 * Leaves in parts that did not change keep their previous measurement. Without that, every
 * unchanged section would roll up as `not_computed` and the title's total would go NULL on a
 * night when nothing happened.
 */
async function processChangedParts(
  ctx: PipelineContext,
  titleNumber: number,
  sourceDate: string,
  nodes: FlatNode[],
  previous: ReadonlyMap<string, Measurement>,
  targets: ReadonlyArray<{ part: string; citation: string }>,
): Promise<TitleWork> {
  const byCitation = indexByCitation(nodes);
  const plan = planRender(nodes);
  const leafMeasurements = new Map<string, Measurement>();
  const ownText = new Map<string, Measurement>();
  const contentKeys: TitleWork['contentKeys'] = [];

  for (const leaf of leavesOf(nodes)) {
    const carried = previous.get(leaf.citation);
    if (carried) leafMeasurements.set(leaf.citation, carried);
  }

  const changedCitations = new Set(targets.map((t) => t.citation));
  const insideRefetch = (citation: string): boolean =>
    targets.some((t) => citation === t.citation || citation.startsWith(`${t.citation}/`));

  // A part this run did NOT refetch keeps its previous resolved total outright, rather than
  // being recomposed from its carried-forward sections.
  //
  // That total already had the part's own text folded in, and there is no XML in hand to
  // measure that text again — `?part=` was never requested for this part. Recomposing from
  // sections alone would silently drop it (29 CFR 1910 carries 146 words directly under the
  // part) and the same part would then report a different number on a delta night than on the
  // night of a backfill. Carrying the total keeps the two paths arithmetically identical,
  // which is the invariant the whole staged pipeline is built around.
  const containers = containersOf(nodes);
  for (const container of containers) {
    if (insideRefetch(container.citation)) continue;
    const carried = previous.get(container.citation);
    if (carried) leafMeasurements.set(container.citation, carried);
  }

  const unitsFor = (partCitation: string): RenderUnit[] =>
    plan.units.filter((u) => u.partCitation === partCitation);

  let parseFailures = 0;
  let fetchFailures = 0;

  for (const target of targets) {
    const partNode = byCitation.get(target.citation);
    if (!partNode) continue;

    // Leaves under this part only. Comparing the citation prefix is exact here because a
    // citation is the full ancestry path and `/` cannot appear inside an identifier segment
    // (slashes are normalised out when the route is built).
    const leaves = leavesOf(nodes).filter(
      (leaf) =>
        leaf.citation === target.citation || leaf.citation.startsWith(`${target.citation}/`),
    );

    let xml: string;
    try {
      xml = await ctx.client.fetchTitleXml(titleNumber, sourceDate, { part: target.part });
    } catch (error) {
      const reason = `title ${titleNumber} part ${target.part} fetch failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      ctx.log.error('part fetch failed', { titleNumber, part: target.part });
      for (const leaf of leaves) {
        leafMeasurements.set(leaf.citation, {
          known: false,
          words: null,
          status: WordCountStatus.UnavailableFetchFailed,
          reason,
        });
      }
      fetchFailures += 1;
      continue;
    }

    const result = await processTitleXml(
      ctx.ecfr,
      {
        titleNumber,
        sourceDate,
        xml,
        leaves,
        // This part's own containers only. `?part=` returns just this part's subtree, so
        // pointing the own-text pass at another part's containers would ask the parser for
        // nodes this document cannot contain.
        containers: containers.filter(
          (c) => c.citation === target.citation || c.citation.startsWith(`${target.citation}/`),
        ),
        units: unitsFor(target.citation),
        byCitation,
        onLeaf: (citation, measurement) => leafMeasurements.set(citation, measurement),
        onOwnText: (citation, measurement) => ownText.set(citation, measurement),
        onUnit: (unit, html) => uploadUnit(ctx, contentKeys, unit, html),
      },
      ctx.log,
    );
    parseFailures += result.parseFailures;
  }

  ctx.log.info('delta parts processed', {
    titleNumber,
    refetched: changedCitations.size,
    carried: leafMeasurements.size - changedCitations.size,
  });

  return {
    nodes,
    measurements: rollUpTree(nodes, leafMeasurements, ownText),
    units: plan.units,
    contentKeys,
    parseFailures,
    fetchFailures,
  };
}

interface StageTitleInput {
  ctx: PipelineContext;
  run: SyncRun;
  work: TitleWork;
  titleNumber: number;
  sourceDate: string;
  structureFingerprint: string;
  pruner: SqlWriter;
  apply: ApplyQueue;
  /** Full version history on a backfill, the delta window on a delta. Empty is legitimate. */
  amendments: readonly ContentVersion[];
  watermark: Row;
}

/**
 * Generate, queue and checkpoint one title. Applies nothing.
 *
 * A checkpoint now means "this title's SQL exists on disk and is queued", not "these rows are
 * in D1" — because nothing is in D1 until the publish gate has accepted the whole run. The
 * checkpoint records the exact segment files it produced, and a resumed run re-queues them, so
 * the change of meaning does not cost recovery: a crash still costs one title's work, and a
 * skipped title's rows still reach D1 on the run that finishes.
 *
 * EVERYTHING for the title goes into ONE writer — nodes, content-key updates, amendments, the
 * watermark. Not tidiness: only files listed in the checkpoint are re-queued on resume, so a
 * separate writer's output would be silently dropped by any run that skipped this title.
 */
async function stageTitle(input: StageTitleInput): Promise<void> {
  const { ctx, run, work, titleNumber, sourceDate, structureFingerprint, pruner, apply } = input;
  const writer = new SqlWriter({
    outDir: join(ctx.config.outDir, `title-${titleNumber}`),
    runId: run.id,
  });
  await mkdir(join(ctx.config.outDir, `title-${titleNumber}`), { recursive: true });

  // Every node in the title's CURRENT structure is upserted, not just the ones whose XML was
  // refetched — a delta carries forward the previous measurement for untouched parts and
  // still rewrites the row. That completeness is what makes the title-scoped prune below both
  // safe and effective: anything still sitting at an older run id is a node that has left the
  // structure, and deleting it is the point.
  //
  // Do NOT bump last_seen_run_id for the whole title before this. It looks like a way to
  // protect unchanged rows, but the upsert already covers every live node, so all a blanket
  // touch does is resurrect the nodes that were removed upstream — permanently, since they
  // would then survive every future prune too.
  writer.upsert(STRUCTURE_NODE, nodeRows(work.nodes, work.measurements, run.id));

  // After the rows exist, and only for units whose PUT returned.
  for (const { citation, contentKey } of work.contentKeys) {
    writer.statement(
      `UPDATE structure_node SET content_key = ${sqlString(contentKey)} WHERE citation = ${sqlString(citation)};`,
    );
  }

  writer.upsert(AMENDMENT, amendmentRows(titleNumber, input.amendments, run.id));
  writer.upsert(TITLE_WATERMARK, [input.watermark]);

  const bundle = await writer.finish(`title-${titleNumber}`);
  apply.add(`title-${titleNumber}`, bundle.dataFiles, titleNumber);

  // The prune is planned now and emitted only if this unit commits, but it cannot RUN until
  // the replacement rows are in D1. That ordering is preserved by the apply phase: every
  // queued data segment is applied before the single prune file is.
  pruner.planPrune(`title-${titleNumber}`, {
    table: 'structure_node',
    where: `title_number = ${sqlInt(titleNumber)}`,
  });
  pruner.commitUnit(`title-${titleNumber}`);

  await ctx.nodes.save(titleNumber, sourceDate, work.nodes, work.measurements);
  await ctx.checkpoints.write({
    titleNumber,
    sourceDate,
    structureFingerprint,
    nodeCount: work.nodes.length,
    leavesMeasured: [...work.measurements.values()].filter((m) => m.known).length,
    fetchFailures: work.fetchFailures,
    parseFailures: work.parseFailures,
    sqlFiles: [...bundle.dataFiles],
    completedAt: new Date().toISOString(),
  });

  run.recordTitle({
    title: titleNumber,
    status: TitleStatus.Complete,
    nodesWritten: bundle.rowsUpserted,
    fetchFailures: work.fetchFailures,
    parseFailures: work.parseFailures,
  });
}

// ─── finalisation ────────────────────────────────────────────────────────────

async function readGateBaseline(d1: D1, log: Logger): Promise<GateStats | null> {
  try {
    const row = await d1.queryOne<{
      total_words: number | null;
      agency_count: number;
      title_count: number;
      uncounted: number;
    }>(
      `SELECT
         (SELECT SUM(deduplicated_word_count) FROM agency_rollup) AS total_words,
         (SELECT COUNT(*) FROM agency) AS agency_count,
         (SELECT COUNT(*) FROM title WHERE reserved = 0) AS title_count,
         (SELECT COUNT(*) FROM structure_node WHERE word_count IS NULL) AS uncounted;`,
      'gate-baseline',
    );
    if (!row) return null;
    // A published pointer that has never been set means there is no baseline, even if rows
    // exist from a run that was refused.
    const published = await d1.queryOne<{ published_run_id: number | null }>(
      'SELECT published_run_id FROM app_meta WHERE id = 1;',
      'published-run',
    );
    if (!published || published.published_run_id === null) return null;

    return {
      totalWords: row.total_words,
      agencyCount: row.agency_count,
      titleCount: row.title_count,
      uncountedNodes: row.uncounted,
    };
  } catch (error) {
    log.warn(BASELINE_UNREADABLE, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export interface FinaliseInput {
  ctx: PipelineContext;
  run: SyncRun;
  sourceDate: string;
  agencies: AgencyInput[];
  rawAgencies: readonly Agency[];
  /** Every title eCFR listed, reserved included. The site lists all of them. */
  titles: readonly Title[];
  /** Titles whose nodes are needed for the rollup. Always all non-reserved titles. */
  allTitleNumbers: readonly number[];
  pruner: SqlWriter;
  /** True when this run touched every title, so agency/title prunes may be global. */
  fullCorpus: boolean;
  apply: ApplyQueue;
  /**
   * D1 as it was BEFORE this run wrote anything. Read once, at run start.
   *
   * Reading it here instead would compare the run against itself: the rollups are the last
   * thing written, so a baseline taken after them differs from `current` by nothing at all and
   * four of the six gate checks could never fire.
   */
  baseline: GateStats | null;
}

/**
 * Rollups, render manifest, gate, and — only if the gate accepts — apply, publish, snapshot.
 *
 * The rollup reads from the node store rather than from whatever this run happened to
 * process, because an agency's scope can name a title the run never touched. A delta that
 * computed totals only from its dirty titles would drop every other agency to NULL.
 */
async function finalise(input: FinaliseInput): Promise<boolean> {
  const { ctx, run, sourceDate, agencies, rawAgencies, allTitleNumbers, pruner, apply } = input;
  const log = ctx.log.child('finalise');

  const stored = await log.time('load node store', () => ctx.nodes.loadMany(allTitleNumbers));
  const allNodes = stored.map((s) => s.node);
  const measurements = new Map(stored.map((s) => [s.node.citation, s.measurement]));

  const resolver = createScopeResolver(allNodes, measurements);
  const rollup = computeRollups({ agencies, resolver });

  log.info('rollup complete', {
    agencies: rollup.rollups.length,
    distinctScopes: rollup.distinctScopes,
    unresolvedScopes: rollup.unresolvedScopes,
    sharedScopes: rollup.overlaps.length,
    nestedScopePairs: rollup.nestedScopePairs,
    corpusDeduplicatedWords: rollup.corpusDeduplicatedWords ?? 'NULL',
  });

  // Render manifest. Planned over every node so the web build sees the whole site, even on a
  // delta that only re-uploaded a handful of parts.
  const plan = planRender(allNodes);
  const manifest = buildManifest(run.id, sourceDate, plan, {
    staticPages: STATIC_PAGE_COUNT,
    agencies: agencies.length,
    titles: allTitleNumbers.length,
    chapters: allNodes.filter((n) => n.nodeType === 'chapter').length,
    partPages: plan.units.length,
  });
  await writeManifest(join(ctx.config.outDir, 'render-manifest.json'), manifest);
  log.info('render manifest written', {
    totalFiles: manifest.totalFiles,
    limit: manifest.budget.limit,
    splits: plan.splits.length,
    oversized: plan.oversized.length,
  });
  if (manifest.totalFiles > manifest.budget.warnAt) {
    log.warn('file count is inside the warning band', {
      total: manifest.totalFiles,
      warnAt: manifest.budget.warnAt,
      cap: manifest.budget.platformCap,
    });
  }

  // Rollup SQL.
  const writer = new SqlWriter({ outDir: join(ctx.config.outDir, 'rollup'), runId: run.id });
  await mkdir(join(ctx.config.outDir, 'rollup'), { recursive: true });

  writer.upsert(AGENCY, agencyRows(agencies, rawAgencies, run.id));
  writer.upsert(
    AGENCY_CFR_REFERENCE,
    rollup.references.map((reference) => ({
      agency_slug: reference.agencySlug,
      ref_key: reference.refKey,
      title_number: reference.titleNumber,
      narrowest_level: reference.narrowestLevel,
      subtitle_id: reference.subtitleId,
      chapter_id: reference.chapterId,
      subchapter_id: reference.subchapterId,
      part_id: reference.partId,
      node_citation: reference.nodeCitation,
      last_seen_run_id: run.id,
    })),
  );
  writer.upsert(
    SCOPE_OVERLAP,
    rollup.overlaps.map((overlap) => ({
      ref_key: overlap.refKey,
      title_number: overlap.titleNumber,
      agency_count: overlap.agencyCount,
      agency_slugs: overlap.agencySlugs,
      word_count: overlap.wordCount,
      last_seen_run_id: run.id,
    })),
  );
  writer.upsert(
    AGENCY_ROLLUP,
    rollup.rollups.map((r) => ({
      agency_slug: r.agencySlug,
      attributed_word_count: r.attributedWordCount,
      deduplicated_word_count: r.deduplicatedWordCount,
      subtree_attributed: r.subtreeAttributed,
      subtree_deduplicated: r.subtreeDeduplicated,
      refs_total: r.refsTotal,
      refs_counted: r.refsCounted,
      shared_refs: r.sharedRefs,
      children_count: r.childrenCount,
      coverage_pct: r.coveragePct,
      last_seen_run_id: run.id,
    })),
  );
  writer.upsert(
    AGENCY_SNAPSHOT,
    buildSnapshots(rollup.rollups, sourceDate, run.id).map((s) => ({
      agency_slug: s.agencySlug,
      snapshot_date: s.snapshotDate,
      run_id: s.runId,
      attributed_word_count: s.attributedWordCount,
      deduplicated_word_count: s.deduplicatedWordCount,
      coverage_pct: s.coveragePct,
    })),
  );

  const bundle = await writer.finish('rollup');
  apply.add('rollup', bundle.dataFiles);

  // Prunes. Agency and reference prunes are global only on a run that saw every agency —
  // which is every run, since agencies.json is always fetched in full.
  pruner.planPrune('agencies', { table: 'agency_cfr_reference', where: 'TRUE' });
  pruner.planPrune('agencies', { table: 'scope_overlap', where: 'TRUE' });
  pruner.planPrune('agencies', { table: 'agency_rollup', where: 'TRUE' });
  pruner.planPrune('agencies', { table: 'agency', where: 'TRUE' });
  pruner.commitUnit('agencies');
  if (input.fullCorpus) {
    pruner.planPrune('titles', { table: 'title', where: 'TRUE' });
    pruner.commitUnit('titles');
  }

  const pruneBundle = await pruner.finish('prune-plan');
  if (pruneBundle.withheldUnits.length > 0) {
    log.warn('withholding prunes for units that did not commit', {
      units: pruneBundle.withheldUnits.join(','),
    });
  }

  // ── the gate, BEFORE anything is applied ──
  //
  // `current` is computed entirely from this run's in-memory output, and `baseline` was read
  // before the run wrote a byte. Nothing in D1 has moved, so a refusal below genuinely leaves
  // the published data untouched rather than merely declining to point at the damage.

  const current: GateStats = {
    totalWords: rollup.corpusDeduplicatedWords,
    agencyCount: agencies.length,
    titleCount: allTitleNumbers.length,
    uncountedNodes: [...measurements.values()].filter((m) => !m.known).length,
  };

  const verdict = evaluatePublishGate({
    current,
    previous: input.baseline,
    partiallyWrittenTitles: run.partiallyWrittenTitles,
    fetchFailures: run.counters.fetchFailures,
    parseFailures: run.counters.parseFailures,
  });

  process.stdout.write(`${verdict.summary}\n`);

  if (!verdict.ok) {
    log.warn(GATE_REFUSED_DISCARDING, {
      segments: apply.fileCount,
      stagedContentFiles: ctx.staging?.staged ?? 0,
    });
    // The generated .sql stays on disk under SYNC_OUT_DIR for a human to inspect. The staged
    // HTML does not: it would otherwise be promoted by a LATER run that never rendered those
    // parts, pairing text from a refused run with measurements from an accepted one.
    await ctx.staging?.discard();
    return false;
  }

  if (ctx.config.dryRun) {
    log.info('dry run: gate passed, nothing applied', { segments: apply.fileCount });
    await ctx.staging?.discard();
    return true;
  }

  // ── apply ──

  const applied = await log.time('apply segments', () => apply.applyAll(ctx, run, log));
  if (!applied) {
    // The gate already passed, but a mid-apply failure is the one state aggregates cannot see:
    // a title's rows are now a mixture of two runs. Refuse the pointer bump on the same
    // grounds the gate would have.
    log.error(PARTIAL_APPLY_REFUSAL, {
      partialTitles: run.partiallyWrittenTitles.join(',') || 'none',
    });
    // Staging is NOT discarded here. The gate accepted this data; what failed is
    // infrastructure (run 7: one transient auth error from the D1 import API after 42 clean
    // segments). The staged HTML belongs to exactly the SQL a resume will requeue, so
    // keeping it is what lets that resume publish without re-pulling 810 MB.
    return false;
  }

  if (pruneBundle.pruneFile) {
    // Count first so `nodes_pruned` is a measured number rather than an estimate.
    for (const spec of pruneBundle.prunes) {
      const row = await ctx.d1.queryOne<{ n: number }>(
        buildPruneCount(spec, run.id),
        `prune-count:${spec.table}`,
      );
      if (row) run.recordPruned(row.n);
    }
    await ctx.d1.applyFile(pruneBundle.pruneFile);
  }

  await run.publish();

  // ── snapshot ──
  //
  // Emitted last, from the same in-memory rollup that the gate just accepted plus the
  // amendment aggregates now sitting in D1. A failure here does not un-publish the run — the
  // data is correct and served by the API — but it does fail the job, because a deploy built
  // from a stale snapshot directory would quietly show yesterday's numbers.

  if (ctx.staging) {
    const promoted = await ctx.staging.promote();
    log.info('promoted rendered content into the snapshot', { files: promoted });
  }

  const staging = ctx.staging ?? new ContentStaging(ctx.config.snapshotDir);
  await writeSnapshot({
    dir: ctx.config.snapshotDir,
    runId: run.id,
    sourceDate,
    titles: input.titles,
    nodes: allNodes,
    measurements,
    agencies,
    rawAgencies,
    rollup,
    plan,
    amendments: await readAmendmentIndex(ctx.d1),
    history: await readAgencyHistory(ctx.d1),
    content: staging,
    log,
  });

  return true;
}

/** `agency_snapshot`, grouped per agency. One query; the table is one row per agency per run. */
async function readAgencyHistory(d1: D1): Promise<
  Map<
    string,
    Array<{
      snapshot_date: string;
      attributed: number | null;
      deduplicated: number | null;
      coverage_pct: number | null;
    }>
  >
> {
  const rows = await d1.query<{
    agency_slug: string;
    snapshot_date: string;
    attributed_word_count: number | null;
    deduplicated_word_count: number | null;
    coverage_pct: number | null;
  }>(
    `SELECT agency_slug, snapshot_date, attributed_word_count, deduplicated_word_count, coverage_pct
     FROM agency_snapshot ORDER BY agency_slug, snapshot_date;`,
    'agency-history',
  );

  const out = new Map<
    string,
    Array<{
      snapshot_date: string;
      attributed: number | null;
      deduplicated: number | null;
      coverage_pct: number | null;
    }>
  >();
  for (const row of rows) {
    const bucket = out.get(row.agency_slug) ?? [];
    bucket.push({
      snapshot_date: row.snapshot_date,
      attributed: row.attributed_word_count,
      deduplicated: row.deduplicated_word_count,
      coverage_pct: row.coverage_pct,
    });
    out.set(row.agency_slug, bucket);
  }
  return out;
}

// ─── entry stages ────────────────────────────────────────────────────────────

async function fetchTitlesOrAbort(
  ctx: PipelineContext,
  run: SyncRun,
): Promise<{ titles: Title[]; sourceDate: string }> {
  const result = await ctx.client.fetchTitles();
  if (result.importInProgress) throw new ImportInProgressError();

  // eCFR's own snapshot date when it gives one; otherwise the newest issue date across the
  // titles. Content fetches key on this, and using "today" would ask for a date eCFR has not
  // published — it publishes on business days only, 57 issue dates in 84 days, zero weekends.
  const sourceDate =
    result.date ??
    result.titles
      .map((t) => t.latest_issue_date)
      .filter((d): d is string => d !== null)
      .sort()
      .at(-1);

  if (!sourceDate) throw new Error('titles.json carried neither meta.date nor any issue date');
  run.setSourceDate(sourceDate);
  return { titles: result.titles, sourceDate };
}

/**
 * Re-queue a skipped title's segments.
 *
 * A checkpoint means "this title's SQL is on disk", not "its rows are in D1", so a resumed run
 * has to apply what the earlier attempt generated. If any of those files has gone (a partly
 * cleared cache, a `SYNC_OUT_DIR` on a tmpfs), the checkpoint is not honourable and the title
 * is reprocessed instead — the one thing that must not happen is a run that skips a title AND
 * never applies it.
 */
function requeueCheckpoint(
  apply: ApplyQueue,
  titleNumber: number,
  sqlFiles: readonly string[],
  log: Logger,
): boolean {
  const missing = sqlFiles.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    log.warn(CHECKPOINT_SEGMENTS_MISSING, {
      titleNumber,
      missing: missing.length,
      of: sqlFiles.length,
    });
    return false;
  }
  apply.add(`title-${titleNumber}`, sqlFiles, titleNumber);
  return true;
}

export async function runBackfill(ctx: PipelineContext): Promise<boolean> {
  // Before the run row exists, and long before any data is written. This is the state the
  // gate compares against; reading it any later compares the run to itself.
  const baseline = await readGateBaseline(ctx.d1, ctx.log);

  const run = await SyncRun.open(RunKind.Backfill, ctx.d1, ctx.log, ctx.config.dryRun);
  ctx.staging = new ContentStaging(ctx.config.snapshotDir);
  const apply = new ApplyQueue();
  const pruner = new SqlWriter({ outDir: join(ctx.config.outDir, 'prune'), runId: run.id });
  await mkdir(join(ctx.config.outDir, 'prune'), { recursive: true });

  try {
    const { titles, sourceDate } = await fetchTitlesOrAbort(ctx, run);
    ctx.log.info('backfill starting', { sourceDate, titles: titles.length });

    // Titles first: structure_node.title_number is a foreign key.
    const metaWriter = new SqlWriter({ outDir: join(ctx.config.outDir, 'meta'), runId: run.id });
    await mkdir(join(ctx.config.outDir, 'meta'), { recursive: true });
    metaWriter.upsert(TITLE, titleRows(titles, run.id));

    const { agencies: rawAgencies } = await ctx.client.fetchAgencies();
    const agencies = flattenAgencies(rawAgencies, ctx.log);
    metaWriter.upsert(AGENCY, agencyRows(agencies, rawAgencies, run.id));

    const metaBundle = await metaWriter.finish('meta');
    apply.add('meta', metaBundle.dataFiles);

    const live = titles.filter((t) => !t.reserved && t.latest_amended_on !== null);

    for (const title of live) {
      const titleLog = ctx.log.child(`title-${title.number}`);
      const structure = await titleLog.time('fetch structure', () =>
        ctx.client.fetchStructure(title.number, sourceDate),
      );
      const structureFingerprint = fingerprint(structure);

      const done = await ctx.checkpoints.isComplete(title.number, sourceDate, structureFingerprint);
      if (done && requeueCheckpoint(apply, title.number, done.sqlFiles, titleLog)) {
        titleLog.info(CHECKPOINT_MATCH, {
          nodes: done.nodeCount,
          requeuedSegments: done.sqlFiles.length,
        });
        run.recordTitle({
          title: title.number,
          status: TitleStatus.Skipped,
          nodesWritten: 0,
          fetchFailures: 0,
          parseFailures: 0,
        });
        // Deliberately plans NO prune for this title.
        //
        // Its segments carry the EARLIER attempt's run id, so a prune scoped to
        // `last_seen_run_id < thisRun` would delete the entire title straight after applying
        // it. The alternative — bumping them all first — would resurrect any node that has
        // since left the structure. Leaving the title alone is the only option that neither
        // deletes live rows nor revives dead ones; the next run that processes it will prune.
        continue;
      }

      const nodes = flattenStructure(structure, title.number);
      const work = await titleLog.time('process title', () =>
        processWholeTitle(ctx, title.number, sourceDate, nodes),
      );

      // The FULL version history, not a window. This is the only place the amendment table
      // gets its history: the nightly delta writes just the rows since its watermark, so a
      // backfill that skipped this left every amendment timeline empty until enough nightly
      // runs had accumulated. Unfiltered responses carry meta.total_pages, so this pages
      // properly rather than stopping at the first 1,000 rows.
      const history = await titleLog.time('fetch version history', () =>
        fetchAllVersions(ctx.client, title.number, titleLog),
      );
      titleLog.info('version history', {
        rows: history.versions.length,
        pages: history.pagesFetched,
        totalPages: history.totalPages ?? 'none reported',
        duplicatesDropped: history.duplicatesDropped,
      });

      await stageTitle({
        ctx,
        run,
        work,
        titleNumber: title.number,
        sourceDate,
        structureFingerprint,
        pruner,
        apply,
        amendments: history.versions,
        // Watermark, so the first delta after a backfill has something to compare against.
        watermark: {
          title_number: title.number,
          latest_amended_on: title.latest_amended_on,
          latest_issue_date: title.latest_issue_date,
          last_synced_at: new Date().toISOString(),
          last_synced_run_id: run.id,
        },
      });
    }

    const ok = await finalise({
      ctx,
      run,
      sourceDate,
      agencies,
      rawAgencies,
      titles,
      allTitleNumbers: live.map((t) => t.number),
      pruner,
      fullCorpus: true,
      apply,
      baseline,
    });

    await run.succeed(ok ? RUN_PUBLISHED : RUN_REFUSED_BY_GATE);
    return ok;
  } catch (error) {
    // Staging survives a crash on purpose: the resume requeues this run's staged SQL and
    // must be able to promote the HTML rendered alongside it. Only a gate refusal — a
    // judgement against the data itself — discards staged content.
    if (error instanceof ImportInProgressError) await run.abort(error.message);
    else await run.fail(error);
    throw error;
  }
}

export async function runDelta(ctx: PipelineContext): Promise<boolean> {
  const baseline = await readGateBaseline(ctx.d1, ctx.log);

  const run = await SyncRun.open(RunKind.Delta, ctx.d1, ctx.log, ctx.config.dryRun);
  ctx.staging = new ContentStaging(ctx.config.snapshotDir);
  const apply = new ApplyQueue();
  const pruner = new SqlWriter({ outDir: join(ctx.config.outDir, 'prune'), runId: run.id });
  await mkdir(join(ctx.config.outDir, 'prune'), { recursive: true });

  try {
    const { titles, sourceDate } = await fetchTitlesOrAbort(ctx, run);

    const watermarkRows = await ctx.d1.query<{
      title_number: number;
      latest_amended_on: string | null;
      latest_issue_date: string | null;
      last_synced_at: string | null;
    }>('SELECT * FROM title_watermark;', 'watermarks');

    const watermarks: TitleWatermark[] = watermarkRows.map((row) => ({
      titleNumber: row.title_number,
      latestAmendedOn: row.latest_amended_on,
      latestIssueDate: row.latest_issue_date,
      lastSyncedAt: row.last_synced_at,
    }));
    const watermarkByTitle = new Map(watermarks.map((w) => [w.titleNumber, w]));

    const plan = planTitleDelta({ titles, meta: { date: sourceDate } }, watermarks);
    ctx.log.info('delta plan', {
      sourceDate,
      dirty: plan.dirty.length,
      unchanged: plan.unchanged.length,
      reserved: plan.reserved.length,
    });

    const metaWriter = new SqlWriter({ outDir: join(ctx.config.outDir, 'meta'), runId: run.id });
    await mkdir(join(ctx.config.outDir, 'meta'), { recursive: true });
    metaWriter.upsert(TITLE, titleRows(titles, run.id));

    const { agencies: rawAgencies } = await ctx.client.fetchAgencies();
    const agencies = flattenAgencies(rawAgencies, ctx.log);
    metaWriter.upsert(AGENCY, agencyRows(agencies, rawAgencies, run.id));
    const metaBundle = await metaWriter.finish('meta');
    apply.add('meta', metaBundle.dataFiles);

    for (const dirty of plan.dirty) {
      const titleLog = ctx.log.child(`title-${dirty.number}`);
      const watermark = watermarkByTitle.get(dirty.number);

      // (b) versions
      const windowStart = versionsWindowStart(watermark);
      const versionsResult = await ctx.client.fetchVersions(dirty.number, {
        ...(windowStart ? { issueDateGte: windowStart } : {}),
      });
      // The client's truncation verdict is better informed than a row count: it knows whether
      // the request was filtered, and eCFR omits meta.total_pages only on filtered responses.
      const versions = summariseVersions(
        versionsResult.versions,
        versionsResult.truncation !== null,
      );
      if (versions.possiblyTruncated) {
        titleLog.warn('versions window may be truncated; refetching every part in the title', {
          rows: versionsResult.truncation?.rows ?? versions.all.length,
          reason: versionsResult.truncation?.reason ?? 'exactly one page returned',
        });
      }

      // (c) structure fingerprints
      const structure = await ctx.client.fetchStructure(dirty.number, sourceDate);
      const nodes = flattenStructure(structure, dirty.number);
      const previousStored = await ctx.nodes.load(dirty.number);
      const previousMeasurements = new Map(
        previousStored.map((s) => [s.node.citation, s.measurement]),
      );
      const storedPartSizes = new Map(
        previousStored
          .filter((s) => s.node.nodeType === 'part')
          .map((s) => [s.node.citation, s.node.xmlBytes]),
      );

      const diff = diffStructureSizes(nodes, storedPartSizes);
      const allParts = nodes.filter((n) => n.nodeType === 'part');
      const targets = planRefetch(dirty.number, diff, versions, allParts);

      titleLog.info('change detection', {
        reason: dirty.reason,
        amendedOn: dirty.latestAmendedOn,
        substantiveVersions: versions.substantive.length,
        removedSections: versions.removed.length,
        partsChangedBySize: diff.changed.length,
        partsAdded: diff.added.length,
        partsRemoved: diff.removedCitations.length,
        partsUnchanged: diff.unchanged,
        refetching: targets.length,
        ofParts: allParts.length,
      });

      // (d) refetch
      const work = await titleLog.time('process changed parts', () =>
        processChangedParts(ctx, dirty.number, sourceDate, nodes, previousMeasurements, targets),
      );
      await stageTitle({
        ctx,
        run,
        work,
        titleNumber: dirty.number,
        sourceDate,
        structureFingerprint: fingerprint(structure),
        pruner,
        apply,
        // The delta window only. A backfill is what fills in the history behind it; these rows
        // upsert on the amendment primary key, so re-seeing one is free.
        amendments: versions.all,
        watermark: {
          title_number: dirty.number,
          latest_amended_on: dirty.latestAmendedOn,
          latest_issue_date: dirty.latestIssueDate,
          last_synced_at: new Date().toISOString(),
          last_synced_run_id: run.id,
        },
      });
    }

    // Titles this run did not touch keep their existing rows. Their prunes are never planned,
    // so nothing scoped to them can be deleted.
    const live = titles.filter((t) => !t.reserved && t.latest_amended_on !== null);

    const ok = await finalise({
      ctx,
      run,
      sourceDate,
      agencies,
      rawAgencies,
      titles,
      allTitleNumbers: live.map((t) => t.number),
      pruner,
      fullCorpus: false,
      apply,
      baseline,
    });

    await run.succeed(ok ? RUN_PUBLISHED : RUN_REFUSED_BY_GATE);
    return ok;
  } catch (error) {
    // Staging survives a crash on purpose: the resume requeues this run's staged SQL and
    // must be able to promote the HTML rendered alongside it. Only a gate refusal — a
    // judgement against the data itself — discards staged content.
    if (error instanceof ImportInProgressError) await run.abort(error.message);
    else await run.fail(error);
    throw error;
  }
}

/**
 * `--fresh` on a backfill: throw away checkpoints and start over.
 *
 * This also removes the snapshot when it lives under the cache directory (it does by default).
 * That is correct for `--fresh`: the run re-renders every part, so every content file is
 * rewritten, and keeping stale bodies from a previous corpus alongside fresh measurements is
 * the one combination that would be wrong.
 */
export async function clearCache(config: SyncConfig, log: Logger): Promise<void> {
  log.warn('clearing sync cache', { dir: config.cacheDir });
  await rm(config.cacheDir, { recursive: true, force: true });
  await mkdir(config.outDir, { recursive: true });
}
