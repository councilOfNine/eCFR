/**
 * /v1/diff: resolve, memoise, serve.
 *
 * Cache policy, in order:
 *   1. R2, keyed on (title, section, from_issue_date, to_issue_date). A resolved diff is a
 *      pure function of those four values, so the memo is permanent — never invalidated,
 *      only superseded by bumping DIFF_R2_PREFIX.
 *   2. On miss, fetch both sides, diff, PUT, return. First viewer pays; everyone after is
 *      served from R2 and the edge cache.
 *   3. Failures are negative-cached briefly. eCFR's 504 is a coin flip (isolated title-49
 *      fetches failed 2 of 4 times), so a permanent negative memo would freeze a transient
 *      outage into a permanent answer — but re-fetching on every retry of a genuinely broken
 *      pair would turn one bad citation into a traffic amplifier.
 *
 * The rule that governs every branch below: a side we could not fetch is `unavailable`. It is
 * never rendered as an addition or a deletion. "Section added" for a section that has existed
 * since 1978, because the old-side fetch 429'd, is the failure this endpoint was rewritten to
 * make impossible.
 */

import {
  DIFF_CONTEXT_LINES,
  DIFF_MAX_LINES,
  DIFF_NEGATIVE_TTL_SECONDS,
  DIFF_R2_PREFIX,
} from '../constants/config.js';
import {
  diffNoTextNote,
  diffTooLargeNote,
  diffUnavailableNote,
  sectionMissingFromDocumentReason,
  sideParseFailedReason,
} from '../constants/messages.js';
import {
  assertNever,
  DiffOutcome,
  DiffStatus,
  FetchOutcomeKind,
  MemoKind,
  SideKind,
} from '../enums.js';
import { type FetchDeps, type FetchOutcome, fetchSectionXml, sectionHumanUrl } from './ecfr.js';
import { diffLines, type Hunk, toHunks } from './myers.js';
import { diffCacheKey } from './section-id.js';
import { extractSectionLines } from './xml-text.js';

/**
 * The response body.
 *
 * Structurally compatible with `DiffResponse` in @ecfr-atlas/core/api-schemas — every field
 * that schema names is present with the same meaning — plus additive fields the core schema
 * does not yet carry. Zod objects strip unknown keys rather than rejecting them, so a client
 * validating against core still parses this. See the module note in src/schemas.ts.
 */
export interface DiffBody {
  title: number;
  section: string;
  /** The newer side. Always an ISSUE date. */
  issue_date: string;
  /** The older side. */
  compared_to: string;
  status: DiffStatus;
  added: number | null;
  removed: number | null;
  hunks: Hunk[];
  note: string | null;
  cached: boolean;

  // ── additive ──
  old_available: boolean;
  new_available: boolean;
  old_line_count: number | null;
  new_line_count: number | null;
  computed_at: string;
  old_ecfr_url: string;
  new_ecfr_url: string;
}

/** What is actually written to R2. `cached` is a property of the read, not of the memo. */
type StoredMemo =
  | { v: 1; kind: typeof MemoKind.Diff; body: Omit<DiffBody, 'cached'> }
  | { v: 1; kind: typeof MemoKind.Negative; reason: string; expires_at: string };

export interface DiffRequest {
  title: number;
  section: string;
  from: string;
  to: string;
}

export interface DiffDeps extends FetchDeps {
  bucket: R2Bucket;
  /** False for tiers that may read the memo but not spend an upstream fetch. */
  mayCompute: boolean;
  now?: () => Date;
}

export type DiffResult =
  | { outcome: typeof DiffOutcome.Served; body: DiffBody }
  /** Cache miss and the caller's tier is not allowed to spend an upstream fetch. */
  | { outcome: typeof DiffOutcome.ComputeNotAllowed };

export async function getDiff(req: DiffRequest, deps: DiffDeps): Promise<DiffResult> {
  const now = deps.now ?? (() => new Date());
  const key = diffCacheKey(DIFF_R2_PREFIX, req.title, req.section, req.from, req.to);

  const memo = await readMemo(deps.bucket, key, now(), req);
  if (memo) return { outcome: DiffOutcome.Served, body: { ...memo, cached: true } };

  if (!deps.mayCompute) return { outcome: DiffOutcome.ComputeNotAllowed };

  const body = await compute(req, deps, now());

  // Only the R2 write is deferred-safe; the response does not depend on it landing. A failed
  // PUT costs the next viewer a recompute, which is strictly better than failing this request.
  const stored: StoredMemo =
    body.status === DiffStatus.Unavailable
      ? {
          v: 1,
          kind: MemoKind.Negative,
          reason: body.note ?? DiffStatus.Unavailable,
          expires_at: new Date(now().getTime() + DIFF_NEGATIVE_TTL_SECONDS * 1000).toISOString(),
        }
      : { v: 1, kind: MemoKind.Diff, body: stripCached(body) };

  await deps.bucket
    .put(key, JSON.stringify(stored), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: {
        title: String(req.title),
        section: req.section,
        from: req.from,
        to: req.to,
        status: body.status,
      },
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'diff_memo_put_failed',
          key,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });

  return { outcome: DiffOutcome.Served, body };
}

function stripCached(body: DiffBody): Omit<DiffBody, 'cached'> {
  const { cached: _cached, ...rest } = body;
  return rest;
}

async function readMemo(
  bucket: R2Bucket,
  key: string,
  now: Date,
  req: DiffRequest,
): Promise<Omit<DiffBody, 'cached'> | null> {
  const object = await bucket.get(key);
  if (!object) return null;

  let parsed: StoredMemo;
  try {
    parsed = await object.json<StoredMemo>();
  } catch {
    // A corrupt memo must not become a 500 on a public route. Treat it as a miss; the
    // recompute overwrites it.
    return null;
  }

  switch (parsed.kind) {
    case MemoKind.Negative:
      // Expired negative entries fall through to a recompute and overwrite this object.
      if (new Date(parsed.expires_at).getTime() > now.getTime()) {
        return negativeBody(req, parsed.reason, now);
      }
      return null;
    case MemoKind.Diff:
      return parsed.body;
    default:
      // NOT assertNever: `parsed` came off disk, and an unrecognised kind is the corrupt-memo
      // case again — a miss to recompute over, never a 500 on a public route.
      return null;
  }
}

/**
 * Rehydrate a still-valid negative memo.
 *
 * A negative entry stores only the reason, and the identifying fields are rebuilt from the
 * request rather than read back from the object. That is deliberate: a negative memo can then
 * never carry hunks or counts left over from a previous successful run, because it has no
 * room to hold any.
 */
function negativeBody(req: DiffRequest, reason: string, now: Date): Omit<DiffBody, 'cached'> {
  return {
    title: req.title,
    section: req.section,
    issue_date: req.to,
    compared_to: req.from,
    status: DiffStatus.Unavailable,
    added: null,
    removed: null,
    hunks: [],
    note: reason,
    old_available: false,
    new_available: false,
    old_line_count: null,
    new_line_count: null,
    computed_at: now.toISOString(),
    old_ecfr_url: sectionHumanUrl(req.title, req.section, req.from),
    new_ecfr_url: sectionHumanUrl(req.title, req.section, req.to),
  };
}

async function compute(req: DiffRequest, deps: DiffDeps, now: Date): Promise<DiffBody> {
  const base = {
    title: req.title,
    section: req.section,
    issue_date: req.to,
    compared_to: req.from,
    cached: false,
    computed_at: now.toISOString(),
    old_ecfr_url: sectionHumanUrl(req.title, req.section, req.from),
    new_ecfr_url: sectionHumanUrl(req.title, req.section, req.to),
  };

  // Both sides in parallel. Two requests is well under the <=8 req/s that is clean upstream,
  // and serialising them would not help anyway: the limiter is a token bucket, not a
  // concurrency gate.
  const [oldSide, newSide] = await Promise.all([
    resolveSide(req.title, req.section, req.from, deps),
    resolveSide(req.title, req.section, req.to, deps),
  ]);

  if (oldSide.kind === SideKind.Failed || newSide.kind === SideKind.Failed) {
    const reasons: string[] = [];
    if (oldSide.kind === SideKind.Failed) reasons.push(`${req.from}: ${oldSide.reason}`);
    if (newSide.kind === SideKind.Failed) reasons.push(`${req.to}: ${newSide.reason}`);
    return {
      ...base,
      status: DiffStatus.Unavailable,
      added: null,
      removed: null,
      hunks: [],
      note: diffUnavailableNote(reasons),
      old_available: oldSide.kind === SideKind.Present,
      new_available: newSide.kind === SideKind.Present,
      old_line_count: oldSide.kind === SideKind.Present ? oldSide.lines.length : null,
      new_line_count: newSide.kind === SideKind.Present ? newSide.lines.length : null,
    };
  }

  if (oldSide.kind === SideKind.Absent && newSide.kind === SideKind.Absent) {
    return {
      ...base,
      status: DiffStatus.Unavailable,
      added: null,
      removed: null,
      hunks: [],
      note: diffNoTextNote(req.title, req.section),
      old_available: false,
      new_available: false,
      old_line_count: null,
      new_line_count: null,
    };
  }

  const oldLines = oldSide.kind === SideKind.Present ? oldSide.lines : [];
  const newLines = newSide.kind === SideKind.Present ? newSide.lines : [];

  // Only reached when the missing side came back as an explicit HTTP 404 — the one signal
  // eCFR gives that means "this did not exist", as opposed to "we could not tell".
  if (oldSide.kind === SideKind.Absent) {
    return {
      ...base,
      status: DiffStatus.Added,
      added: newLines.length,
      removed: 0,
      hunks: capOrHunk(diffLines([], newLines)),
      note: null,
      old_available: false,
      new_available: true,
      old_line_count: 0,
      new_line_count: newLines.length,
    };
  }
  if (newSide.kind === SideKind.Absent) {
    return {
      ...base,
      status: DiffStatus.Removed,
      added: 0,
      removed: oldLines.length,
      hunks: capOrHunk(diffLines(oldLines, [])),
      note: null,
      old_available: true,
      new_available: false,
      old_line_count: oldLines.length,
      new_line_count: 0,
    };
  }

  // Both present. The cap is checked BEFORE the diff runs, not after — the point is to never
  // start unbounded work, not to notice afterwards that it was expensive.
  if (oldLines.length > DIFF_MAX_LINES || newLines.length > DIFF_MAX_LINES) {
    return {
      ...base,
      status: DiffStatus.TooLarge,
      added: null,
      removed: null,
      hunks: [],
      note: diffTooLargeNote(Math.max(oldLines.length, newLines.length), DIFF_MAX_LINES),
      old_available: true,
      new_available: true,
      old_line_count: oldLines.length,
      new_line_count: newLines.length,
    };
  }

  const edits = diffLines(oldLines, newLines);
  const summary = toHunks(edits, DIFF_CONTEXT_LINES);

  return {
    ...base,
    status:
      summary.added === 0 && summary.removed === 0 ? DiffStatus.Unchanged : DiffStatus.Modified,
    added: summary.added,
    removed: summary.removed,
    hunks: summary.hunks,
    note: null,
    old_available: true,
    new_available: true,
    old_line_count: oldLines.length,
    new_line_count: newLines.length,
  };
}

function capOrHunk(edits: ReturnType<typeof diffLines>): Hunk[] {
  // A pure add or delete has every line changed, so context grouping produces one hunk.
  if (edits.length > DIFF_MAX_LINES) return [];
  return toHunks(edits, DIFF_CONTEXT_LINES).hunks;
}

type SideResult =
  | { kind: typeof SideKind.Present; lines: string[] }
  | { kind: typeof SideKind.Absent }
  | { kind: typeof SideKind.Failed; reason: string };

async function resolveSide(
  title: number,
  section: string,
  issueDate: string,
  deps: FetchDeps,
): Promise<SideResult> {
  const outcome: FetchOutcome = await fetchSectionXml(title, section, issueDate, deps);

  switch (outcome.kind) {
    case FetchOutcomeKind.Absent:
      return { kind: SideKind.Absent };
    case FetchOutcomeKind.Failed:
      return { kind: SideKind.Failed, reason: outcome.reason };
    case FetchOutcomeKind.Ok:
      return extractSide(outcome.xml, section, issueDate);
    default:
      return assertNever(outcome, 'FetchOutcome');
  }
}

function extractSide(xml: string, section: string, issueDate: string): SideResult {
  let extracted: ReturnType<typeof extractSectionLines>;
  try {
    extracted = extractSectionLines(xml, section);
  } catch (error) {
    return {
      kind: SideKind.Failed,
      reason: sideParseFailedReason(
        issueDate,
        error instanceof Error ? error.message : 'unknown parser error',
      ),
    };
  }

  if (extracted.sectionFound) return { kind: SideKind.Present, lines: extracted.lines };

  // The section element was not in the response. If the document had no text at all, eCFR
  // genuinely served an empty slice and the section did not exist at that date. If it had
  // text, we got a document that is not what we asked for — that is a failure, not an
  // absence, and guessing which would be exactly the sort of inference this project bans.
  return extracted.documentHasText
    ? { kind: SideKind.Failed, reason: sectionMissingFromDocumentReason(issueDate, section) }
    : { kind: SideKind.Absent };
}
