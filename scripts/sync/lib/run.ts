/**
 * sync_run lifecycle.
 *
 * Every row this pipeline writes carries a run id, and the run row is the audit trail that
 * makes a published number traceable: given a word count on the dashboard you can find the
 * run that produced it, when it started, what it fetched, and how many fetches failed.
 *
 * The id is allocated by D1 rather than guessed, because the SQL is generated offline and
 * the id is embedded in tens of thousands of literals before anything is applied. Getting it
 * from `INSERT ... RETURNING id` costs one round trip and removes the whole class of
 * "two runs picked the same id" bugs that a client-side MAX(id)+1 would introduce.
 *
 * A run that is never closed stays `running` forever, which is why `abort()` is wired to
 * process signals: an operator cancelling a GitHub Actions job should leave a row that says
 * `aborted`, not one that says the sync is still going three weeks later.
 */

import type { D1 } from './d1.js';
import type { RunKind } from './enums.js';
import { RunStatus, TitleStatus } from './enums.js';
import type { Logger } from './log.js';
import { sqlInt, sqlString, sqlValue } from './sql.js';

// Re-exported so callers keep importing the run vocabulary from the module that owns the run
// lifecycle; enums.ts is where the values live because the D1 CHECK constraints freeze them.
export type { RunKind, RunStatus };

export interface RunCounters {
  titlesTouched: number;
  nodesUpserted: number;
  nodesPruned: number;
  fetchFailures: number;
  parseFailures: number;
}

/**
 * Per-title outcome, tracked separately from the aggregate counters because the publish gate
 * needs to know not just "were there failures" but "did a failure leave a specific title
 * half-written". A title that failed before any of its SQL was emitted is recoverable; one
 * that failed midway is the case that must block publication.
 */
export interface TitleOutcome {
  title: number;
  status: TitleStatus;
  nodesWritten: number;
  fetchFailures: number;
  parseFailures: number;
  reason?: string;
}

export class SyncRun {
  readonly id: number;
  readonly kind: RunKind;
  readonly startedAt: string;

  readonly counters: RunCounters = {
    titlesTouched: 0,
    nodesUpserted: 0,
    nodesPruned: 0,
    fetchFailures: 0,
    parseFailures: 0,
  };

  #titleOutcomes = new Map<number, TitleOutcome>();
  #d1: D1;
  #log: Logger;
  #sourceDate: string | null = null;
  #closed = false;
  #detachSignals: (() => void) | null = null;
  #dryRun = false;

  private constructor(id: number, kind: RunKind, startedAt: string, d1: D1, log: Logger) {
    this.id = id;
    this.kind = kind;
    this.startedAt = startedAt;
    this.#d1 = d1;
    this.#log = log.child(`run#${id}`);
  }

  /**
   * Sentinel id for a dry run. Negative so it can never collide with an AUTOINCREMENT id, and
   * so a stray `last_seen_run_id = -1` in any future write would be obvious rather than
   * plausible.
   */
  static readonly DRY_RUN_ID = -1;

  /**
   * `dryRun` skips the INSERT entirely.
   *
   * This used to open a real row regardless, which broke the flag's only promise: a dry run is
   * what an operator uses to check credentials and connectivity BEFORE touching production, so
   * it must not be the thing that writes to production. Three rows — including one orphaned
   * `running` row from a killed process — landed in the live sync_run table from runs that
   * reported writing nothing.
   */
  static async open(kind: RunKind, d1: D1, log: Logger, dryRun = false): Promise<SyncRun> {
    const startedAt = new Date().toISOString();

    if (dryRun) {
      const run = new SyncRun(SyncRun.DRY_RUN_ID, kind, startedAt, d1, log);
      run.#dryRun = true;
      run.#installSignalHandlers();
      log.info('sync run opened (dry run — nothing will be written)', { kind, startedAt });
      return run;
    }

    const row = await d1.queryOne<{ id: number }>(
      `INSERT INTO sync_run (kind, status, started_at) VALUES (${sqlString(kind)}, ${sqlString(RunStatus.Running)}, ${sqlString(startedAt)}) RETURNING id;`,
      'open-run',
    );
    if (!row || typeof row.id !== 'number') {
      throw new Error('sync_run INSERT ... RETURNING id produced no id; cannot proceed');
    }
    const run = new SyncRun(row.id, kind, startedAt, d1, log);
    run.#installSignalHandlers();
    log.info('sync run opened', { id: row.id, kind, startedAt });
    return run;
  }

  get sourceDate(): string | null {
    return this.#sourceDate;
  }

  /** The eCFR snapshot date this run captured. Recorded once it is known from titles.json. */
  setSourceDate(date: string): void {
    this.#sourceDate = date;
  }

  recordTitle(outcome: TitleOutcome): void {
    this.#titleOutcomes.set(outcome.title, outcome);
    if (outcome.status !== TitleStatus.Skipped) this.counters.titlesTouched += 1;
    this.counters.nodesUpserted += outcome.nodesWritten;
    this.counters.fetchFailures += outcome.fetchFailures;
    this.counters.parseFailures += outcome.parseFailures;
  }

  /**
   * Downgrade a title to `partial` after the fact.
   *
   * Its SQL is generated and applied in two separate phases now — generated per title, applied
   * in one pass once the publish gate has accepted the run — so the moment a title becomes
   * half-written is no longer the moment it was processed. Counters are untouched: this
   * changes what is known about an outcome already recorded, not how much work was done.
   */
  markPartial(titleNumber: number, reason: string): void {
    const existing = this.#titleOutcomes.get(titleNumber);
    this.#titleOutcomes.set(titleNumber, {
      title: titleNumber,
      status: TitleStatus.Partial,
      nodesWritten: existing?.nodesWritten ?? 0,
      fetchFailures: existing?.fetchFailures ?? 0,
      parseFailures: existing?.parseFailures ?? 0,
      reason,
    });
  }

  get titleOutcomes(): readonly TitleOutcome[] {
    return [...this.#titleOutcomes.values()].sort((a, b) => a.title - b.title);
  }

  /** Titles whose SQL was partly emitted before they failed. The publish gate blocks on these. */
  get partiallyWrittenTitles(): readonly number[] {
    return this.titleOutcomes.filter((t) => t.status === TitleStatus.Partial).map((t) => t.title);
  }

  recordPruned(count: number): void {
    this.counters.nodesPruned += count;
  }

  async succeed(message?: string): Promise<void> {
    await this.#close(RunStatus.Succeeded, message);
  }

  async fail(error: unknown): Promise<void> {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await this.#close(RunStatus.Failed, message.slice(0, 2000));
  }

  async abort(reason: string): Promise<void> {
    await this.#close(RunStatus.Aborted, reason.slice(0, 2000));
  }

  async #close(status: RunStatus, message?: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachSignals?.();

    // No row was inserted, so there is nothing to UPDATE. Still log the outcome: the operator
    // running a dry run wants the same counters and the same verdict, just no side effects.
    if (this.#dryRun) {
      this.#log.info('sync run closed (dry run — nothing written)', { status, ...this.counters });
      return;
    }

    const sql = [
      'UPDATE sync_run SET',
      `  status = ${sqlString(status)},`,
      `  finished_at = ${sqlString(new Date().toISOString())},`,
      `  source_date = ${sqlValue(this.#sourceDate)},`,
      `  titles_touched = ${sqlInt(this.counters.titlesTouched)},`,
      `  nodes_upserted = ${sqlInt(this.counters.nodesUpserted)},`,
      `  nodes_pruned = ${sqlInt(this.counters.nodesPruned)},`,
      `  fetch_failures = ${sqlInt(this.counters.fetchFailures)},`,
      `  parse_failures = ${sqlInt(this.counters.parseFailures)},`,
      `  message = ${sqlValue(message ?? null)}`,
      `WHERE id = ${sqlInt(this.id)};`,
    ].join('\n');

    try {
      await this.#d1.command(sql, 'close-run');
    } catch (error) {
      // Losing the close is bad but not worth masking the original failure that led here.
      this.#log.error('failed to close sync_run row', {
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.#log.info('sync run closed', { status, ...this.counters });
  }

  /**
   * Advance the published pointer. Called only after the publish gate returns ok — it is a
   * separate method rather than part of `succeed()` so that "the run finished" and "the run
   * is fit to serve" stay distinguishable in the data.
   */
  async publish(): Promise<void> {
    if (this.#dryRun) {
      this.#log.info('would publish (dry run — app_meta unchanged)', {
        sourceDate: this.#sourceDate,
      });
      return;
    }
    await this.#d1.command(
      `UPDATE app_meta SET published_run_id = ${sqlInt(this.id)}, published_at = ${sqlString(new Date().toISOString())}, source_date = ${sqlValue(this.#sourceDate)} WHERE id = 1;`,
      'publish',
    );
    this.#log.info('published', { runId: this.id, sourceDate: this.#sourceDate });
  }

  #installSignalHandlers(): void {
    const onSignal = (signal: NodeJS.Signals): void => {
      void this.abort(`received ${signal}`).finally(() => {
        // 128 + signal number is the conventional shell exit code for a signalled process.
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
    };
    const sigint = (): void => onSignal('SIGINT');
    const sigterm = (): void => onSignal('SIGTERM');
    process.once('SIGINT', sigint);
    process.once('SIGTERM', sigterm);
    this.#detachSignals = () => {
      process.off('SIGINT', sigint);
      process.off('SIGTERM', sigterm);
    };
  }
}
