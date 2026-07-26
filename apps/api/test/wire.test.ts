/**
 * The serialisation boundary, tested as the rules it enforces.
 *
 * `src/wire.ts` is the only place in this Worker that can turn a stored integer into a number
 * on the wire. Two of those rules were wrong and are pinned here so they cannot go wrong
 * quietly again:
 *
 *   1. a subtree total's reason has to be about the SUBTREE. It used to be derived from the
 *      agency's own reference counters, so a row whose own scopes were all measured perfectly
 *      published "0 of 3 claimed scopes have no measured word count" — a reason that names the
 *      wrong cause and sends a reader to audit an agency that is fine.
 *
 *   2. a per-agency share of a shared scope has to use the SAME division the stored
 *      deduplicated totals used, and has to carry a status. It used to be `words / count`: a
 *      bare unstatused float, computed by different arithmetic from the totals it claimed to
 *      explain, so summing the published shares did not reconcile with the published totals.
 */

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { evenShares, rollupWordCount, scopeShares, subtreeRollupWordCount } from '../src/wire.js';

describe('rollupWordCount', () => {
  it('never turns a NULL into a zero', () => {
    const unknown = rollupWordCount(null, 1, 3);
    expect(unknown.words).toBeNull();
    expect(unknown.status).toBe('not_computed');
    expect(unknown.reason).toBe('2 of 3 claimed scopes have no measured word count');
  });

  it('labels a known rollup as a sum over descendants, never as a parse', () => {
    expect(rollupWordCount(300, 1, 1)).toEqual({
      words: 300,
      status: 'rolled_up',
      reason: null,
      method: 'descendant_sum',
    });
  });
});

describe('subtreeRollupWordCount', () => {
  const counters = (childrenCount: number, refsCounted: number, refsTotal: number) => ({
    childrenCount,
    refsCounted,
    refsTotal,
  });

  it('passes a known total through unchanged', () => {
    expect(subtreeRollupWordCount(1200, counters(4, 3, 3))).toEqual({
      words: 1200,
      status: 'rolled_up',
      reason: null,
      method: 'descendant_sum',
    });
  });

  it('blames descendants, not the agency, when the agency’s own scopes are all measured', () => {
    // THE BUG. Own counters say 3 of 3 counted; the subtree total is still NULL because a
    // child agency has an unmeasured scope. The old derivation printed "0 of 3 claimed scopes
    // have no measured word count", which is both false and actively misleading.
    const reason = subtreeRollupWordCount(null, counters(4, 3, 3)).reason ?? '';

    expect(reason).not.toMatch(/^0 of 3/);
    expect(reason).toContain('4 child agencies');
    expect(reason).toContain('own scopes are all measured');
    expect(reason).toContain('descendant');
  });

  it('still mentions the agency’s own gap when it has one', () => {
    const reason = subtreeRollupWordCount(null, counters(2, 1, 4)).reason ?? '';
    expect(reason).toContain('2 child agencies');
    expect(reason).toContain("3 of this agency's own 4 claimed scopes are unmeasured");
  });

  it('says "child agency" for exactly one child', () => {
    const reason = subtreeRollupWordCount(null, counters(1, 0, 1)).reason ?? '';
    expect(reason).toContain('1 child agency');
    expect(reason).not.toContain('child agencies');
  });

  it('falls back to the plain derivation for a childless agency, whose subtree is itself', () => {
    // No descendants means no other explanation is possible, so the own-counter reason is
    // exact rather than merely available.
    expect(subtreeRollupWordCount(null, counters(0, 1, 3))).toEqual(rollupWordCount(null, 1, 3));
  });

  it('never emits a zero for an unknown subtree', () => {
    for (const c of [counters(0, 0, 0), counters(3, 0, 0), counters(5, 2, 9)]) {
      const out = subtreeRollupWordCount(null, c);
      expect(out.words).toBeNull();
      expect(out.reason).toBeTruthy();
    }
  });
});

describe('evenShares', () => {
  it('conserves the total exactly, for every remainder', () => {
    for (let words = 0; words <= 200; words++) {
      for (let k = 1; k <= 7; k++) {
        const shares = evenShares(words, k);
        expect(shares).toHaveLength(k);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(words);
        // Every share is floor(w/k) or one more, and the extras come first.
        const base = Math.floor(words / k);
        expect(new Set(shares.map((s) => s - base))).toEqual(
          new Set(words % k === 0 ? [0] : [0, 1]),
        );
        expect([...shares].sort((a, b) => b - a)).toEqual(shares);
      }
    }
  });

  it('gives the remainder to the first claimants in canonical order', () => {
    expect(evenShares(301, 2)).toEqual([151, 150]);
    expect(evenShares(10, 6)).toEqual([2, 2, 2, 2, 1, 1]);
    expect(evenShares(5, 6)).toEqual([1, 1, 1, 1, 1, 0]);
  });

  it('returns nothing rather than dividing by zero', () => {
    expect(evenShares(100, 0)).toEqual([]);
    expect(evenShares(100, -1)).toEqual([]);
  });

  /**
   * The rule has two implementations and they must not drift.
   *
   * scripts/sync/lib/rollup.ts computes the shares that become
   * `agency_rollup.deduplicated_word_count`; src/wire.ts recomputes them for /v1/overlap so a
   * reader can check the totals. If those two ever disagree, the published shares stop
   * reconciling with the published totals and nobody finds out from a passing test.
   *
   * The pipeline cannot simply be imported here — `scripts/` is not a pnpm workspace member,
   * so a bare `@ecfr-atlas/core` inside it has nothing to resolve against from this package.
   * Comparing the function bodies as normalised text is the next best thing, and it fails
   * loudly and specifically the moment either side is edited.
   */
  it('matches the pipeline implementation character for character', async () => {
    const pipelineSource = await readFile(
      new URL('../../../scripts/sync/lib/rollup.ts', import.meta.url),
      'utf8',
    );
    const oursSource = await readFile(new URL('../src/wire.ts', import.meta.url), 'utf8');

    const theirs = normalisedBody(pipelineSource, 'evenShares');
    const ours = normalisedBody(oursSource, 'evenShares');

    expect(theirs, 'scripts/sync/lib/rollup.ts no longer exports evenShares').not.toBe('');
    expect(
      ours,
      'src/wire.ts and scripts/sync/lib/rollup.ts implement the division rule differently. ' +
        'The published per-agency shares would no longer sum to the published deduplicated ' +
        'totals. Change both, or neither.',
    ).toBe(theirs);
  });
});

/** Body of `export function <name>(...)`, brace-balanced, with all whitespace collapsed. */
function normalisedBody(source: string, name: string): string {
  const signature = `export function ${name}(`;
  const start = source.indexOf(signature);
  if (start === -1) return '';

  const open = source.indexOf('{', start + signature.length);
  if (open === -1) return '';

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0)
        return source
          .slice(open + 1, i)
          .replace(/\s+/g, ' ')
          .trim();
    }
  }
  return '';
}

describe('scopeShares', () => {
  const claimants = ['indian-health-service', 'public-health-service'];

  it('gives every claimant a statused share that sums to the scope', () => {
    const shares = scopeShares(301, claimants, 2);
    expect(shares.map((s) => s.words)).toEqual([151, 150]);
    for (const share of shares) {
      // Arithmetic over a measured value, never a fresh observation.
      expect(share.status).toBe('rolled_up');
      expect(share.method).toBe('descendant_sum');
      expect(share.reason).toBeNull();
    }
  });

  it('refuses to publish a share of an unknown', () => {
    const shares = scopeShares(null, claimants, 2);
    expect(shares).toHaveLength(2);
    for (const share of shares) {
      expect(share.words).toBeNull();
      expect(share.status).toBe('not_computed');
      expect(share.reason).toMatch(/share of an unknown is an unknown/);
      // The specific regression this whole codebase exists to prevent.
      expect(share.words).not.toBe(0);
    }
  });

  it('refuses to attribute anything when the claimant list and the count disagree', () => {
    // Shares are positional. If the stored order cannot be trusted, neither can the mapping
    // from share to agency, and a confidently-attributed wrong number is worse than an honest
    // unknown.
    const shares = scopeShares(300, claimants, 3);
    for (const share of shares) {
      expect(share.words).toBeNull();
      expect(share.reason).toContain('3 claimants but names 2');
    }
  });

  it('returns nothing for a scope with no claimants at all', () => {
    expect(scopeShares(300, [], 0)).toEqual([]);
  });
});
