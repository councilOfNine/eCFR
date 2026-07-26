/**
 * Ordering CFR identifiers.
 *
 * Plain string comparison gets the CFR visibly wrong in two ways that a reader notices
 * immediately: chapter IX sorts before chapter VIII, and part 100 sorts before part 20. Neither
 * is a data-fidelity bug, but a reference tool whose table of contents is out of order reads as
 * untrustworthy, and this is cheap to get right.
 *
 * `structure_node.id` is insertion order and would be document order if the sync always walked
 * the tree depth-first — but it is an upsert-based pipeline, so a node added in a later run
 * lands at the end regardless of where it belongs. Deriving order from the identifier is
 * deterministic across runs; that is why this exists rather than an ORDER BY id.
 */

const ROMAN = /^[IVXLCDM]+$/;
const ROMAN_VALUES: Record<string, number> = {
  I: 1,
  V: 5,
  X: 10,
  L: 50,
  C: 100,
  D: 500,
  M: 1000,
};

/** Returns null for anything that is not a well-formed Roman numeral. */
function romanValue(text: string): number | null {
  if (!ROMAN.test(text)) return null;
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    // Non-null: the regex above guarantees every character is a key of ROMAN_VALUES.
    const current = ROMAN_VALUES[text[i] as string] as number;
    const next = i + 1 < text.length ? (ROMAN_VALUES[text[i + 1] as string] as number) : 0;
    total += current < next ? -current : current;
  }
  return total;
}

/** Split into alternating text and number runs so `1926` in `part 1926` compares numerically. */
function chunks(text: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const match of text.matchAll(/(\d+)|(\D+)/g)) {
    const [, digits, other] = match;
    if (digits !== undefined) out.push(Number.parseInt(digits, 10));
    else if (other !== undefined) out.push(other.toLowerCase());
  }
  return out;
}

/**
 * Compare two CFR identifiers for display order.
 *
 * Roman numerals are compared by value when both sides are Roman, which covers chapters and
 * subchapters. Everything else falls back to a natural sort, which covers parts (`20` < `100`),
 * sections (`60.9` < `60.10`), subparts (`A` < `B`) and appendix suffixes.
 */
export function compareIdentifiers(a: string, b: string): number {
  const ra = romanValue(a);
  const rb = romanValue(b);
  if (ra !== null && rb !== null && ra !== rb) return ra - rb;
  // Both Roman and equal in value means the same numeral written differently; fall through so
  // the tiebreak is still total and therefore stable.

  const ca = chunks(a);
  const cb = chunks(b);
  const len = Math.max(ca.length, cb.length);

  for (let i = 0; i < len; i++) {
    const x = ca[i];
    const y = cb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else {
      const sx = String(x);
      const sy = String(y);
      if (sx !== sy) return sx < sy ? -1 : 1;
    }
  }
  return 0;
}

/** Convenience for `.sort()` over records carrying an `identifier`. */
export function byIdentifier<T extends { identifier: string }>(a: T, b: T): number {
  return compareIdentifiers(a.identifier, b.identifier);
}
