/**
 * The diff engine.
 *
 * The important tests here are the property tests: for thousands of random inputs, the edit
 * script must reconstruct both sides exactly, and its number of `equal` edits must equal the
 * true LCS length computed by a straightforward O(mn) reference. Minimality is what
 * distinguishes a correct Myers implementation from one that merely produces a valid diff, and
 * an off-by-one in the middle-snake overlap check produces exactly the latter.
 */

import { describe, expect, it } from 'vitest';
import { DIFF_MAX_LINES } from '../src/constants/config.js';
import { diffLines, type Edit, toHunks } from '../src/diff/myers.js';

/** O(mn) reference. Only ever run on tiny inputs — this is the thing Myers replaces. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  let previous = new Int32Array(b.length + 1);
  let current = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] =
        a[i - 1] === b[j - 1]
          ? (previous[j - 1] as number) + 1
          : Math.max(previous[j] as number, current[j - 1] as number);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[b.length] as number;
}

function reconstruct(edits: readonly Edit[]): { old: string[]; next: string[] } {
  const oldSide: string[] = [];
  const newSide: string[] = [];
  for (const edit of edits) {
    if (edit.op === 'equal') {
      oldSide.push(edit.text);
      newSide.push(edit.text);
    } else if (edit.op === 'delete') {
      oldSide.push(edit.text);
    } else {
      newSide.push(edit.text);
    }
  }
  return { old: oldSide, next: newSide };
}

/** Deterministic PRNG so a failure is reproducible from the seed in the test name. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

describe('diffLines', () => {
  it('handles both sides empty', () => {
    expect(diffLines([], [])).toEqual([]);
  });

  it('reports a pure insertion when the old side is empty', () => {
    const edits = diffLines([], ['a', 'b']);
    expect(edits.map((e) => e.op)).toEqual(['insert', 'insert']);
    expect(edits.map((e) => e.newIndex)).toEqual([0, 1]);
    expect(edits.every((e) => e.oldIndex === null)).toBe(true);
  });

  it('reports a pure deletion when the new side is empty', () => {
    const edits = diffLines(['a', 'b'], []);
    expect(edits.map((e) => e.op)).toEqual(['delete', 'delete']);
    expect(edits.every((e) => e.newIndex === null)).toBe(true);
  });

  it('reports no changes for identical input', () => {
    const lines = ['one', 'two', 'three'];
    const edits = diffLines(lines, lines);
    expect(edits.every((e) => e.op === 'equal')).toBe(true);
    expect(edits).toHaveLength(3);
  });

  it('finds a single-line replacement in the middle of a long document', () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[100] = 'line 100 (amended)';

    const edits = diffLines(before, after);
    const changed = edits.filter((e) => e.op !== 'equal');
    expect(changed).toHaveLength(2);
    expect(changed.map((e) => e.op).sort()).toEqual(['delete', 'insert']);
  });

  for (const seed of [1, 7, 12345, 99991]) {
    it(`is minimal and reconstructable over random inputs (seed ${seed})`, () => {
      const random = makeRandom(seed);
      for (let trial = 0; trial < 500; trial++) {
        // A tiny alphabet is the adversarial case: lots of equal lines means lots of
        // candidate paths, which is where an incorrect overlap check picks a longer one.
        const alphabet = 1 + Math.floor(random() * 4);
        const a = Array.from({ length: Math.floor(random() * 18) }, () =>
          String.fromCharCode(97 + Math.floor(random() * alphabet)),
        );
        const b = Array.from({ length: Math.floor(random() * 18) }, () =>
          String.fromCharCode(97 + Math.floor(random() * alphabet)),
        );

        const edits = diffLines(a, b);
        const { old: oldSide, next: newSide } = reconstruct(edits);

        expect(oldSide, `old side for ${a.join('')} -> ${b.join('')}`).toEqual(a);
        expect(newSide, `new side for ${a.join('')} -> ${b.join('')}`).toEqual(b);

        const equals = edits.filter((e) => e.op === 'equal').length;
        expect(equals, `minimality for ${a.join('')} -> ${b.join('')}`).toBe(lcsLength(a, b));
      }
    });
  }

  it('emits strictly increasing, gap-free indices on both sides', () => {
    const random = makeRandom(4242);
    const a = Array.from({ length: 120 }, () => String(Math.floor(random() * 8)));
    const b = Array.from({ length: 140 }, () => String(Math.floor(random() * 8)));

    let expectedOld = 0;
    let expectedNew = 0;
    for (const edit of diffLines(a, b)) {
      if (edit.oldIndex !== null) expect(edit.oldIndex).toBe(expectedOld++);
      if (edit.newIndex !== null) expect(edit.newIndex).toBe(expectedNew++);
    }
    expect(expectedOld).toBe(a.length);
    expect(expectedNew).toBe(b.length);
  });

  /**
   * The predecessor's O(m*n) table needed 15.95 GB for 26 CFR 1.72-9 (46,119 lines) and
   * aborted the V8 isolate. This asserts the replacement handles the worst case at the cap —
   * two completely disjoint documents, so the edit distance is maximal — in bounded time and
   * without recursing.
   */
  it(`survives ${DIFF_MAX_LINES} completely disjoint lines on both sides`, () => {
    const a = Array.from({ length: DIFF_MAX_LINES }, (_, i) => `old ${i}`);
    const b = Array.from({ length: DIFF_MAX_LINES }, (_, i) => `new ${i}`);

    const started = performance.now();
    const edits = diffLines(a, b);
    const elapsed = performance.now() - started;

    expect(edits).toHaveLength(2 * DIFF_MAX_LINES);
    expect(edits.filter((e) => e.op === 'equal')).toHaveLength(0);
    // Generous: the point is "seconds, not a heap abort", not a microbenchmark.
    expect(elapsed).toBeLessThan(10_000);
  });

  it('is fast on the realistic case: a long document with scattered edits', () => {
    const before = Array.from({ length: DIFF_MAX_LINES }, (_, i) => `paragraph ${i}`);
    const after = [...before];
    for (let i = 0; i < after.length; i += 50) after[i] = `paragraph ${i} (revised)`;

    const started = performance.now();
    const summary = toHunks(diffLines(before, after), 3);
    const elapsed = performance.now() - started;

    expect(summary.added).toBe(100);
    expect(summary.removed).toBe(100);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe('toHunks', () => {
  it('returns no hunks when nothing changed', () => {
    const summary = toHunks(diffLines(['a', 'b'], ['a', 'b']), 3);
    expect(summary.hunks).toEqual([]);
    expect(summary.added).toBe(0);
    expect(summary.removed).toBe(0);
  });

  it('collapses a one-line change in a long document to a single small hunk', () => {
    const before = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[250] = 'line 250 amended';

    const summary = toHunks(diffLines(before, after), 3);
    expect(summary.hunks).toHaveLength(1);
    // 3 lines of context either side, plus the removal and the insertion.
    expect(summary.hunks[0]?.lines.length).toBeLessThanOrEqual(8);
    expect(summary.added).toBe(1);
    expect(summary.removed).toBe(1);
  });

  it('merges changes whose context windows overlap', () => {
    const before = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const after = [...before];
    after[10] = 'changed 10';
    after[12] = 'changed 12';
    after[30] = 'changed 30';

    const summary = toHunks(diffLines(before, after), 3);
    // 10 and 12 are within one context window of each other; 30 is not.
    expect(summary.hunks).toHaveLength(2);
  });

  it('carries 1-based line numbers on both sides', () => {
    const summary = toHunks(diffLines(['a', 'b', 'c'], ['a', 'x', 'c']), 1);
    const hunk = summary.hunks[0];
    expect(hunk).toBeDefined();
    const context = hunk?.lines.filter((l) => l.type === 'context') ?? [];
    expect(context[0]?.oldLine).toBe(1);
    expect(context[0]?.newLine).toBe(1);

    const removed = hunk?.lines.find((l) => l.type === 'remove');
    expect(removed?.oldLine).toBe(2);
    expect(removed?.newLine).toBeNull();

    const added = hunk?.lines.find((l) => l.type === 'add');
    expect(added?.newLine).toBe(2);
    expect(added?.oldLine).toBeNull();
  });
});
