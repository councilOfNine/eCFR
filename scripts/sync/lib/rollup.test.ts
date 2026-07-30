/**
 * Regression tests for the four ways the predecessor got agency totals wrong, plus the
 * conservation property that the deduplicated headline rests on.
 *
 * Each `it` below names the specific defect it prevents. If one of them starts failing, the
 * dashboard is lying again in exactly that way.
 */

import type { Measurement } from '@ecfr-atlas/core';
import { counted, unavailable } from '@ecfr-atlas/core';
import { describe, expect, it } from 'vitest';
import type { AgencyInput, Claim } from './rollup.js';
import { computeRollups, createScopeResolver, evenShares, pruneContained } from './rollup.js';
import type { FlatNode } from './structure.js';
import { flattenStructure } from './structure.js';

/**
 * A small but structurally real title:
 *
 *   title-42
 *     chapter-I
 *       subchapter-A
 *         part-1     (100 words)
 *         part-2     (200 words)
 *       subchapter-B
 *         part-3     (300 words)
 *     chapter-II
 *       part-4       (400 words)
 */
function buildFixture(): { nodes: FlatNode[]; measurements: Map<string, Measurement> } {
  const nodes = flattenStructure(
    {
      type: 'title',
      identifier: '42',
      label: 'Title 42',
      children: [
        {
          type: 'chapter',
          identifier: 'I',
          label: 'Chapter I',
          children: [
            {
              type: 'subchapter',
              identifier: 'A',
              label: 'Subchapter A',
              children: [
                { type: 'part', identifier: '1', label: 'Part 1' },
                { type: 'part', identifier: '2', label: 'Part 2' },
              ],
            },
            {
              type: 'subchapter',
              identifier: 'B',
              label: 'Subchapter B',
              children: [{ type: 'part', identifier: '3', label: 'Part 3' }],
            },
          ],
        },
        {
          type: 'chapter',
          identifier: 'II',
          label: 'Chapter II',
          children: [{ type: 'part', identifier: '4', label: 'Part 4' }],
        },
      ],
    },
    42,
  );

  const words: Record<string, number> = {
    'title-42/chapter-I/subchapter-A/part-1': 100,
    'title-42/chapter-I/subchapter-A/part-2': 200,
    'title-42/chapter-I/subchapter-B/part-3': 300,
    'title-42/chapter-II/part-4': 400,
  };

  const measurements = new Map<string, Measurement>();
  for (const node of nodes) {
    const value = words[node.citation];
    if (value !== undefined) measurements.set(node.citation, counted(value));
  }
  // Roll the intermediate levels up by hand so the fixture mirrors what rollUpTree produces.
  measurements.set('title-42/chapter-I/subchapter-A', counted(300, 'xml_parse'));
  measurements.set('title-42/chapter-I/subchapter-B', counted(300, 'xml_parse'));
  measurements.set('title-42/chapter-I', counted(600, 'xml_parse'));
  measurements.set('title-42/chapter-II', counted(400, 'xml_parse'));
  measurements.set('title-42', counted(1000, 'xml_parse'));

  return { nodes, measurements };
}

function agency(
  slug: string,
  references: AgencyInput['references'],
  parentSlug: string | null = null,
): AgencyInput {
  return {
    slug,
    displayName: slug,
    sortableName: slug,
    parentSlug,
    depth: parentSlug ? 1 : 0,
    references,
  };
}

describe('narrowest-level resolution (defect 1: the 12.7x over-credit)', () => {
  it('measures the part, not the chapter, when a reference names both', () => {
    const { nodes, measurements } = buildFixture();
    const resolver = createScopeResolver(nodes, measurements);

    // This is the exact shape that broke the predecessor: chapter AND part on one reference.
    const result = computeRollups({
      agencies: [agency('narrow', [{ title: 42, chapter: 'I', part: '1' }])],
      resolver,
    });

    // 100 (part 1), not 600 (chapter I). A 6x difference in this fixture; it was 12.7x in
    // production.
    expect(result.rollups[0]?.attributedWordCount).toBe(100);
  });

  it('measures the subchapter when that is the narrowest level given', () => {
    const { nodes, measurements } = buildFixture();
    const resolver = createScopeResolver(nodes, measurements);
    const result = computeRollups({
      agencies: [agency('sub', [{ title: 42, chapter: 'I', subchapter: 'A' }])],
      resolver,
    });
    expect(result.rollups[0]?.attributedWordCount).toBe(300);
  });

  it('treats an empty-string level as absent', () => {
    const { nodes, measurements } = buildFixture();
    const resolver = createScopeResolver(nodes, measurements);
    const result = computeRollups({
      agencies: [agency('empty', [{ title: 42, chapter: 'I', part: '' }])],
      resolver,
    });
    expect(result.rollups[0]?.attributedWordCount).toBe(600);
  });
});

describe('shared scopes (defect 2: counted in full for every claimant, then summed)', () => {
  it('splits a shared scope evenly and conserves the total', () => {
    const { nodes, measurements } = buildFixture();
    const resolver = createScopeResolver(nodes, measurements);

    // 42 CFR I jointly administered — the real case is IHS and PHS.
    const result = computeRollups({
      agencies: [
        agency('ihs', [{ title: 42, chapter: 'I' }]),
        agency('phs', [{ title: 42, chapter: 'I' }]),
      ],
      resolver,
    });

    const ihs = result.rollups.find((r) => r.agencySlug === 'ihs');
    const phs = result.rollups.find((r) => r.agencySlug === 'phs');

    // Attributed credits each agency the whole chapter…
    expect(ihs?.attributedWordCount).toBe(600);
    expect(phs?.attributedWordCount).toBe(600);
    // …deduplicated splits it, and the two shares add back to exactly the chapter.
    expect(ihs?.deduplicatedWordCount).toBe(300);
    expect(phs?.deduplicatedWordCount).toBe(300);
    expect((ihs?.deduplicatedWordCount ?? 0) + (phs?.deduplicatedWordCount ?? 0)).toBe(600);
    expect(result.corpusDeduplicatedWords).toBe(600);
  });

  it('CONSERVATION: deduplicated totals sum to the distinct-scope total', () => {
    const { nodes, measurements } = buildFixture();
    const resolver = createScopeResolver(nodes, measurements);

    const result = computeRollups({
      agencies: [
        agency('a', [
          { title: 42, chapter: 'I', part: '1' },
          { title: 42, chapter: 'II', part: '4' },
        ]),
        agency('b', [{ title: 42, chapter: 'I', part: '1' }]),
        agency('c', [
          { title: 42, chapter: 'I', part: '1' },
          { title: 42, chapter: 'I', part: '3' },
        ]),
      ],
      resolver,
    });

    const sum = result.rollups.reduce((acc, r) => acc + (r.deduplicatedWordCount ?? 0), 0);
    // Distinct scopes: part 1 (100), part 4 (400), part 3 (300) = 800.
    expect(result.corpusDeduplicatedWords).toBe(800);
    expect(sum).toBe(800);
  });

  it('distributes the remainder so no word is lost to rounding', () => {
    // 7 words across 3 claimants: 3 + 2 + 2, not 2 + 2 + 2 with one word evaporating.
    expect(evenShares(7, 3)).toEqual([3, 2, 2]);
    expect(evenShares(7, 3).reduce((a, b) => a + b, 0)).toBe(7);
    expect(evenShares(0, 4)).toEqual([0, 0, 0, 0]);
    expect(evenShares(100, 1)).toEqual([100]);
  });

  it('writes a scope_overlap row per shared scope, ordered by sortable name', () => {
    const { nodes, measurements } = buildFixture();
    const resolver = createScopeResolver(nodes, measurements);
    const result = computeRollups({
      agencies: [
        agency('zeta', [{ title: 42, chapter: 'I' }]),
        agency('alpha', [{ title: 42, chapter: 'I' }]),
        agency('solo', [{ title: 42, chapter: 'II' }]),
      ],
      resolver,
    });

    expect(result.overlaps).toHaveLength(1);
    expect(result.overlaps[0]?.refKey).toBe('title-42/chapter-I');
    expect(result.overlaps[0]?.agencyCount).toBe(2);
    expect(JSON.parse(result.overlaps[0]?.agencySlugs ?? '[]')).toEqual(['alpha', 'zeta']);
    expect(result.overlaps[0]?.wordCount).toBe(600);
  });
});

describe('scope key normalisation (defect 3: two rows for one scope)', () => {
  it('collapses duplicate references to a single claim', () => {
    const { nodes, measurements } = buildFixture();
    const resolver = createScopeResolver(nodes, measurements);
    const result = computeRollups({
      agencies: [
        agency('dup', [
          { title: 42, chapter: 'I' },
          { title: 42, chapter: 'I', part: '' },
          { title: 42, chapter: 'I', subchapter: '' },
        ]),
      ],
      resolver,
    });

    expect(result.rollups[0]?.refsTotal).toBe(1);
    expect(result.rollups[0]?.attributedWordCount).toBe(600);
    expect(result.references).toHaveLength(1);
  });
});

describe('intra-agency nesting (defect 4: an ancestor and its descendant both counted)', () => {
  it('drops a scope contained by another scope of the same agency', () => {
    const { nodes, measurements } = buildFixture();
    const resolver = createScopeResolver(nodes, measurements);
    const result = computeRollups({
      agencies: [
        agency('nested', [
          { title: 42, chapter: 'I' },
          { title: 42, chapter: 'I', subchapter: 'A', part: '1' },
        ]),
      ],
      resolver,
    });

    // 600, not 700. Part 1's words are already inside chapter I.
    expect(result.rollups[0]?.attributedWordCount).toBe(600);
    // Both are still recorded as declared references — the agency page must show what eCFR
    // says, even where the arithmetic deliberately does not add it twice.
    expect(result.rollups[0]?.refsTotal).toBe(2);
    expect(result.references).toHaveLength(2);
  });

  it('pruneContained keeps siblings and drops descendants', () => {
    const claim = (refKey: string, scope: Claim['scope']): Claim => ({
      refKey,
      scope,
      narrowestLevel: 'part',
      nodeCitation: null,
      measurement: counted(1),
      dangling: false,
    });
    const claims = [
      claim('title-42/chapter-I', { title: 42, chapter: 'I' }),
      claim('title-42/chapter-I/part-1', { title: 42, chapter: 'I', part: '1' }),
      claim('title-42/chapter-II', { title: 42, chapter: 'II' }),
    ];
    expect(pruneContained(claims).map((c) => c.refKey)).toEqual([
      'title-42/chapter-I',
      'title-42/chapter-II',
    ]);
  });
});

describe('unknowns propagate instead of shrinking the total', () => {
  it('nulls the whole agency total when one scope is unmeasured', () => {
    const { nodes, measurements } = buildFixture();
    measurements.set(
      'title-42/chapter-II/part-4',
      unavailable('unavailable_fetch_failed', 'eCFR returned 504 after the retry budget'),
    );
    const resolver = createScopeResolver(nodes, measurements);

    const result = computeRollups({
      agencies: [
        agency('partial', [
          { title: 42, chapter: 'I', part: '1' },
          { title: 42, chapter: 'II', part: '4' },
        ]),
      ],
      resolver,
    });

    // NOT 100. A partial sum looks like a real number and is wrong in the one direction that
    // is impossible to notice.
    expect(result.rollups[0]?.attributedWordCount).toBeNull();
    expect(result.rollups[0]?.deduplicatedWordCount).toBeNull();
    expect(result.rollups[0]?.refsTotal).toBe(2);
    expect(result.rollups[0]?.refsCounted).toBe(1);
    expect(result.rollups[0]?.coveragePct).toBe(0.5);
  });

  it('a reference naming a scope that does not exist is dangling, not unknown', () => {
    // SEMANTICS CHANGED with the dangling partition. This used to assert NULL, and that
    // strictness let two stale rows in eCFR's agencies.json veto the corpus total forever.
    // Absent-from-structure now measures as zero footprint with visible coverage; the
    // NULL-propagation discipline lives on in the failed-measurement test below.
    const { nodes, measurements } = buildFixture();
    const resolver = createScopeResolver(nodes, measurements);
    const result = computeRollups({
      agencies: [agency('ghost', [{ title: 42, chapter: 'XCIX' }])],
      resolver,
    });
    expect(result.rollups[0]?.attributedWordCount).toBe(0);
    expect(result.rollups[0]?.coveragePct).toBe(0);
    expect(result.unresolvedScopes).toBe(1);
    expect(result.danglingScopes).toEqual(['title-42/chapter-XCIX']);
  });

  it('refuses to guess when a scope matches more than one node', () => {
    const nodes = flattenStructure(
      {
        type: 'title',
        identifier: '42',
        label: 'Title 42',
        children: [
          {
            type: 'subtitle',
            identifier: 'A',
            label: 'Subtitle A',
            children: [{ type: 'chapter', identifier: 'I', label: 'Chapter I' }],
          },
          {
            type: 'subtitle',
            identifier: 'B',
            label: 'Subtitle B',
            children: [{ type: 'chapter', identifier: 'I', label: 'Chapter I' }],
          },
        ],
      },
      42,
    );
    const measurements = new Map<string, Measurement>(
      nodes.map((n) => [n.citation, counted(10)] as const),
    );
    const resolver = createScopeResolver(nodes, measurements);

    expect(resolver.resolve({ title: 42, chapter: 'I' })).toMatchObject({ ok: false });
    // Naming the subtitle disambiguates it.
    expect(resolver.resolve({ title: 42, subtitle: 'A', chapter: 'I' })).toMatchObject({
      ok: true,
      citation: 'title-42/subtitle-A/chapter-I',
    });
  });
});

describe('subtree rollups', () => {
  it('unions scopes across the subtree rather than adding child totals', () => {
    const { nodes, measurements } = buildFixture();
    const resolver = createScopeResolver(nodes, measurements);

    // Parent and child both claim part 1. Summing their totals would count it twice.
    const result = computeRollups({
      agencies: [
        agency('parent', [{ title: 42, chapter: 'I', part: '1' }]),
        agency(
          'child',
          [
            { title: 42, chapter: 'I', part: '1' },
            { title: 42, chapter: 'II', part: '4' },
          ],
          'parent',
        ),
      ],
      resolver,
    });

    const parent = result.rollups.find((r) => r.agencySlug === 'parent');
    expect(parent?.attributedWordCount).toBe(100);
    // 100 + 400, not 100 + 500.
    expect(parent?.subtreeAttributed).toBe(500);
    expect(parent?.childrenCount).toBe(1);
    // Shares: part 1 split between parent and child (50/50), part 4 all to child. The subtree
    // gets both halves of part 1 back plus part 4.
    expect(parent?.subtreeDeduplicated).toBe(500);
  });
});

describe('agencies with no references', () => {
  it('reports zero words at full coverage rather than an unknown', () => {
    const { nodes, measurements } = buildFixture();
    const resolver = createScopeResolver(nodes, measurements);
    const result = computeRollups({ agencies: [agency('empty', [])], resolver });
    expect(result.rollups[0]?.attributedWordCount).toBe(0);
    expect(result.rollups[0]?.refsTotal).toBe(0);
    expect(result.rollups[0]?.coveragePct).toBe(1);
  });
});

describe('dangling upstream references (defect 5: two stale rows vetoing the corpus)', () => {
  // eCFR's agencies.json has referenced 15 CFR XXIII and 15 CFR XIII for years; its own
  // structure contains neither. The predecessor invented numbers for them. The first strict
  // implementation here fed their unavailable() into the corpus rollUp, which made the
  // headline NULL forever — a permanently unpublishable dashboard over upstream metadata rot.

  it('a dangling scope does not null the corpus or the claiming agency', () => {
    const { nodes, measurements } = buildFixture();
    const resolver = createScopeResolver(nodes, measurements);
    const result = computeRollups({
      agencies: [
        agency('healthy', [{ title: 42, chapter: 'I' }]),
        // Chapter IX does not exist in the fixture structure — the 15 CFR XXIII shape.
        agency('stale-ref', [
          { title: 42, chapter: 'IX' },
          { title: 42, chapter: 'II' },
        ]),
      ],
      resolver,
    });

    expect(result.corpusDeduplicatedWords).toBe(1000);
    expect(result.danglingScopes).toEqual(['title-42/chapter-IX']);
    expect(result.unresolvedScopes).toBe(1);

    const stale = result.rollups.find((r) => r.agencySlug === 'stale-ref');
    // The existing chapter II still counts; the dangling ref is visible in coverage.
    expect(stale?.attributedWordCount).toBe(400);
    expect(stale?.refsTotal).toBe(2);
    expect(stale?.refsCounted).toBe(1);
    // The declared reference row survives so the agency page can show the stale claim.
    expect(
      result.references.some(
        (r) => r.agencySlug === 'stale-ref' && r.refKey === 'title-42/chapter-IX',
      ),
    ).toBe(true);
  });

  it('an agency whose every reference is dangling measures 0, not unknown', () => {
    const { nodes, measurements } = buildFixture();
    const resolver = createScopeResolver(nodes, measurements);
    const result = computeRollups({
      // The East-West Foreign Trade Board shape: one reference, absent from the structure.
      agencies: [agency('defunct', [{ title: 42, chapter: 'XIII' }])],
      resolver,
    });

    const row = result.rollups[0];
    // Its current CFR footprint is genuinely zero — known-absent, not unknown.
    expect(row?.attributedWordCount).toBe(0);
    expect(row?.deduplicatedWordCount).toBe(0);
    expect(row?.refsTotal).toBe(1);
    expect(row?.refsCounted).toBe(0);
    // With EVERY declared scope dangling there is nothing summable at all, and a corpus of
    // "0 words" over an empty universe would read as a catastrophic miscount. Null-with-reason
    // is the honest shape here; production always has hundreds of summable scopes.
    expect(result.corpusDeduplicatedWords).toBeNull();
  });

  it('an EXISTING scope with a failed measurement still nulls everything it touches', () => {
    // The strictness the exclusion must not erode: title-40's parse failure has to keep
    // blocking the gate. Remove a measurement so chapter II exists but is unknown.
    const { nodes, measurements } = buildFixture();
    measurements.delete('title-42/chapter-II');
    const resolver = createScopeResolver(nodes, measurements);
    const result = computeRollups({
      agencies: [agency('unlucky', [{ title: 42, chapter: 'II' }])],
      resolver,
    });

    expect(result.rollups[0]?.attributedWordCount).toBeNull();
    expect(result.corpusDeduplicatedWords).toBeNull();
    expect(result.danglingScopes).toEqual([]);
  });

  it('conservation still holds with a dangling scope in the declared set', () => {
    const { nodes, measurements } = buildFixture();
    const resolver = createScopeResolver(nodes, measurements);
    const result = computeRollups({
      agencies: [
        agency('a', [
          { title: 42, chapter: 'I' },
          { title: 42, chapter: 'XIII' },
        ]),
        agency('b', [
          { title: 42, chapter: 'I' },
          { title: 42, chapter: 'II' },
        ]),
      ],
      resolver,
    });

    const sum = result.rollups.reduce((acc, r) => acc + (r.deduplicatedWordCount ?? 0), 0);
    expect(result.corpusDeduplicatedWords).toBe(sum);
    expect(result.corpusDeduplicatedWords).toBe(1000);
  });
});
