/**
 * The publish gate, end to end.
 *
 * The claim under test is the one the gate exists to make and did not make before: a run the
 * gate REFUSES changes nothing. Not "does not advance the pointer" — changes nothing. Before
 * this, `finalise` applied every rollup segment and the prune file and only then evaluated the
 * gate, so a refusal withheld the `app_meta` bump while the rows underneath had already been
 * replaced; and the baseline it compared against was read after those writes, so it was
 * comparing the run to itself.
 *
 * These tests drive the real `runBackfill` against a fake D1 and a fake `@ecfr-atlas/ecfr`, and
 * assert on the ORDER and CONTENT of everything that reached the database.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { counted } from '@ecfr-atlas/core';
import type { Agency, StructureNode, Title } from '@ecfr-atlas/core/ecfr-schemas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CheckpointStore, NodeStore } from './checkpoint.js';
import type { SyncConfig } from './config.js';
import { DEFAULT_MAX_RPS } from './config.js';
import type { D1 } from './d1.js';
import type { EcfrClientLike, EcfrModule, VersionsResult } from './ecfr-adapter.js';
import { __setEcfrModule } from './ecfr-adapter.js';
import { createLogger } from './log.js';
import type { PipelineContext } from './pipeline.js';
import { runBackfill } from './pipeline.js';
import { NullObjectSink } from './r2.js';

// ─── fakes ───────────────────────────────────────────────────────────────────

interface BaselineRow {
  total_words: number | null;
  agency_count: number;
  title_count: number;
  uncounted: number;
}

/**
 * Enough of `D1` to run the pipeline, plus an ordered trace of everything it was asked to do.
 *
 * The trace is the point. "Did the gate refuse?" is easy; "did the baseline read happen before
 * the first write?" is the property that was actually broken, and only an ordered record can
 * answer it.
 */
class FakeD1 {
  readonly trace: string[] = [];
  readonly applied: string[] = [];
  readonly commands: string[] = [];
  publishedRunId: number | null = null;
  baseline: BaselineRow | null = null;

  async query<T>(_sql: string, label = 'query'): Promise<T[]> {
    this.trace.push(`query:${label}`);
    switch (label) {
      case 'gate-baseline':
        return (this.baseline ? [this.baseline] : []) as T[];
      case 'published-run':
        return [{ published_run_id: this.publishedRunId }] as T[];
      case 'open-run':
        return [{ id: 7 }] as T[];
      case 'agency-history':
        return [] as T[];
      case 'amend-latest':
        return [{ d: '2026-07-01' }] as T[];
      case 'amend-total':
        return [{ n: 2 }] as T[];
      case 'amend-monthly':
        return [{ title_number: 1, part: '1', month: '2026-07', n: 2 }] as T[];
      case 'amend-last':
        return [{ title_number: 1, part: '1', d: '2026-07-01' }] as T[];
      default:
        if (label.startsWith('prune-count')) return [{ n: 0 }] as T[];
        return [] as T[];
    }
  }

  async queryOne<T>(sql: string, label = 'queryOne'): Promise<T | null> {
    const rows = await this.query<T>(sql, label);
    return rows[0] ?? null;
  }

  async command(sql: string, label = 'command'): Promise<void> {
    this.trace.push(`command:${label}`);
    this.commands.push(sql);
  }

  async applyFile(path: string): Promise<void> {
    this.trace.push('apply');
    this.applied.push(path);
  }

  async applyFiles(paths: readonly string[]): Promise<void> {
    for (const path of paths) await this.applyFile(path);
  }
}

const TITLE_1: Title = {
  number: 1,
  name: 'General Provisions',
  latest_amended_on: '2026-07-01',
  latest_issue_date: '2026-07-01',
  up_to_date_as_of: '2026-07-01',
  reserved: false,
};

const AGENCY_1: Agency = {
  name: 'Administrative Committee of the Federal Register',
  short_name: 'ACFR',
  display_name: 'Administrative Committee of the Federal Register',
  sortable_name: 'Administrative Committee of the Federal Register',
  slug: 'administrative-committee-of-the-federal-register',
  cfr_references: [{ title: 1, chapter: 'I' }],
  children: [],
};

const STRUCTURE: StructureNode = {
  type: 'title',
  identifier: '1',
  label: 'Title 1—General Provisions',
  size: 4000,
  children: [
    {
      type: 'chapter',
      identifier: 'I',
      label: 'Chapter I—Administrative Committee of the Federal Register',
      size: 4000,
      children: [
        {
          type: 'part',
          identifier: '1',
          label: 'Part 1—Definitions',
          size: 4000,
          children: [
            { type: 'section', identifier: '1.1', label: '§ 1.1 Scope.', size: 2000 },
            { type: 'section', identifier: '1.2', label: '§ 1.2 Definitions.', size: 2000 },
          ],
        },
      ],
    },
  ],
};

/** Two sections at 100 words each, no own text: the corpus total is exactly 200. */
const CORPUS_WORDS = 200;

const fakeClient: EcfrClientLike = {
  fetchAgencies: async () => ({ agencies: [AGENCY_1] }),
  fetchTitles: async () => ({ titles: [TITLE_1], date: '2026-07-01', importInProgress: false }),
  fetchStructure: async () => STRUCTURE,
  fetchTitleXml: async () => '<DIV5 />',
  fetchVersions: async (): Promise<VersionsResult> => ({
    versions: [
      {
        date: '2026-07-01',
        amendment_date: '2026-07-01',
        issue_date: '2026-07-01',
        identifier: '1.1',
        name: '§ 1.1',
        part: '1',
        subpart: null,
        title: '1',
        type: 'section',
        removed: false,
        substantive: true,
      },
    ],
    totalPages: 1,
    page: null,
    truncation: null,
  }),
};

const fakeEcfr: EcfrModule = {
  EcfrClient: class {} as unknown as EcfrModule['EcfrClient'],
  parser: {
    parse: () => ({}),
    findNode: (_doc, selector) => selector,
    extractText: () => 'text',
    toHtml: () => ({
      html: '<p>text</p>',
      meta: { heading: null, authority: [], source: [], frCitations: [] },
    }),
  },
  wordcount: {
    countWords: () => 100,
    // Sections carry the words; the part carries none of its own, which is the ordinary shape.
    measureNode: (node) =>
      (node as { type?: string }).type === 'section' ? counted(100) : counted(0),
    measureOwnText: () => counted(0),
  },
};

// ─── harness ─────────────────────────────────────────────────────────────────

let workDir: string;
let d1: FakeD1;
let ctx: PipelineContext;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ecfr-pipeline-'));
  __setEcfrModule(fakeEcfr);
  d1 = new FakeD1();

  const config: SyncConfig = {
    repoRoot: workDir,
    d1Database: 'test',
    wranglerConfig: join(workDir, 'wrangler.jsonc'),
    local: true,
    cacheDir: join(workDir, 'cache'),
    outDir: join(workDir, 'out'),
    snapshotDir: join(workDir, 'snapshot'),
    userAgent: 'test',
    maxRps: DEFAULT_MAX_RPS,
    r2: null,
    dryRun: false,
  };

  const log = createLogger('test');
  const database = d1 as unknown as D1;
  const checkpoints = new CheckpointStore(config.cacheDir, log);
  const nodes = new NodeStore(config.cacheDir, database, log);
  await checkpoints.init();
  await nodes.init();

  ctx = {
    config,
    log,
    d1: database,
    ecfr: fakeEcfr,
    client: fakeClient,
    sink: new NullObjectSink(),
    checkpoints,
    nodes,
    staging: null,
  };
});

afterEach(async () => {
  __setEcfrModule(null);
  await rm(workDir, { recursive: true, force: true });
});

const readJson = async (relPath: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(workDir, 'snapshot', relPath), 'utf8')) as Record<string, unknown>;

// ─── tests ───────────────────────────────────────────────────────────────────

describe('a run the publish gate refuses', () => {
  it('leaves the previously published data completely intact', async () => {
    // A published baseline 15x larger than what this run measured: a 93% drop, far outside the
    // ±5% the gate allows. Exactly the shape of a title that silently failed to parse.
    d1.publishedRunId = 4;
    d1.baseline = {
      total_words: CORPUS_WORDS * 15,
      agency_count: 1,
      title_count: 1,
      uncounted: 0,
    };

    const published = await runBackfill(ctx);
    expect(published).toBe(false);

    // NOTHING was applied. Not the rollups, not the prune file, not the per-title segments.
    expect(d1.applied).toEqual([]);

    // The pointer was not advanced — and it is the only thing that used to be withheld.
    expect(d1.commands.some((sql) => sql.includes('published_run_id ='))).toBe(false);

    // No snapshot: the site keeps building from whatever it was building from.
    expect(existsSync(join(workDir, 'snapshot', 'manifest.json'))).toBe(false);

    // And no staged HTML left behind to be picked up by a later run that never rendered it.
    const staged = join(workDir, 'snapshot', '.staging-run-7');
    expect(existsSync(staged)).toBe(false);
  });

  it('reads the gate baseline before it writes anything, so `previous` is the PUBLISHED run', async () => {
    d1.publishedRunId = 4;
    d1.baseline = { total_words: CORPUS_WORDS, agency_count: 1, title_count: 1, uncounted: 0 };

    await runBackfill(ctx);

    const baselineAt = d1.trace.indexOf('query:gate-baseline');
    const firstWriteAt = d1.trace.indexOf('apply');
    expect(baselineAt).toBe(0);
    // Either nothing was written, or the baseline read came first. Both are the same claim.
    expect(firstWriteAt === -1 || baselineAt < firstWriteAt).toBe(true);
  });

  it('publishes when the same run is measured against a matching baseline', async () => {
    // The control for the test above: identical run, honest baseline, gate passes.
    d1.publishedRunId = 4;
    d1.baseline = { total_words: CORPUS_WORDS, agency_count: 1, title_count: 1, uncounted: 0 };
    expect(await runBackfill(ctx)).toBe(true);
    expect(d1.applied.length).toBeGreaterThan(0);
  });
});

describe('a run the publish gate accepts', () => {
  beforeEach(() => {
    // No published run yet: the delta checks are skipped rather than failed.
    d1.publishedRunId = null;
  });

  it('applies its segments, advances the pointer, and emits the snapshot', async () => {
    expect(await runBackfill(ctx)).toBe(true);

    expect(d1.applied.length).toBeGreaterThan(0);
    expect(d1.commands.some((sql) => sql.includes('published_run_id = 7'))).toBe(true);

    // Every segment is applied before the pointer moves.
    expect(d1.trace.indexOf('apply')).toBeLessThan(d1.trace.indexOf('command:publish'));
  });

  it('writes a snapshot the web build can read, with the measured corpus total', async () => {
    await runBackfill(ctx);

    const manifest = await readJson('manifest.json');
    expect(manifest.snapshot_version).toBe(1);
    expect(manifest.run_id).toBe(7);
    expect(manifest.source).toBe('snapshot');
    expect(manifest.fixture).toBe(false);
    expect((manifest.corpus as Record<string, Record<string, unknown>>).deduplicated).toEqual({
      words: CORPUS_WORDS,
      status: 'rolled_up',
      reason: null,
      method: 'descendant_sum',
    });

    for (const file of [
      'routes.json',
      'titles.json',
      'agencies.json',
      'shared-jurisdiction.json',
      'data-quality.json',
      'amendments.json',
      join('agency', 'administrative-committee-of-the-federal-register.json'),
      join('title', '1.json'),
      join('title', '1', 'chapter', 'I.json'),
      join('title', '1', 'part', '1.json'),
    ]) {
      expect(existsSync(join(workDir, 'snapshot', file)), file).toBe(true);
    }
  });

  it('points a part page at a content file that actually exists', async () => {
    // The contract's hardest rule for an exporter: never emit a `content_key` naming a file
    // that is not there. The old key was `parts/…/part-1.html`, which the loader then opened as
    // `content/parts/…/part-1.html.html` — every part page in every deploy.
    await runBackfill(ctx);

    const part = await readJson(join('title', '1', 'part', '1.json'));
    expect(part.content_key).toBe('parts/title-1/chapter-I/part-1');
    expect(part.content_unavailable_reason).toBeNull();
    expect(
      existsSync(join(workDir, 'snapshot', 'content', 'parts/title-1/chapter-I/part-1.html')),
    ).toBe(true);

    // The staging directory is emptied once its contents are promoted.
    expect(existsSync(join(workDir, 'snapshot', '.staging-run-7'))).toBe(false);
  });

  it('writes the full amendment history a backfill fetched', async () => {
    await runBackfill(ctx);
    const sql = await Promise.all(d1.applied.map((path) => readFile(path, 'utf8')));
    const joined = sql.join('\n');
    // runBackfill used to write no amendment rows at all, so every timeline was empty until
    // enough nightly deltas had accumulated.
    expect(joined).toContain('INSERT INTO amendment');
    expect(joined).toContain('INSERT INTO title_watermark');
  });
});
