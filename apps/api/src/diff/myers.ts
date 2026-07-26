/**
 * Myers O(ND) diff, linear space.
 *
 * WHY NOT AN LCS TABLE: the predecessor built an m*n dynamic-programming table. For
 * 26 CFR 1.72-9 — 46,119 lines — that is 2.1 billion cells, which it tried to allocate as
 * 15.95 GB. V8 does not throw on that; it aborts the isolate. An abort is not a catchable
 * error, so no amount of try/catch around the old code would have helped, and the fix had to
 * be a different algorithm rather than a guard.
 *
 * This is Myers (1986) "An O(ND) Difference Algorithm and Its Variations", the linear-space
 * refinement from §4b: find the middle snake of the optimal path, recurse on the two halves.
 * Time O(ND), space O(N+M). For two 5,000-line sections that is two 20,000-entry Int32Arrays,
 * about 80 KB, regardless of how different the inputs are.
 *
 * Two further properties this implementation has on purpose:
 *
 *   - It is iterative, not recursive. The divide-and-conquer is driven by an explicit work
 *     stack, so a pathological input cannot overflow the Worker's call stack — which, like a
 *     heap abort, would not be catchable.
 *
 *   - Nothing in this file is derived from user input as code. Lines are compared with `===`.
 *     There is no regex anywhere, let alone one built from a query parameter, which is what
 *     made the old /diff an unauthenticated ReDoS.
 *
 * Indexing note: `noUncheckedIndexedAccess` is on repo-wide. The inner loops use `!` on typed
 * array reads because every index is provably within `[0, 2*MAX+2]` by the loop bounds, and
 * adding an `?? 0` per read would put a branch in the hottest loop in the codebase for a case
 * that cannot occur.
 */

export type EditOp = 'equal' | 'insert' | 'delete';

export interface Edit {
  op: EditOp;
  /** 0-based index into the old array; null for inserts. */
  oldIndex: number | null;
  /** 0-based index into the new array; null for deletes. */
  newIndex: number | null;
  text: string;
}

interface MiddleSnake {
  /** Start of the snake, in coordinates local to the sub-problem. */
  x0: number;
  y0: number;
  /** End of the snake. */
  x1: number;
  y1: number;
  /** Edit distance of the whole sub-problem. */
  d: number;
}

/**
 * Reusable scratch space.
 *
 * Allocated once per `diffLines` call and threaded through every sub-problem. Allocating
 * inside `findMiddleSnake` would mean one allocation per divide step; at 5,000 lines that is
 * thousands of 80 KB allocations and a lot of avoidable GC.
 */
interface Scratch {
  vf: Int32Array;
  vb: Int32Array;
  offset: number;
}

/**
 * Diff two arrays of lines.
 *
 * The result is a flat, in-order edit script covering every line of both inputs. Hunking and
 * context trimming happen elsewhere — this function's only job is to be correct and bounded.
 */
export function diffLines(oldLines: readonly string[], newLines: readonly string[]): Edit[] {
  const n = oldLines.length;
  const m = newLines.length;
  const out: Edit[] = [];

  // Common prefix and suffix are stripped first. Regulation revisions are overwhelmingly
  // small edits to long documents, so this alone usually reduces the sub-problem Myers has to
  // solve from thousands of lines to tens.
  let prefix = 0;
  while (prefix < n && prefix < m && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    oldLines[n - 1 - suffix] === newLines[m - 1 - suffix]
  ) {
    suffix++;
  }

  for (let i = 0; i < prefix; i++) {
    out.push({ op: 'equal', oldIndex: i, newIndex: i, text: oldLines[i] as string });
  }

  const midOldStart = prefix;
  const midOldLen = n - prefix - suffix;
  const midNewStart = prefix;
  const midNewLen = m - prefix - suffix;

  if (midOldLen > 0 || midNewLen > 0) {
    const max = midOldLen + midNewLen;
    const scratch: Scratch = {
      // +3 rather than +1: the overlap check reads diagonal `delta - k`, which can sit one
      // step outside the range the forward loop itself writes.
      vf: new Int32Array(2 * max + 3),
      vb: new Int32Array(2 * max + 3),
      offset: max + 1,
    };
    walk(oldLines, midOldStart, midOldLen, newLines, midNewStart, midNewLen, scratch, out);
  }

  for (let i = 0; i < suffix; i++) {
    const oi = n - suffix + i;
    const ni = m - suffix + i;
    out.push({ op: 'equal', oldIndex: oi, newIndex: ni, text: oldLines[oi] as string });
  }

  return out;
}

/** One unit of divide-and-conquer work, or a run of equal lines waiting to be emitted. */
type Task =
  | { kind: 'diff'; a0: number; n: number; b0: number; m: number }
  | { kind: 'equal'; a0: number; b0: number; len: number };

/**
 * Iterative Myers 4b.
 *
 * The stack holds tasks in reverse output order, so popping produces a correctly ordered edit
 * script without any post-sort. `equal` tasks are how a middle snake gets emitted between its
 * two recursive halves.
 */
function walk(
  a: readonly string[],
  a0Init: number,
  nInit: number,
  b: readonly string[],
  b0Init: number,
  mInit: number,
  scratch: Scratch,
  out: Edit[],
): void {
  const stack: Task[] = [{ kind: 'diff', a0: a0Init, n: nInit, b0: b0Init, m: mInit }];

  while (stack.length > 0) {
    const task = stack.pop() as Task;

    if (task.kind === 'equal') {
      for (let i = 0; i < task.len; i++) {
        out.push({
          op: 'equal',
          oldIndex: task.a0 + i,
          newIndex: task.b0 + i,
          text: a[task.a0 + i] as string,
        });
      }
      continue;
    }

    const { a0, n, b0, m } = task;

    if (n === 0) {
      for (let i = 0; i < m; i++) {
        out.push({ op: 'insert', oldIndex: null, newIndex: b0 + i, text: b[b0 + i] as string });
      }
      continue;
    }
    if (m === 0) {
      for (let i = 0; i < n; i++) {
        out.push({ op: 'delete', oldIndex: a0 + i, newIndex: null, text: a[a0 + i] as string });
      }
      continue;
    }

    const snake = findMiddleSnake(a, a0, n, b, b0, m, scratch);

    if (snake.d > 1) {
      // Push in reverse: right half, the snake itself, then left half — so the left half is
      // popped and emitted first.
      stack.push({
        kind: 'diff',
        a0: a0 + snake.x1,
        n: n - snake.x1,
        b0: b0 + snake.y1,
        m: m - snake.y1,
      });
      stack.push({
        kind: 'equal',
        a0: a0 + snake.x0,
        b0: b0 + snake.y0,
        len: snake.x1 - snake.x0,
      });
      stack.push({ kind: 'diff', a0, n: snake.x0, b0, m: snake.y0 });
      continue;
    }

    // d is 0 or 1: at most one edit separates these ranges, and since the model has only
    // insertions and deletions, an edit distance of 1 implies |n - m| === 1. Solving it by a
    // direct prefix scan is O(n) and avoids the fiddly base case in the published algorithm.
    let p = 0;
    while (p < n && p < m && a[a0 + p] === b[b0 + p]) p++;

    for (let i = 0; i < p; i++) {
      out.push({ op: 'equal', oldIndex: a0 + i, newIndex: b0 + i, text: a[a0 + i] as string });
    }

    if (m > n) {
      out.push({ op: 'insert', oldIndex: null, newIndex: b0 + p, text: b[b0 + p] as string });
      for (let i = p; i < n; i++) {
        out.push({
          op: 'equal',
          oldIndex: a0 + i,
          newIndex: b0 + i + 1,
          text: a[a0 + i] as string,
        });
      }
    } else if (n > m) {
      out.push({ op: 'delete', oldIndex: a0 + p, newIndex: null, text: a[a0 + p] as string });
      for (let i = p + 1; i < n; i++) {
        out.push({
          op: 'equal',
          oldIndex: a0 + i,
          newIndex: b0 + i - 1,
          text: a[a0 + i] as string,
        });
      }
    }
    // n === m with d <= 1 forces d === 0, so the prefix scan above already consumed both.
  }
}

/**
 * Find the middle snake of the optimal edit path.
 *
 * Forward paths advance from the top-left, reverse paths from the bottom-right. They are
 * guaranteed to overlap at D/2, and the snake at that overlap lies on some optimal path, so
 * the problem splits into two strictly smaller ones.
 *
 * `delta = n - m`. When delta is odd the overlap is detected in the forward sweep (total
 * distance 2D-1); when it is even, in the reverse sweep (2D).
 */
function findMiddleSnake(
  a: readonly string[],
  a0: number,
  n: number,
  b: readonly string[],
  b0: number,
  m: number,
  scratch: Scratch,
): MiddleSnake {
  const { vf, vb, offset } = scratch;
  const max = n + m;
  const delta = n - m;
  const deltaOdd = (delta & 1) !== 0;

  // Cleared per call: a stale value from a previous sub-problem on the same diagonal would be
  // read as a legitimate furthest-reaching path and silently produce a wrong (though still
  // valid-looking) diff. Filling 2*max+3 entries is trivial next to the search itself.
  vf.fill(0);
  vb.fill(0);

  const half = Math.ceil(max / 2);

  for (let d = 0; d <= half; d++) {
    // ── forward ──
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && vf[offset + k - 1]! < vf[offset + k + 1]!)) {
        x = vf[offset + k + 1]!;
      } else {
        x = vf[offset + k - 1]! + 1;
      }
      let y = x - k;
      const snakeX = x;
      const snakeY = y;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      vf[offset + k] = x;

      if (deltaOdd) {
        const rk = delta - k;
        // The reverse sweep has only reached diagonals in [-(d-1), d-1] at this point.
        if (rk >= -(d - 1) && rk <= d - 1 && x + vb[offset + rk]! >= n) {
          return { x0: snakeX, y0: snakeY, x1: x, y1: y, d: 2 * d - 1 };
        }
      }
    }

    // ── reverse ──
    // `k` here indexes reverse diagonals, measured from the bottom-right corner; the matching
    // forward diagonal is `delta - k`.
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && vb[offset + k - 1]! < vb[offset + k + 1]!)) {
        x = vb[offset + k + 1]!;
      } else {
        x = vb[offset + k - 1]! + 1;
      }
      let y = x - k;
      const snakeX = x;
      const snakeY = y;
      while (x < n && y < m && a[a0 + n - x - 1] === b[b0 + m - y - 1]) {
        x++;
        y++;
      }
      vb[offset + k] = x;

      if (!deltaOdd) {
        const fk = delta - k;
        if (fk >= -d && fk <= d && x + vf[offset + fk]! >= n) {
          // Translate back into forward coordinates.
          return { x0: n - x, y0: m - y, x1: n - snakeX, y1: m - snakeY, d: 2 * d };
        }
      }
    }
  }

  // Unreachable for finite inputs: the two sweeps must meet by D = n + m. Returning a
  // whole-range "snake" rather than throwing keeps a hypothetical bug here from turning into a
  // 500 on a user-facing route; the diff would be coarse, never wrong.
  return { x0: 0, y0: 0, x1: 0, y1: 0, d: max };
}

// ─── hunking ─────────────────────────────────────────────────────────────────

export interface HunkLine {
  type: 'context' | 'add' | 'remove';
  text: string;
  /** 1-based line number on the old side; null for additions. */
  oldLine: number | null;
  /** 1-based line number on the new side; null for removals. */
  newLine: number | null;
}

export interface Hunk {
  /** 1-based start line on the old side. 0 when the hunk is pure insertion at the top. */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
}

export interface DiffSummary {
  hunks: Hunk[];
  added: number;
  removed: number;
}

/**
 * Collapse an edit script into unified-diff hunks with `context` lines of surrounding
 * context.
 *
 * Without this, a one-word change in a 5,000-line section returns 5,000 lines of "equal" and
 * the client has to find the change itself. Sections are long and edits are small; the whole
 * value of the endpoint is in the collapsing.
 */
export function toHunks(edits: readonly Edit[], context: number): DiffSummary {
  const hunks: Hunk[] = [];
  let added = 0;
  let removed = 0;

  // Indices of every changed edit, so the runs of context around them can be computed
  // without repeatedly scanning.
  const changed: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i] as Edit;
    if (edit.op === 'insert') {
      added++;
      changed.push(i);
    } else if (edit.op === 'delete') {
      removed++;
      changed.push(i);
    }
  }

  if (changed.length === 0) return { hunks, added, removed };

  // Group changes whose context windows touch or overlap into one hunk.
  let groupStart = Math.max((changed[0] as number) - context, 0);
  let groupEnd = Math.min((changed[0] as number) + context, edits.length - 1);

  for (let i = 1; i < changed.length; i++) {
    const idx = changed[i] as number;
    if (idx - context <= groupEnd + 1) {
      groupEnd = Math.min(idx + context, edits.length - 1);
    } else {
      hunks.push(buildHunk(edits, groupStart, groupEnd));
      groupStart = Math.max(idx - context, 0);
      groupEnd = Math.min(idx + context, edits.length - 1);
    }
  }
  hunks.push(buildHunk(edits, groupStart, groupEnd));

  return { hunks, added, removed };
}

function buildHunk(edits: readonly Edit[], from: number, to: number): Hunk {
  const lines: HunkLine[] = [];
  let oldStart = 0;
  let newStart = 0;
  let oldCount = 0;
  let newCount = 0;

  for (let i = from; i <= to; i++) {
    const edit = edits[i] as Edit;
    const oldLine = edit.oldIndex === null ? null : edit.oldIndex + 1;
    const newLine = edit.newIndex === null ? null : edit.newIndex + 1;

    if (oldLine !== null && oldStart === 0) oldStart = oldLine;
    if (newLine !== null && newStart === 0) newStart = newLine;
    if (oldLine !== null) oldCount++;
    if (newLine !== null) newCount++;

    lines.push({
      type: edit.op === 'equal' ? 'context' : edit.op === 'insert' ? 'add' : 'remove',
      text: edit.text,
      oldLine,
      newLine,
    });
  }

  return { oldStart, oldLines: oldCount, newStart, newLines: newCount, lines };
}
