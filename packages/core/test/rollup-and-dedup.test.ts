/**
 * `rollUp()` and the deduplication arithmetic built on it.
 *
 * These two things decide every number on the dashboard, and they fail in opposite directions:
 *
 *   - `rollUp()` fails by UNDER-reporting. Summing the children you happen to have and calling
 *     it a total produces a smaller number that looks exactly like a real one. Nothing
 *     downstream can tell, which is why it returns `unavailable` unless every child is known.
 *
 *   - deduplication fails by OVER-reporting. The predecessor counted a shared scope in full for
 *     every agency claiming it and then SUMMED those into a corpus figure, publishing a CFR
 *     larger than the CFR. 17 of 487 scopes are shared, by 2 to 6 agencies each.
 *
 * The conservation property at the bottom is the one that matters: the deduplicated totals must
 * sum to the total of the distinct scopes, exactly, with nothing lost to rounding.
 */

import { describe, expect, it } from 'vitest';

import {
  counted,
  formatMeasurement,
  fromRow,
  type Measurement,
  notComputed,
  reservedEmpty,
  rolledUp,
  rollUp,
  toRow,
  unavailable,
} from '../src/index.js';

// ─── rollUp ──────────────────────────────────────────────────────────────────

describe('rollUp sums only when it knows everything', () => {
  it('sums measured children exactly', () => {
    const total = rollUp([counted(1_036), counted(126), counted(69), counted(602)]);
    expect(total).toEqual({
      known: true,
      words: 1_833,
      status: 'rolled_up',
      method: 'descendant_sum',
    });
  });

  it('returns unavailable when ANY child is unknown', () => {
    const total = rollUp([counted(1_000), notComputed(), counted(2_000)]);

    expect(total.known).toBe(false);
    expect(total.words).toBeNull();
    // 3,000 is a real sum of real numbers and it is not the answer. Publishing it would
    // under-report the parent by whatever the unknown child holds, undetectably.
    expect(total.words).not.toBe(3_000);
  });

  it('names how many children are missing, so the gap is diagnosable', () => {
    const total = rollUp([counted(1), notComputed(), notComputed(), counted(2)]);
    expect(total.known).toBe(false);
    if (total.known) throw new Error('unreachable');
    expect(total.reason).toMatch(/2 of 4/);
  });

  it('is unavailable for every flavour of unknown child, not just not_computed', () => {
    const unknowns: Measurement[] = [
      unavailable('unavailable_fetch_failed', 'eCFR returned 429 after the retry budget'),
      unavailable('unavailable_parse_failed', 'no DIV5 N="60" in the response'),
      unavailable('unavailable_too_large', '69,598,633 bytes, over the per-node ceiling'),
      notComputed(),
    ];
    for (const unknown of unknowns) {
      expect(rollUp([counted(100), unknown]).known, unknown.status).toBe(false);
    }
  });

  it('reserved_empty children contribute 0 and do NOT spoil the roll-up', () => {
    // The entire reason `reserved_empty` is a known status. 3 CFR Part 102 has seven reserved
    // section ranges among its real sections; if those made the part unknown, most of the CFR
    // would have no total at all.
    const total = rollUp([counted(53), reservedEmpty(), counted(34), reservedEmpty()]);
    expect(total).toEqual({
      known: true,
      words: 87,
      status: 'rolled_up',
      method: 'descendant_sum',
    });
  });

  it('rolls up a tree of roll-ups without drift', () => {
    // Parents of parents. Real depth in title 12 is title -> chapter -> subchapter -> part ->
    // subpart -> section, and a drift of one word per level would be invisible per node and
    // large corpus-wide.
    const sections = [counted(1_036), counted(126), counted(69), counted(602), counted(66)];
    const partA = rollUp(sections.slice(0, 3));
    const partB = rollUp(sections.slice(3));
    const chapter = rollUp([partA, partB]);

    expect(chapter.words).toBe(1_899);
    expect(chapter.words).toBe(sections.reduce((sum, s) => sum + (s.words ?? 0), 0));
  });

  it('is unavailable for a childless node rather than a measured zero', () => {
    // "No children" and "children totalling zero" are different claims. Only the second is a
    // measurement, and conflating them is how an unmeasured subtree becomes a confident 0.
    const total = rollUp([]);
    expect(total.known).toBe(false);
    expect(total.words).toBeNull();
  });

  it('an all-reserved parent is a measured zero', () => {
    expect(rollUp([reservedEmpty(), reservedEmpty()])).toEqual({
      known: true,
      words: 0,
      status: 'rolled_up',
      method: 'descendant_sum',
    });
  });

  it('refuses to construct a total that is not a non-negative integer', () => {
    expect(() => rolledUp(-1)).toThrow(RangeError);
    expect(() => rolledUp(1.5)).toThrow(RangeError);
    expect(() => counted(Number.NaN)).toThrow(RangeError);
  });
});

describe('a Measurement survives the database round trip', () => {
  it('preserves the distinction between unknown and zero', () => {
    // `formatNumber(null) === "0"` is the predecessor bug. It has to be impossible at rest and
    // at render, not only in memory.
    const unknown = notComputed();
    const zero = reservedEmpty();

    expect(fromRow(toRow(unknown))).toEqual(unknown);
    expect(fromRow(toRow(zero))).toEqual(zero);

    expect(formatMeasurement(unknown)).toBe('—');
    expect(formatMeasurement(zero)).toBe('0');
    expect(formatMeasurement(unknown)).not.toBe('0');
  });

  it('round-trips a large count with its thousands separators intact for display', () => {
    expect(formatMeasurement(counted(105_096_026))).toBe('105,096,026');
  });
});

// ─── deduplication ───────────────────────────────────────────────────────────

/**
 * The two totals, computed the way the pipeline computes them.
 *
 * Reimplemented here rather than imported: this is a specification test, and importing the
 * implementation would only assert that it equals itself. The arithmetic is four lines, and
 * the fixture generator computes it independently again, so three implementations have to
 * agree before a number reaches the site.
 */
interface Claim {
  refKey: string;
  words: number | null;
}

function attributed(claims: readonly Claim[]): number | null {
  if (claims.some((c) => c.words === null)) return null;
  return claims.reduce((sum, c) => sum + (c.words as number), 0);
}

function deduplicated(claims: readonly Claim[], claimantCount: Map<string, number>): number | null {
  if (claims.some((c) => c.words === null)) return null;
  return claims.reduce(
    (sum, c) => sum + (c.words as number) / (claimantCount.get(c.refKey) ?? 1),
    0,
  );
}

describe('a scope claimed by three agencies', () => {
  // 42 CFR I really is jointly claimed; three claimants and a count divisible by three keep
  // the arithmetic legible without changing what is being tested.
  const SHARED = 'title-42/chapter-I';
  const WORDS = 90_000;
  const claimants = new Map([[SHARED, 3]]);

  const agencies = ['indian-health-service', 'public-health-service', 'health-resources'] as const;

  it('contributes its FULL count to each agency attributed total', () => {
    for (const _agency of agencies) {
      expect(attributed([{ refKey: SHARED, words: WORDS }])).toBe(90_000);
    }
  });

  it('contributes exactly one third to each agency deduplicated total', () => {
    for (const _agency of agencies) {
      expect(deduplicated([{ refKey: SHARED, words: WORDS }], claimants)).toBe(30_000);
    }
  });

  it('sums to 3x the scope when attributed, and to exactly the scope when deduplicated', () => {
    const attributedTotal = agencies.reduce(
      (sum) => sum + (attributed([{ refKey: SHARED, words: WORDS }]) ?? 0),
      0,
    );
    const deduplicatedTotal = agencies.reduce(
      (sum) => sum + (deduplicated([{ refKey: SHARED, words: WORDS }], claimants) ?? 0),
      0,
    );

    // The predecessor summed the first of these into a corpus figure.
    expect(attributedTotal).toBe(270_000);
    expect(deduplicatedTotal).toBe(90_000);
  });
});

describe('CONSERVATION: deduplicated totals sum to the distinct-scope total', () => {
  it('holds for a mix of exclusive and shared scopes', () => {
    const scopeWords = new Map<string, number>([
      ['title-40/chapter-I', 1_000_000],
      ['title-42/chapter-I', 90_000],
      ['title-21/chapter-I', 500_000],
      ['title-7/subtitle-B/chapter-XI', 12_345],
    ]);

    const claims: Record<string, string[]> = {
      epa: ['title-40/chapter-I'],
      ihs: ['title-42/chapter-I'],
      phs: ['title-42/chapter-I'],
      hrsa: ['title-42/chapter-I'],
      fda: ['title-21/chapter-I'],
      usda: ['title-7/subtitle-B/chapter-XI'],
      fns: ['title-7/subtitle-B/chapter-XI'],
    };

    const claimants = new Map<string, number>();
    for (const keys of Object.values(claims)) {
      for (const key of keys) claimants.set(key, (claimants.get(key) ?? 0) + 1);
    }

    const perAgency = Object.values(claims).map((keys) =>
      deduplicated(
        keys.map((key) => ({ refKey: key, words: scopeWords.get(key) ?? null })),
        claimants,
      ),
    );

    const corpusFromAgencies = perAgency.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const corpusFromScopes = [...scopeWords.values()].reduce((sum, value) => sum + value, 0);

    // Exactly, not approximately. This is the property that makes the headline number
    // defensible: every word in the CFR is counted once.
    expect(corpusFromAgencies).toBe(corpusFromScopes);
    expect(corpusFromScopes).toBe(1_602_345);
  });

  it('holds when a shared count does not divide evenly', () => {
    // 100 words across 3 agencies. Rounding each share to an integer would lose a word; the
    // pipeline keeps the shares fractional and rounds once, at the end.
    const claimants = new Map([['title-42/chapter-I', 3]]);
    const shares = [0, 1, 2].map(() =>
      deduplicated([{ refKey: 'title-42/chapter-I', words: 100 }], claimants),
    );

    expect(shares.reduce<number>((sum, s) => sum + (s ?? 0), 0)).toBeCloseTo(100, 10);
    // Rounding first would give 33+33+33 = 99.
    expect(shares.map((s) => Math.round(s ?? 0)).reduce((a, b) => a + b, 0)).toBe(99);
  });

  it('an unknown scope nulls BOTH totals rather than shrinking either', () => {
    const claims: Claim[] = [
      { refKey: 'title-40/chapter-I', words: 1_000_000 },
      { refKey: 'title-40/chapter-IV', words: null },
    ];
    const claimants = new Map([
      ['title-40/chapter-I', 1],
      ['title-40/chapter-IV', 1],
    ]);

    expect(attributed(claims)).toBeNull();
    expect(deduplicated(claims, claimants)).toBeNull();
    // 1,000,000 is a plausible total for an agency and it is not this agency's total.
    expect(attributed(claims)).not.toBe(1_000_000);
  });

  it('an agency claiming nothing has a measured zero, not an unknown', () => {
    // The one case where 0 is the right answer: the agency genuinely regulates nothing, at
    // full coverage. Reporting it as unknown would put a dash next to a fact.
    expect(attributed([])).toBe(0);
    expect(deduplicated([], new Map())).toBe(0);
  });
});
