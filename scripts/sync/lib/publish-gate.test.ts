import { describe, expect, it } from 'vitest';
import type { GateStats } from './publish-gate.js';
import { evaluatePublishGate, MAX_UNCOUNTED_GROWTH, MAX_WORD_DRIFT } from './publish-gate.js';

const baseline: GateStats = {
  totalWords: 105_096_026,
  agencyCount: 316,
  titleCount: 49,
  uncountedNodes: 120,
};

function gate(
  current: Partial<GateStats>,
  extra: Partial<Parameters<typeof evaluatePublishGate>[0]> = {},
) {
  return evaluatePublishGate({
    current: { ...baseline, ...current },
    previous: baseline,
    partiallyWrittenTitles: [],
    fetchFailures: 0,
    parseFailures: 0,
    ...extra,
  });
}

function check(verdict: ReturnType<typeof evaluatePublishGate>, id: string) {
  return verdict.checks.find((c) => c.id === id);
}

describe('publish gate', () => {
  it('passes an ordinary night', () => {
    // Median 48 changed sections a day against 105M words is a rounding error.
    const verdict = gate({ totalWords: 105_098_400 });
    expect(verdict.ok).toBe(true);
    expect(verdict.summary).toContain('PASS');
  });

  it('refuses a word total that moved more than 5%', () => {
    const verdict = gate({ totalWords: Math.round(baseline.totalWords! * 1.06) });
    expect(verdict.ok).toBe(false);
    const drift = check(verdict, 'total_words_drift');
    expect(drift?.ok).toBe(false);
    // The verdict has to carry the numbers, not just the fact.
    expect(drift?.detail).toContain('105,096,026');
    expect(drift?.threshold).toBe(MAX_WORD_DRIFT);
    expect(verdict.summary).toContain('published_run_id was NOT advanced');
  });

  it('refuses a large drop as readily as a large rise', () => {
    expect(gate({ totalWords: Math.round(baseline.totalWords! * 0.9) }).ok).toBe(false);
  });

  it('allows movement exactly at the threshold', () => {
    expect(gate({ totalWords: Math.round(baseline.totalWords! * (1 + MAX_WORD_DRIFT)) }).ok).toBe(
      true,
    );
  });

  it('refuses ANY drop in the agency count', () => {
    const verdict = gate({ agencyCount: 315 });
    expect(verdict.ok).toBe(false);
    expect(check(verdict, 'agency_count_drop')?.detail).toContain('316 -> 315');
  });

  it('refuses ANY drop in the title count', () => {
    const verdict = gate({ titleCount: 48 });
    expect(verdict.ok).toBe(false);
    expect(check(verdict, 'title_count_drop')?.detail).toContain('dropped 1');
  });

  it('allows counts to grow', () => {
    expect(gate({ agencyCount: 320, titleCount: 50 }).ok).toBe(true);
  });

  it('refuses uncounted-node growth above 10%', () => {
    const verdict = gate({ uncountedNodes: 140 });
    expect(verdict.ok).toBe(false);
    expect(check(verdict, 'uncounted_growth')?.threshold).toBe(MAX_UNCOUNTED_GROWTH);
    expect(check(verdict, 'uncounted_growth')?.detail).toContain('120 -> 140');
  });

  it('allows uncounted nodes to shrink', () => {
    expect(gate({ uncountedNodes: 0 }).ok).toBe(true);
  });

  it('refuses when a title was left partially written', () => {
    // The one failure aggregates cannot see: the title's rows mix two runs, so its own
    // roll-ups are internally inconsistent even when every total looks plausible.
    const verdict = gate({}, { partiallyWrittenTitles: [12, 40] });
    expect(verdict.ok).toBe(false);
    expect(check(verdict, 'partial_titles')?.detail).toContain('12, 40');
  });

  it('tolerates fetch failures that did not leave a title half-written', () => {
    const verdict = gate({}, { fetchFailures: 3, parseFailures: 1 });
    expect(verdict.ok).toBe(true);
    expect(check(verdict, 'partial_titles')?.detail).toContain('3 fetch failure(s)');
  });

  it('refuses to publish a NULL corpus total', () => {
    const verdict = gate({ totalWords: null });
    expect(verdict.ok).toBe(false);
    expect(check(verdict, 'total_words_computable')?.ok).toBe(false);
  });

  it('skips delta checks on a first publish rather than failing them', () => {
    const verdict = evaluatePublishGate({
      current: baseline,
      previous: null,
      partiallyWrittenTitles: [],
      fetchFailures: 0,
      parseFailures: 0,
    });
    expect(verdict.ok).toBe(true);
    expect(check(verdict, 'total_words_drift')?.skipped).toBe(true);
    expect(verdict.summary).toContain('4 skipped');
  });

  it('does not divide by zero when the previous total was 0', () => {
    const verdict = evaluatePublishGate({
      current: baseline,
      previous: { ...baseline, totalWords: 0 },
      partiallyWrittenTitles: [],
      fetchFailures: 0,
      parseFailures: 0,
    });
    expect(check(verdict, 'total_words_drift')?.skipped).toBe(true);
    expect(verdict.ok).toBe(true);
  });

  it('does not divide by zero when the previous uncounted node count was 0', () => {
    const verdict = evaluatePublishGate({
      current: { ...baseline, uncountedNodes: 5 },
      previous: { ...baseline, uncountedNodes: 0 },
      partiallyWrittenTitles: [],
      fetchFailures: 0,
      parseFailures: 0,
    });
    expect(check(verdict, 'uncounted_growth')?.ok).toBe(false);
    expect(check(verdict, 'uncounted_growth')?.detail).toContain('0 to 5');
  });
});
