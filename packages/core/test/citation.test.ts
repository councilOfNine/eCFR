/**
 * `narrowestLevel` and `refKey`, against the real 487 CFR references.
 *
 * Two of the four defects that caused this rewrite live entirely inside these two functions:
 *
 *   - reading a reference's `chapter` while ignoring a narrower `subchapter`/`part` on the same
 *     reference. 12 of 487 references carry both. One agency was over-credited 12.7x.
 *   - a unique index that COALESCE'd the subchapter, so `{chapter:'XIV'}` and
 *     `{chapter:'XIV', subchapter:''}` produced two rows for one scope and the agency was
 *     counted twice.
 *
 * Synthetic cases can only show that the functions behave as their authors intended. The real
 * agencies.json response — committed under fixtures/raw is gitignored, so the reference list is
 * reconstructed from the committed seed.sql — shows that the intent matches the data. Both
 * kinds of assertion are below, in that order.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  displayCitation,
  ecfrUrl,
  HIERARCHY,
  narrowestLevel,
  parseRefKey,
  refKey,
  type Scope,
  scopeContains,
  toScope,
} from '../src/index.js';

// ─── synthetic: the exact defect shapes ──────────────────────────────────────

describe('narrowestLevel honours the narrowest level present', () => {
  it('resolves to the part when a reference names a chapter AND a part', () => {
    // THE defect. `{chapter: 'I', part: '60'}` is 40 CFR 60, not all of 40 CFR I.
    expect(narrowestLevel({ title: 40, chapter: 'I', part: '60' })).toBe('part');
  });

  it('resolves to the subchapter when that is the narrowest given', () => {
    expect(narrowestLevel({ title: 40, chapter: 'I', subchapter: 'C' })).toBe('subchapter');
  });

  it('prefers the part over a subchapter that is also present', () => {
    expect(narrowestLevel({ title: 40, chapter: 'I', subchapter: 'C', part: '60' })).toBe('part');
  });

  it('treats an empty string as absent at every level', () => {
    // eCFR really does send `""`. Truthiness is the whole difference between "this reference
    // names a part" and "this reference names a chapter".
    expect(narrowestLevel({ title: 22, chapter: 'XIV', subchapter: '', part: '' })).toBe('chapter');
    expect(narrowestLevel({ title: 22, subtitle: '', chapter: '' })).toBe('title');
  });

  it('falls back to title only when nothing narrower is given', () => {
    expect(narrowestLevel({ title: 3 })).toBe('title');
  });

  it('returns a level that is always in HIERARCHY', () => {
    const scopes: Scope[] = [
      { title: 1 },
      { title: 1, subtitle: 'B' },
      { title: 1, chapter: 'I' },
      { title: 1, chapter: 'I', subchapter: 'A' },
      { title: 1, chapter: 'I', subchapter: 'A', part: '51' },
    ];
    for (const scope of scopes) {
      expect(HIERARCHY).toContain(narrowestLevel(scope));
    }
  });
});

describe('refKey normalises so one scope is one key', () => {
  it('collapses an empty subchapter to the same key as an absent one', () => {
    // The doubling bug, in one assertion. The predecessor's unique index COALESCE'd the
    // subchapter and produced two rows for the 22 CFR XIV scope claimed by
    // foreign-service-labor-relations-board.
    expect(refKey({ title: 22, chapter: 'XIV' })).toBe(
      refKey({ title: 22, chapter: 'XIV', subchapter: '' }),
    );
    expect(refKey({ title: 22, chapter: 'XIV' })).toBe('title-22/chapter-XIV');
  });

  it('collapses every empty level, not only the subchapter', () => {
    expect(refKey({ title: 22, subtitle: '', chapter: 'XIV', subchapter: '', part: '' })).toBe(
      'title-22/chapter-XIV',
    );
  });

  it('emits levels in hierarchy order regardless of key order in the source object', () => {
    // JSON key order is not a contract, and `Object.keys` follows insertion order. A key built
    // by iterating the source object would differ between two identical references.
    const a: Scope = { title: 40, part: '60', chapter: 'I' };
    const b: Scope = { title: 40, chapter: 'I', part: '60' };
    expect(refKey(a)).toBe(refKey(b));
    expect(refKey(a)).toBe('title-40/chapter-I/part-60');
  });

  it('keeps distinct scopes distinct', () => {
    const keys = [
      refKey({ title: 40, chapter: 'I' }),
      refKey({ title: 40, chapter: 'I', part: '60' }),
      refKey({ title: 40, chapter: 'I', subchapter: 'C' }),
      refKey({ title: 40, chapter: 'I', subchapter: 'C', part: '60' }),
      refKey({ title: 41, chapter: 'I' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('round-trips through parseRefKey', () => {
    const scope: Scope = { title: 40, subtitle: 'B', chapter: 'I', subchapter: 'C', part: '60.1' };
    expect(refKey(parseRefKey(refKey(scope)))).toBe(refKey(scope));
    expect(parseRefKey(refKey(scope))).toEqual(scope);
  });

  it('parses an identifier containing a hyphen', () => {
    // 3 CFR Parts 103-199 is one part identifier, not a range this code may split.
    expect(parseRefKey('title-3/part-103-199')).toEqual({ title: 3, part: '103-199' });
  });

  it('refuses a key with no title rather than defaulting to one', () => {
    expect(() => parseRefKey('chapter-I/part-60')).toThrow(/title/);
    expect(() => parseRefKey('title-NaN/chapter-I')).toThrow(/title/);
  });
});

describe('toScope drops empty levels on the way in', () => {
  it('produces a scope whose absent levels are absent, not empty strings', () => {
    const scope = toScope({ title: 22, chapter: 'XIV', subchapter: '', part: '' });
    expect(scope).toEqual({ title: 22, chapter: 'XIV' });
    expect('subchapter' in scope).toBe(false);
  });
});

describe('scopeContains, which is what stops an agency counting a part twice', () => {
  it('a chapter contains a part inside it', () => {
    expect(
      scopeContains({ title: 40, chapter: 'I' }, { title: 40, chapter: 'I', part: '60' }),
    ).toBe(true);
  });

  it('a part does not contain its chapter', () => {
    expect(
      scopeContains({ title: 40, chapter: 'I', part: '60' }, { title: 40, chapter: 'I' }),
    ).toBe(false);
  });

  it('scopes in different titles never contain each other', () => {
    expect(scopeContains({ title: 40, chapter: 'I' }, { title: 41, chapter: 'I' })).toBe(false);
  });

  it('sibling parts do not contain each other', () => {
    expect(
      scopeContains(
        { title: 40, chapter: 'I', part: '60' },
        { title: 40, chapter: 'I', part: '61' },
      ),
    ).toBe(false);
  });

  it('a scope contains itself, so a self-comparison must be excluded by the caller', () => {
    // Stated because `pruneContained` would otherwise delete every scope it looked at.
    const scope: Scope = { title: 40, chapter: 'I' };
    expect(scopeContains(scope, scope)).toBe(true);
  });
});

describe('display and links', () => {
  it('names the narrowest level in the human citation', () => {
    expect(displayCitation({ title: 40, chapter: 'I', part: '60' })).toBe('40 CFR Part 60');
    expect(displayCitation({ title: 42, chapter: 'I' })).toBe('42 CFR Chapter I');
    expect(displayCitation({ title: 40 }, '60.1')).toBe('40 CFR 60.1');
  });

  it('links to eCFR, never to ourselves', () => {
    // Attribution policy: every scope carries a link back to the official text.
    const url = ecfrUrl({ title: 40, chapter: 'I', subchapter: 'C', part: '60' });
    expect(url).toBe('https://www.ecfr.gov/current/title-40/chapter-I/subchapter-C/part-60');
  });
});

// ─── real data: all 487 references, from the committed fixture ───────────────

/**
 * Reconstruct the reference list from fixtures/seed.sql.
 *
 * The generator wrote these rows by calling the very functions under test, so this is not a
 * check that the fixture agrees with them — it would, trivially. It is a check of the
 * PROPERTIES the real corpus must satisfy: every key is canonical, the 12-refs case is present
 * and correctly resolved, and no two rows describe the same scope.
 */
interface FixtureRef {
  agencySlug: string;
  refKey: string;
  title: number;
  narrowest: string;
  subtitle: string | null;
  chapter: string | null;
  subchapter: string | null;
  part: string | null;
}

function loadReferences(): FixtureRef[] {
  const seed = readFileSync(new URL('../../../fixtures/seed.sql', import.meta.url), 'utf8');

  // Only the agency_cfr_reference VALUES rows. The generated file puts one row per line with a
  // fixed column order, and `sqlString` hex-encodes control characters, so no literal newline
  // can appear inside a quoted value and line-oriented reading is sound here.
  const out: FixtureRef[] = [];
  let inBlock = false;

  for (const line of seed.split('\n')) {
    if (line.startsWith('INSERT INTO agency_cfr_reference')) {
      inBlock = true;
      continue;
    }
    if (inBlock && line.startsWith('ON CONFLICT')) {
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;

    const match = /^\s*\((.*)\),?$/.exec(line);
    if (!match?.[1]) continue;
    const cells = splitSqlTuple(match[1]);
    out.push({
      agencySlug: unquote(cells[0]),
      refKey: unquote(cells[1]),
      title: Number.parseInt(cells[2] ?? '0', 10),
      narrowest: unquote(cells[3]),
      subtitle: nullable(cells[4]),
      chapter: nullable(cells[5]),
      subchapter: nullable(cells[6]),
      part: nullable(cells[7]),
    });
  }
  return out;
}

/** Split a VALUES tuple on commas that are not inside a quoted literal. */
function splitSqlTuple(tuple: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < tuple.length; i++) {
    const char = tuple[i];
    if (char === "'") {
      // '' inside a literal is an escaped quote, not a close-then-open.
      if (quoted && tuple[i + 1] === "'") {
        current += "''";
        i += 1;
        continue;
      }
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

const unquote = (cell: string | undefined): string =>
  (cell ?? '').replace(/^'|'$/g, '').replaceAll("''", "'");

const nullable = (cell: string | undefined): string | null =>
  cell === 'NULL' || cell === undefined ? null : unquote(cell);

const references = loadReferences();

describe('the real 487 CFR references', () => {
  it('are all present in the fixture', () => {
    // Measured against the live API on 2026-07-26 and stated in the project brief. A change
    // here means eCFR reorganised something and the fixture needs regenerating — which is
    // information, not a failure of this code.
    expect(references).toHaveLength(487);
  });

  it('contains the 12 references that name a chapter AND something narrower', () => {
    const narrower = references.filter(
      (ref) => ref.chapter !== null && (ref.narrowest === 'subchapter' || ref.narrowest === 'part'),
    );

    // The 12.7x over-credit, as a count. Reading `chapter` on any of these twelve and ignoring
    // the rest is the predecessor's bug.
    expect(narrower).toHaveLength(12);

    for (const ref of narrower) {
      const scope = parseRefKey(ref.refKey);
      // The stored level is what the pipeline honours; it must equal what the algorithm says.
      expect(narrowestLevel(scope)).toBe(ref.narrowest);
      // And the key must carry the narrower level, or the scope resolves to the chapter after
      // all and the whole exercise was cosmetic.
      expect(ref.refKey).toMatch(ref.narrowest === 'part' ? /\/part-/ : /\/subchapter-/);
    }
  });

  it('stores a narrowest_level that always matches the key it was derived from', () => {
    for (const ref of references) {
      expect(narrowestLevel(parseRefKey(ref.refKey)), ref.refKey).toBe(ref.narrowest);
    }
  });

  it('stores only canonical keys', () => {
    // A key that does not survive a parse/rebuild round trip is not canonical, and two
    // spellings of one scope defeat the whole deduplication.
    for (const ref of references) {
      expect(refKey(parseRefKey(ref.refKey)), ref.refKey).toBe(ref.refKey);
    }
  });

  it('never stores an empty-string level, which is what produced the duplicate rows', () => {
    for (const ref of references) {
      for (const level of [ref.subtitle, ref.chapter, ref.subchapter, ref.part]) {
        expect(level, ref.refKey).not.toBe('');
      }
    }
  });

  it('has no agency claiming the same scope twice', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const ref of references) {
      const composite = `${ref.agencySlug}|${ref.refKey}`;
      if (seen.has(composite)) duplicates.push(composite);
      seen.add(composite);
    }
    expect(duplicates).toEqual([]);
  });

  it('has exactly 17 scopes claimed by more than one agency', () => {
    // Shared jurisdiction is a feature with its own page, not a rounding error. 42 CFR I is
    // jointly run by IHS and PHS and a researcher needs to know that.
    const byKey = new Map<string, Set<string>>();
    for (const ref of references) {
      const claimants = byKey.get(ref.refKey) ?? new Set<string>();
      claimants.add(ref.agencySlug);
      byKey.set(ref.refKey, claimants);
    }
    const shared = [...byKey.values()].filter((claimants) => claimants.size > 1);

    expect(shared).toHaveLength(17);
    // Between 2 and 6 claimants, per the corpus measurement.
    expect(Math.max(...shared.map((s) => s.size))).toBeLessThanOrEqual(6);
    expect(Math.min(...shared.map((s) => s.size))).toBeGreaterThanOrEqual(2);
  });

  it('resolves every reference to a title that exists', () => {
    for (const ref of references) {
      expect(ref.title, ref.refKey).toBeGreaterThanOrEqual(1);
      expect(ref.title, ref.refKey).toBeLessThanOrEqual(50);
      expect(parseRefKey(ref.refKey).title).toBe(ref.title);
    }
  });
});
