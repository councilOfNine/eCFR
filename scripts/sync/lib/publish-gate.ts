/**
 * The publish gate.
 *
 * `app_meta.published_run_id` is what the site and the API read. A run that finishes is not
 * automatically a run that is fit to serve, and keeping those two states separate is what
 * makes the failure mode "stale but correct" instead of "fresh and wrong".
 *
 * Every check compares the run that just finished against the last PUBLISHED one, and every
 * verdict carries the actual numbers. That is deliberate: a gate that says "refused: word
 * count moved too much" wastes the on-call engineer's first ten minutes, and a gate whose
 * output cannot be pasted into an incident note gets disabled within a month.
 *
 * The thresholds encode measured behaviour, not taste. eCFR publishes on business days with a
 * median of 48 changed sections a day against a 105,096,026-word corpus; a legitimate night
 * moves the total by a rounding error. 5% is roughly a thousand times a normal night, which
 * makes it a detector for pipeline faults (a title that silently failed to parse, a rollup
 * regression) rather than for real regulatory activity.
 */

import { GateCheckId } from './enums.js';
import { GATE_NOT_ADVANCED, gatePassHeader, gateRefusedHeader } from './messages.js';

// Re-exported because the check ids are this module's public vocabulary; they live in
// enums.ts with the other closed unions the pipeline dispatches on.
export type { GateCheckId };

export interface GateStats {
  /** Corpus deduplicated word total. Null when it could not be computed at all. */
  totalWords: number | null;
  agencyCount: number;
  titleCount: number;
  /** structure_node rows with a NULL word_count. */
  uncountedNodes: number;
}

export interface GateInput {
  current: GateStats;
  /** Null on the very first publish. Delta checks are skipped and say so. */
  previous: GateStats | null;
  /** Titles whose SQL was partly emitted before they failed. Any entry is disqualifying. */
  partiallyWrittenTitles: readonly number[];
  fetchFailures: number;
  parseFailures: number;
}

export interface GateCheck {
  id: GateCheckId;
  ok: boolean;
  /** One line, with the numbers in it, suitable for a CI log or an alert body. */
  detail: string;
  observed: number | null;
  baseline: number | null;
  threshold: number | null;
  /** True when there was no baseline to compare against, so the check could not run. */
  skipped: boolean;
}

export interface GateVerdict {
  ok: boolean;
  checks: GateCheck[];
  /** Multi-line, ready to print. Leads with the verdict, then the failing checks. */
  summary: string;
}

/** Fractional change in the corpus word total that blocks publication. */
export const MAX_WORD_DRIFT = 0.05;

/** Fractional growth in unknown nodes that blocks publication. */
export const MAX_UNCOUNTED_GROWTH = 0.1;

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function evaluatePublishGate(input: GateInput): GateVerdict {
  const { current, previous } = input;
  const checks: GateCheck[] = [];

  // A corpus total that cannot be computed means at least one agency has an unresolvable
  // scope propagating all the way up. That is a legitimate state to STORE — it is how the
  // schema represents honest ignorance — but not one to promote to the dashboard headline.
  checks.push({
    id: GateCheckId.TotalWordsComputable,
    ok: current.totalWords !== null,
    detail:
      current.totalWords === null
        ? 'corpus deduplicated total is NULL: at least one claimed scope could not be measured'
        : `corpus deduplicated total is ${current.totalWords.toLocaleString('en-US')} words`,
    observed: current.totalWords,
    baseline: null,
    threshold: null,
    skipped: false,
  });

  if (previous === null) {
    for (const id of [
      GateCheckId.TotalWordsDrift,
      GateCheckId.AgencyCountDrop,
      GateCheckId.TitleCountDrop,
      GateCheckId.UncountedGrowth,
    ]) {
      checks.push({
        id,
        ok: true,
        detail: 'no previously published run to compare against (first publish)',
        observed: null,
        baseline: null,
        threshold: null,
        skipped: true,
      });
    }
  } else {
    // Word drift. Guarded against a null on either side and against a zero baseline, which
    // would otherwise produce Infinity and refuse the first real publish after a bad run.
    if (current.totalWords === null || previous.totalWords === null) {
      checks.push({
        id: GateCheckId.TotalWordsDrift,
        ok: false,
        detail: `cannot compare word totals: current=${current.totalWords ?? 'NULL'} previous=${previous.totalWords ?? 'NULL'}`,
        observed: current.totalWords,
        baseline: previous.totalWords,
        threshold: MAX_WORD_DRIFT,
        skipped: false,
      });
    } else if (previous.totalWords === 0) {
      checks.push({
        id: GateCheckId.TotalWordsDrift,
        ok: true,
        detail: `previous published total was 0 words; drift check not meaningful (current ${current.totalWords.toLocaleString('en-US')})`,
        observed: current.totalWords,
        baseline: 0,
        threshold: MAX_WORD_DRIFT,
        skipped: true,
      });
    } else {
      const drift = (current.totalWords - previous.totalWords) / previous.totalWords;
      checks.push({
        id: GateCheckId.TotalWordsDrift,
        ok: Math.abs(drift) <= MAX_WORD_DRIFT,
        detail: `corpus words moved ${pct(drift)} (${previous.totalWords.toLocaleString('en-US')} -> ${current.totalWords.toLocaleString('en-US')}); limit ±${pct(MAX_WORD_DRIFT)}`,
        observed: current.totalWords,
        baseline: previous.totalWords,
        threshold: MAX_WORD_DRIFT,
        skipped: false,
      });
    }

    // Counts may only go up or stay flat. An agency or title disappearing is either a real
    // upstream reorganisation — which deserves a human looking at it — or a fetch that
    // returned a truncated list, which is the far more likely explanation at 3am.
    checks.push({
      id: GateCheckId.AgencyCountDrop,
      ok: current.agencyCount >= previous.agencyCount,
      detail: `agencies ${previous.agencyCount} -> ${current.agencyCount}${
        current.agencyCount < previous.agencyCount
          ? ` (dropped ${previous.agencyCount - current.agencyCount})`
          : ''
      }`,
      observed: current.agencyCount,
      baseline: previous.agencyCount,
      threshold: 0,
      skipped: false,
    });

    checks.push({
      id: GateCheckId.TitleCountDrop,
      ok: current.titleCount >= previous.titleCount,
      detail: `titles ${previous.titleCount} -> ${current.titleCount}${
        current.titleCount < previous.titleCount
          ? ` (dropped ${previous.titleCount - current.titleCount})`
          : ''
      }`,
      observed: current.titleCount,
      baseline: previous.titleCount,
      threshold: 0,
      skipped: false,
    });

    // Growth in unknowns is the signal that a title parsed badly. It is checked separately
    // from word drift because the two fail independently: a title that 504s wholesale barely
    // moves the total if it is small, but turns thousands of nodes unknown.
    if (previous.uncountedNodes === 0) {
      const ok = current.uncountedNodes === 0;
      checks.push({
        id: GateCheckId.UncountedGrowth,
        ok,
        detail: ok
          ? 'uncounted nodes still 0'
          : `uncounted nodes grew from 0 to ${current.uncountedNodes}`,
        observed: current.uncountedNodes,
        baseline: 0,
        threshold: MAX_UNCOUNTED_GROWTH,
        skipped: false,
      });
    } else {
      const growth = (current.uncountedNodes - previous.uncountedNodes) / previous.uncountedNodes;
      checks.push({
        id: GateCheckId.UncountedGrowth,
        ok: growth <= MAX_UNCOUNTED_GROWTH,
        detail: `uncounted nodes ${previous.uncountedNodes} -> ${current.uncountedNodes} (${pct(growth)}); limit +${pct(MAX_UNCOUNTED_GROWTH)}`,
        observed: current.uncountedNodes,
        baseline: previous.uncountedNodes,
        threshold: MAX_UNCOUNTED_GROWTH,
        skipped: false,
      });
    }
  }

  // A partially written title is the one failure that cannot be reasoned about from
  // aggregates. Its rows are a mixture of this run's and the previous run's, so its own
  // roll-ups are internally inconsistent even when every other number looks plausible.
  const partial = input.partiallyWrittenTitles;
  checks.push({
    id: GateCheckId.PartialTitles,
    ok: partial.length === 0,
    detail:
      partial.length === 0
        ? `no partially written titles (${input.fetchFailures} fetch failure(s), ${input.parseFailures} parse failure(s) — none left a title half-written)`
        : `title(s) ${partial.join(', ')} were left partially written by a mid-unit failure`,
    observed: partial.length,
    baseline: null,
    threshold: 0,
    skipped: false,
  });

  const failed = checks.filter((c) => !c.ok);
  const ok = failed.length === 0;

  const lines = [
    ok
      ? gatePassHeader(checks.length, checks.filter((c) => c.skipped).length)
      : gateRefusedHeader(failed.length, checks.length),
    ...checks.map((c) => `  ${c.ok ? (c.skipped ? '-' : 'ok') : 'FAIL'} ${c.id}: ${c.detail}`),
  ];
  if (!ok) {
    lines.push('', GATE_NOT_ADVANCED);
  }

  return { ok, checks, summary: lines.join('\n') };
}
