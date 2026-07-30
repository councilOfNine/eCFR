/**
 * Drift tripwires for the enum-style vocabularies in packages/core/src/enums.ts.
 *
 * Each vocabulary exists as three artefacts derived from one definition — the const object,
 * the union type, and the ordered tuple that Zod consumes. The `satisfies` clauses in
 * enums.ts prove every tuple element is a member; the type-level assertions here prove the
 * reverse (a member missing from a tuple narrows the tuple's element union and fails
 * `toEqualTypeOf` at typecheck), and the runtime assertions prove order and de-duplication,
 * which no type can see.
 *
 * `expectTypeOf` calls are no-ops at runtime; they bite when `tsc --build` compiles this file
 * under tsconfig.tests.json.
 */

import { readdirSync, readFileSync } from 'node:fs';
import type { KnownStatus, Measurement, UnknownStatus } from '@ecfr-atlas/core';
import {
  assertNever,
  COUNT_METHODS,
  CountMethod,
  DIFF_STATUSES,
  DiffStatus,
  HIERARCHY,
  HierarchyLevel,
  isKnownStatus,
  KNOWN_STATUSES,
  STRUCTURE_NODE_TYPES,
  StructureNodeType,
  UNKNOWN_STATUSES,
  WORD_COUNT_STATUSES,
  WordCountStatus,
} from '@ecfr-atlas/core';
import type { DiffResponse, ScopeSchema, WordCount } from '@ecfr-atlas/core/api-schemas';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

describe('each tuple is exactly its enum object, in declaration order', () => {
  // Object.values order is insertion order for string keys, so equality here pins both the
  // membership and the ordering that the DB CHECK constraints and docs were written against.
  it('WORD_COUNT_STATUSES', () => {
    expect(Object.values(WordCountStatus)).toEqual([...WORD_COUNT_STATUSES]);
    expectTypeOf<(typeof WORD_COUNT_STATUSES)[number]>().toEqualTypeOf<WordCountStatus>();
  });

  it('COUNT_METHODS', () => {
    expect(Object.values(CountMethod)).toEqual([...COUNT_METHODS]);
    expectTypeOf<(typeof COUNT_METHODS)[number]>().toEqualTypeOf<CountMethod>();
  });

  it('HIERARCHY', () => {
    expect(Object.values(HierarchyLevel)).toEqual([...HIERARCHY]);
    expectTypeOf<(typeof HIERARCHY)[number]>().toEqualTypeOf<HierarchyLevel>();
  });

  it('STRUCTURE_NODE_TYPES', () => {
    expect(Object.values(StructureNodeType)).toEqual([...STRUCTURE_NODE_TYPES]);
    expectTypeOf<(typeof STRUCTURE_NODE_TYPES)[number]>().toEqualTypeOf<StructureNodeType>();
  });

  it('DIFF_STATUSES', () => {
    expect(Object.values(DiffStatus)).toEqual([...DIFF_STATUSES]);
    expectTypeOf<(typeof DIFF_STATUSES)[number]>().toEqualTypeOf<DiffStatus>();
  });
});

describe('the known/unknown partition', () => {
  it('splits WORD_COUNT_STATUSES exactly, with nothing shared and nothing dropped', () => {
    const partition = [...KNOWN_STATUSES, ...UNKNOWN_STATUSES];
    expect([...partition].sort()).toEqual([...WORD_COUNT_STATUSES].sort());
    expect(new Set(partition).size).toBe(partition.length);
    expectTypeOf<KnownStatus | UnknownStatus>().toEqualTypeOf<WordCountStatus>();
  });

  it('isKnownStatus agrees with the tuples for every status', () => {
    // The switch in isKnownStatus restates the partition; this loop is what stops the two
    // statements of it from drifting apart.
    for (const status of WORD_COUNT_STATUSES) {
      expect(isKnownStatus(status)).toBe((KNOWN_STATUSES as readonly string[]).includes(status));
    }
  });
});

describe('the Zod schemas infer the enum types, not parallel unions', () => {
  it('WordCount status and method', () => {
    expectTypeOf<z.infer<typeof WordCount>['status']>().toEqualTypeOf<WordCountStatus>();
    expectTypeOf<z.infer<typeof WordCount>['method']>().toEqualTypeOf<CountMethod | null>();
  });

  it('ScopeSchema narrowest_level', () => {
    expectTypeOf<z.infer<typeof ScopeSchema>['narrowest_level']>().toEqualTypeOf<HierarchyLevel>();
  });

  it('DiffResponse status', () => {
    expectTypeOf<z.infer<typeof DiffResponse>['status']>().toEqualTypeOf<DiffStatus>();
  });

  it('Measurement statuses are the partition types', () => {
    expectTypeOf<Extract<Measurement, { known: true }>['status']>().toEqualTypeOf<KnownStatus>();
    expectTypeOf<Extract<Measurement, { known: false }>['status']>().toEqualTypeOf<UnknownStatus>();
  });
});

describe('assertNever', () => {
  it('names the vocabulary and the stray value when reached at runtime', () => {
    expect(() => assertNever('estimated' as never, 'WordCountStatus')).toThrow(
      /WordCountStatus.*"estimated"/,
    );
  });
});

/**
 * The values are frozen because they are duplicated into SQL, and a duplicate that nothing
 * compares is a duplicate that drifts.
 *
 * enums.ts says outright that these strings live in the D1 CHECK constraints, but saying it
 * is not enforcing it: TypeScript cannot see inside a .sql file, so renaming a member value
 * typechecks cleanly and then fails at the first INSERT — in the sync pipeline, at 3am, after
 * the fetch budget has been spent. packages/db's own constraint suite runs in workerd, which
 * has no filesystem and so cannot read the migration as text; this project can, so the
 * literal-level comparison lives here.
 *
 * Membership only, deliberately. SQL has no meaningful order, so requiring one would make
 * this fail on a harmless reformat of the migration.
 */
describe('the migration CHECK constraints still spell these vocabularies the same way', () => {
  // A rebuild migration supersedes the original table (0003 recreated structure_node to
  // widen its CHECKs — SQLite cannot ALTER one), so the operative spelling of a constraint
  // is whatever the LATEST migration that mentions it says. Earlier files are history and
  // deliberately left uncompared.
  const migrations = readdirSync(new URL('../../db/migrations/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));

  function operativeText(anchor: string): string {
    const holding = migrations.filter((text) => text.includes(anchor));
    expect(holding.length, `no migration contains \`${anchor}\``).toBeGreaterThan(0);
    return holding[holding.length - 1] as string;
  }

  /**
   * The quoted literals of the first `<column> IN ( ... )` list in the operative migration.
   *
   * Anchored on `<column> IN` rather than on the bare column name, which would find the
   * column DEFINITION line instead and read a list that is not there. First occurrence within
   * the file, because the NULL/status partition constraint repeats `word_count_status IN`
   * further down with the unknown-only subset.
   */
  function checkedValues(column: string): string[] {
    const text = operativeText(`${column} IN`);
    const start = text.indexOf(`${column} IN`);
    const open = text.indexOf('(', start);
    const close = text.indexOf(')', open);
    return [...text.slice(open, close).matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
  }

  it.each([
    ['word_count_status', WORD_COUNT_STATUSES],
    ['word_count_method', COUNT_METHODS],
    ['narrowest_level', HIERARCHY],
  ])('%s', (column, vocabulary) => {
    expect(new Set(checkedValues(column))).toEqual(new Set(vocabulary));
  });

  it('parsed real constraints rather than matching nothing', () => {
    // Without this the three cases above would pass on two empty sets.
    expect(checkedValues('word_count_status')).toContain('unavailable_fetch_failed');
    expect(checkedValues('word_count_status').length).toBe(WORD_COUNT_STATUSES.length);
  });

  it('pins the partition that makes an unmeasured count unstorable', () => {
    // The load-bearing constraint: `(word_count IS NULL) = (word_count_status IN <unknown>)`.
    // If a status moved sides here, a number could be stored for a node nobody measured —
    // which is the single failure this whole codebase is built to make impossible.
    const text = operativeText('(word_count IS NULL) =');
    const anchor = text.indexOf('(word_count IS NULL) =');
    const open = text.indexOf('IN (', anchor);
    const close = text.indexOf(')', open + 'IN ('.length);
    const listed = [...text.slice(open, close).matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
    expect(new Set(listed)).toEqual(new Set(UNKNOWN_STATUSES));
  });
});
