/**
 * The sentences an operator actually reads.
 *
 * A refused publish gets debugged from two artefacts: the CI log and the `sync_run.message`
 * column. Both quote the strings below, and runbooks and incident notes grep for them — so
 * they live in one place, where a wording change is a visible one-line diff instead of a
 * drift between call sites that breaks somebody's grep at 3am.
 *
 * What belongs here: gate verdict headers, refusal and abort explanations, checkpoint hints —
 * anything a human acts on. What does not: internal debug labels and log lines whose value is
 * the structured fields next to them. Centralising those would add a layer of indirection to
 * strings nobody searches for.
 *
 * `publish-gate.test.ts` asserts on several of these verbatim ('published_run_id was NOT
 * advanced', the PASS/REFUSED headers). Changing wording here means changing the test — which
 * is the point: the wording is part of the operator contract, and the test is what makes that
 * contract explicit.
 */

// ─── publish gate ────────────────────────────────────────────────────────────

export function gatePassHeader(totalChecks: number, skippedChecks: number): string {
  return `PUBLISH GATE: PASS (${totalChecks} checks, ${skippedChecks} skipped)`;
}

export function gateRefusedHeader(failedChecks: number, totalChecks: number): string {
  return `PUBLISH GATE: REFUSED (${failedChecks} of ${totalChecks} checks failed)`;
}

/** The sentence that tells the on-call engineer nothing served has changed. */
export const GATE_NOT_ADVANCED =
  'published_run_id was NOT advanced. The site continues to serve the last published run.';

export const GATE_REFUSED_DISCARDING =
  'publish gate refused; discarding this run rather than applying it';

export const BASELINE_UNREADABLE =
  'could not read publish-gate baseline; treating this as a first publish';

// ─── apply phase ─────────────────────────────────────────────────────────────

export const APPLY_HALTED = 'apply failed; the remaining segments are NOT applied';

/** The gate passed and the apply then broke — the one refusal the gate itself cannot issue. */
export const PARTIAL_APPLY_REFUSAL = 'refusing to publish: segments were only partly applied';

// ─── run closure (lands in sync_run.message, the audit trail) ────────────────

export const RUN_PUBLISHED = 'published';

export const RUN_REFUSED_BY_GATE = 'completed but refused by the publish gate';

/**
 * Also the exception message of ImportInProgressError. eCFR mid-import produces a
 * self-consistent but wrong corpus, so the run aborts (exit 75, EX_TEMPFAIL) rather than
 * capturing it — this string is how the scheduler's log says "retry later, nothing is wrong".
 */
export const IMPORT_IN_PROGRESS_ABORT =
  'eCFR reports import_in_progress=true; aborting rather than capturing a partial corpus';

// ─── checkpoints ─────────────────────────────────────────────────────────────

export const CHECKPOINT_MATCH = 'skipping; checkpoint matches';

export const CHECKPOINT_SEGMENTS_MISSING =
  'checkpoint names segments that no longer exist; reprocessing the title';
