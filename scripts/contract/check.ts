#!/usr/bin/env node
/**
 * Scheduled contract test against the live eCFR API.
 *
 * The nightly sync is only as trustworthy as its assumptions about upstream. This job proves
 * those assumptions still hold, every weekday, BEFORE the sync runs — so a shape change shows
 * up as a labelled issue rather than as a corrupted word count nobody notices for a month.
 *
 * The hard part is not fetching. It is telling two failures apart:
 *
 *   THROTTLED — eCFR rate-limits with a token bucket. Two distinct signatures, both measured:
 *     a 162-byte bare-nginx 429 with no Retry-After returning in ~0.13 s, and a 246-byte 504
 *     after ~50 s when origin XML generation times out on a large title (isolated sequential
 *     title-49 fetches failed 2 of 4 times — a coin flip, not an error). Neither says anything
 *     about the contract.
 *
 *   BROKEN — a 200 with a JSON content-type whose body no longer satisfies the Zod schema, or
 *     a 404 on an endpoint we depend on.
 *
 * Conflating them is not a cosmetic problem. If throttling reads as a breaking change, the
 * maintainer gets a false alarm most weeks, learns to close the issue unread, and is not
 * looking on the week it is real. So: transient exits 75 and opens nothing.
 *
 * Exit codes:  0 = contract holds · 1 = contract broken · 75 = transient upstream (EX_TEMPFAIL)
 * Usage:       node scripts/contract/check.ts [--json report.json] [--markdown report.md]
 *
 * Imports the BUILT core output rather than the .ts source: the schemas under test must be the
 * exact artefact the sync pipeline runs, not a separately-transpiled copy of it.
 */

import { writeFile } from 'node:fs/promises';
import { ECFR_SCHEMAS } from '../../packages/core/dist/ecfr-schemas.js';
// Built output on both imports, same reasoning as the schemas: no resolve hook is installed
// here, and the artefact under test must be the exact one the pipeline runs.
import { assertNever } from '../../packages/core/dist/enums.js';

const BASE = 'https://www.ecfr.gov';

/**
 * eCFR asks automated clients to identify themselves, and a contactable UA is the difference
 * between being rate-limited and being blocked. Never scrape ecfr.gov HTML from here — those
 * requests get 302'd to a CAPTCHA.
 */
const USER_AGENT =
  'ecfr-atlas-contract-test/0.1 ' +
  `(+https://github.com/${process.env.GITHUB_REPOSITORY ?? 'ecfr-atlas/ecfr-atlas'})`;

/** Statuses that mean "upstream is busy", never "upstream changed". */
const TRANSIENT_STATUS: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

const EXIT_OK = 0;
const EXIT_BROKEN = 1;
const EXIT_TRANSIENT = 75;

type SchemaName = keyof typeof ECFR_SCHEMAS;

/** The Zod OUTPUT of a named schema, taken from core's build so the two cannot drift. */
type SchemaData<K extends SchemaName> = ReturnType<(typeof ECFR_SCHEMAS)[K]['parse']>;

/**
 * The retry classification this whole file exists to get right. `pass`/`transient`/`broken`
 * are the three verdicts a check can reach; the overall run collapses them to
 * `ok`/`transient`/`broken` (a run with zero failing checks is `ok`, not `pass`).
 */
const CheckOutcome = {
  pass: 'pass',
  transient: 'transient',
  broken: 'broken',
} as const;
type CheckOutcome = (typeof CheckOutcome)[keyof typeof CheckOutcome];

const RunOutcome = {
  ok: 'ok',
  transient: 'transient',
  broken: 'broken',
} as const;
type RunOutcome = (typeof RunOutcome)[keyof typeof RunOutcome];

interface CheckRecord {
  name: string;
  url: string;
  status: number | null;
  contentType: string | null;
  bytes: number | null;
  ms: number;
  result: CheckOutcome;
  detail: string | null;
}

const checks: CheckRecord[] = [];
/** Non-fatal notes: upstream behaviour we document but do not depend on. */
const observations: string[] = [];

class Transient extends Error {}
class Broken extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FetchOutcome {
  response: Response;
  body: string;
  ms: number;
  contentType: string | null;
}

/**
 * Blind exponential backoff with jitter. eCFR's 429 carries no Retry-After header, so there is
 * nothing to honour; we still read it when present in case that ever changes. The ceiling is
 * generous because the 504 case has already burned ~50 s upstream before we see it.
 */
async function fetchWithRetry(url: string, { attempts = 4 } = {}): Promise<FetchOutcome> {
  let last: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/json, application/xml;q=0.9, */*;q=0.1',
          // Always request gzip: the corpus compresses 4.96x and the polite thing to do with
          // someone else's bandwidth is not to ask for 810 MB uncompressed.
          'accept-encoding': 'gzip, deflate, br',
        },
        signal: AbortSignal.timeout(120_000),
        redirect: 'follow',
      });
    } catch (error) {
      last = new Transient(`network error: ${error instanceof Error ? error.message : error}`);
      if (attempt === attempts) throw last;
      await sleep(backoff(attempt));
      continue;
    }

    const body = await response.text();
    const ms = Date.now() - startedAt;
    const contentType = response.headers.get('content-type');

    if (response.ok) return { response, body, ms, contentType };

    if (TRANSIENT_STATUS.has(response.status)) {
      last = new Transient(
        `HTTP ${response.status} after ${ms} ms, ${body.length}-byte body ` +
          `(162 B = nginx 429, 246 B = origin 504 — both throttling, not drift)`,
      );
      if (attempt === attempts) throw last;
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt),
      );
      continue;
    }

    // 404/410/400 on an endpoint the pipeline depends on is a contract change, not weather.
    throw new Broken(`HTTP ${response.status} ${response.statusText} (${body.length}-byte body)`);
  }
  throw last ?? new Transient('exhausted retries');
}

function backoff(attempt: number): number {
  const base = Math.min(2 ** attempt * 1000, 30_000);
  return base + Math.floor(Math.random() * 1000);
}

/** The slice of a Zod error this report needs. Structural, so `zod` itself stays unimported. */
interface ZodIssueLike {
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

function formatZodIssues(error: { issues: ReadonlyArray<ZodIssueLike> }): string {
  return error.issues
    .slice(0, 25)
    .map((issue) => `  - ${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('\n');
}

/** Fetch, assert JSON, parse against the named schema from packages/core. */
async function checkJson<K extends SchemaName>(
  name: string,
  pathname: string,
  schemaName: K,
): Promise<SchemaData<K>> {
  const url = `${BASE}${pathname}`;
  const startedAt = Date.now();
  try {
    const { response, body, contentType } = await fetchWithRetry(url);

    // A 200 that is not JSON means an interstitial or an error page, not a schema change.
    if (!contentType?.includes('json')) {
      throw new Transient(`200 with content-type "${contentType}" — not a JSON response`);
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Transient(
        `200 with a JSON content-type but an unparseable body (${body.length} B)`,
      );
    }

    const parsed = ECFR_SCHEMAS[schemaName].safeParse(json);
    if (!parsed.success) {
      throw new Broken(
        `response no longer satisfies the ${schemaName} schema:\n${formatZodIssues(parsed.error)}`,
      );
    }

    record(
      name,
      url,
      response.status,
      contentType,
      body.length,
      startedAt,
      CheckOutcome.pass,
      null,
    );
    return parsed.data as SchemaData<K>;
  } catch (error) {
    return fail(name, url, startedAt, error);
  }
}

function record(
  name: string,
  url: string,
  status: number | null,
  contentType: string | null,
  bytes: number | null,
  startedAt: number,
  result: CheckOutcome,
  detail: string | null,
): void {
  checks.push({
    name,
    url,
    status,
    contentType,
    bytes,
    ms: Date.now() - startedAt,
    result,
    detail,
  });
}

function fail(name: string, url: string, startedAt: number, error: unknown): never {
  const transient = error instanceof Transient;
  const message = error instanceof Error ? error.message : String(error);
  record(
    name,
    url,
    null,
    null,
    null,
    startedAt,
    transient ? CheckOutcome.transient : CheckOutcome.broken,
    message,
  );
  throw error;
}

/**
 * Invariants that are not schema-shaped but that the pipeline still relies on. Recorded as
 * their own rows so a failure names itself in the report instead of appearing as a bare
 * exception with every listed check showing green.
 */
function assertInvariant(name: string, condition: boolean, detail: string): void {
  const startedAt = Date.now();
  const url = `${BASE}/api/versioner/v1/titles.json`;
  if (condition) {
    record(name, url, 200, null, null, startedAt, CheckOutcome.pass, null);
    return;
  }
  record(name, url, 200, null, null, startedAt, CheckOutcome.broken, detail);
  throw new Broken(detail);
}

/**
 * The assertion that matters most.
 *
 * `?chapter=` and `?subtitle=` VALIDATE but DO NOT SLICE — they return the entire title. Only
 * `?part=` and `?section=` slice. The predecessor did not know this, its regex fallback kicked
 * in, and it published invented word counts. Every extraction path in this codebase is built on
 * `?part=` actually slicing, so that is asserted; the chapter behaviour is merely observed,
 * because if eCFR ever fixed it that would be good news, not a break.
 */
async function checkSlicingSemantics(
  date: string,
  title: number,
  part: string,
  chapter: string | null,
): Promise<void> {
  const name = 'full-xml slicing semantics';
  const wholeUrl = `${BASE}/api/versioner/v1/full/${date}/title-${title}.xml`;
  const startedAt = Date.now();
  try {
    const whole = await fetchWithRetry(wholeUrl);
    if (!whole.contentType?.includes('xml')) {
      throw new Transient(`full XML returned content-type "${whole.contentType}"`);
    }

    await sleep(250); // stay well under the measured 8 req/s clean rate
    const sliced = await fetchWithRetry(`${wholeUrl}?part=${encodeURIComponent(part)}`);

    if (sliced.body.length >= whole.body.length) {
      throw new Broken(
        `?part=${part} returned ${sliced.body.length} B against a ${whole.body.length} B whole ` +
          'title — it is no longer slicing. Every per-part fetch in the sync pipeline depends ' +
          'on this and would silently start counting whole titles.',
      );
    }

    if (chapter) {
      await sleep(250);
      const byChapter = await fetchWithRetry(`${wholeUrl}?chapter=${encodeURIComponent(chapter)}`);
      observations.push(
        byChapter.body.length === whole.body.length
          ? `\`?chapter=\` still returns the whole title (${whole.body.length} B) — the documented ` +
              'quirk holds; keep resolving chapters to their parts.'
          : `\`?chapter=\` now returns ${byChapter.body.length} B against a ${whole.body.length} B ` +
              'whole title. Upstream may have started slicing by chapter. Not a break — but the ' +
              'per-part fan-out could potentially be simplified. Verify before relying on it.',
      );
    }

    record(
      name,
      wholeUrl,
      200,
      whole.contentType,
      whole.body.length,
      startedAt,
      CheckOutcome.pass,
      `whole ${whole.body.length} B vs ?part=${part} ${sliced.body.length} B`,
    );
  } catch (error) {
    return fail(name, wholeUrl, startedAt, error);
  }
}

async function run(): Promise<void> {
  await checkJson('agencies.json', '/api/admin/v1/agencies.json', 'agencies');
  await sleep(250);

  const titles = await checkJson('titles.json', '/api/versioner/v1/titles.json', 'titles');
  await sleep(250);

  // Title 1 is the smallest non-reserved title; using it keeps this job cheap and polite.
  const probe = titles.titles.find((t) => t.number === 1 && !t.reserved);
  assertInvariant(
    'title 1 is present and non-reserved',
    Boolean(probe),
    'titles.json no longer contains a non-reserved title 1 to probe with',
  );
  const date = probe?.latest_issue_date ?? null;
  // Only reserved titles are supposed to have null dates (title 35 is the sole case). A null
  // on a live title means the three date fields no longer mean what the pipeline assumes.
  assertInvariant(
    'title 1 has a latest_issue_date',
    date !== null,
    'title 1 has a null latest_issue_date; only reserved titles should',
  );
  if (date === null) return; // unreachable: assertInvariant threw. Narrows for the compiler.

  // Guard the documented invariant that exactly one title (35) is reserved. A change here
  // silently alters the denominator of every corpus-wide figure we publish.
  const reserved = titles.titles.filter((t) => t.reserved).map((t) => t.number);
  const nonReserved = titles.titles.length - reserved.length;
  if (nonReserved !== 49) {
    observations.push(
      `Non-reserved title count is ${nonReserved}, not the documented 49 ` +
        `(reserved: ${reserved.join(', ') || 'none'}). Corpus totals and the ~11,100-page build ` +
        'estimate both assume 49.',
    );
  }

  await checkJson(
    'structure/title-1',
    `/api/versioner/v1/structure/${date}/title-1.json`,
    'structure',
  );
  await sleep(250);

  await checkJson('versions/title-1', '/api/versioner/v1/versions/title-1.json', 'versions');
  await sleep(250);

  // The filtered variant is a different response shape in practice: eCFR omits `total_pages`
  // when `issue_date[gte]` is present, so a truncated 1,000-row page is indistinguishable from
  // a complete one. The delta sync's short-window strategy exists because of this.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const filtered = await checkJson(
    'versions/title-1 (filtered)',
    `/api/versioner/v1/versions/title-1.json?issue_date%5Bgte%5D=${since}`,
    'versions',
  );
  if (filtered.meta?.total_pages !== undefined) {
    observations.push(
      '`issue_date[gte]` responses now include `meta.total_pages`. If that is reliable, the ' +
        'delta sync no longer has to treat an exactly-1000-row page as suspicious.',
    );
  }
  await sleep(250);

  // Part 1 exists in title 1 (Chapter I, "Administrative Committee of the Federal Register").
  await checkSlicingSemantics(date, 1, '1', 'I');
}

function markdown(status: RunOutcome): string {
  const icon: Record<CheckOutcome, string> = { pass: 'PASS', transient: 'SKIP', broken: 'FAIL' };
  const lines = [
    `# eCFR contract check — ${status.toUpperCase()}`,
    '',
    `Checked at ${new Date().toISOString()} against ${BASE}.`,
    '',
    '| check | result | HTTP | bytes | ms |',
    '| --- | --- | --- | --- | --- |',
    ...checks.map(
      (c) =>
        `| ${c.name} | ${icon[c.result]} | ${c.status ?? '—'} | ` +
        `${c.bytes?.toLocaleString('en-US') ?? '—'} | ${c.ms} |`,
    ),
    '',
  ];

  const problems = checks.filter((c) => c.result !== CheckOutcome.pass);
  if (problems.length > 0) {
    lines.push('## Details', '');
    for (const c of problems) {
      lines.push(
        `### ${c.name} — ${icon[c.result]}`,
        '',
        `\`${c.url}\``,
        '',
        '```',
        c.detail ?? '',
        '```',
        '',
      );
    }
  }

  if (observations.length > 0) {
    lines.push('## Observations', '', ...observations.map((o) => `- ${o}`), '');
  }

  if (status === RunOutcome.broken) {
    lines.push(
      '## What to do',
      '',
      '1. Open the failing URL in a real browser — the eCFR developer docs 302 automated clients.',
      '2. Decide whether the change is additive (the schemas are `.loose()`, so it is safe to',
      '   ignore) or affects a field the pipeline reads.',
      '3. If it affects a depended-on field, update `packages/core/src/ecfr-schemas.ts` **and**',
      '   whatever reads it, in the same PR. Do not widen the schema to make this go green while',
      '   leaving the reader assuming the old shape.',
      '',
    );
  }

  lines.push(
    '---',
    '',
    'A `SKIP` means eCFR throttled or timed out (measured signatures: a 162-byte nginx 429, or',
    'a 246-byte 504 after ~50 s). That is weather, not drift, and this job deliberately does not',
    'open an issue for it.',
    '',
  );
  return lines.join('\n');
}

/** The one dispatch over the run outcome. Exhaustive: a fourth outcome will not compile. */
function exitCodeFor(status: RunOutcome): number {
  switch (status) {
    case RunOutcome.ok:
      return EXIT_OK;
    case RunOutcome.broken:
      return EXIT_BROKEN;
    case RunOutcome.transient:
      return EXIT_TRANSIENT;
    default:
      return assertNever(status, 'contract-check run outcome');
  }
}

let status: RunOutcome = RunOutcome.ok;
try {
  await run();
} catch (error) {
  // Only a Transient is allowed to downgrade to "come back later". Anything unclassified is a
  // bug in this checker, and a crashed checker that reports "throttled" every night is worse
  // than no checker at all — it looks like it is working.
  status = error instanceof Transient ? RunOutcome.transient : RunOutcome.broken;
  if (!(error instanceof Transient) && !(error instanceof Broken)) {
    observations.push(
      `The contract checker itself threw an unclassified error, which is a bug in ` +
        `scripts/contract/check.ts: ${error instanceof Error ? error.stack : String(error)}`,
    );
  }
  console.error(`contract check ${status}: ${error instanceof Error ? error.message : error}`);
}

const jsonPath = process.argv[process.argv.indexOf('--json') + 1];
const mdPath = process.argv[process.argv.indexOf('--markdown') + 1];
if (process.argv.includes('--json') && jsonPath) {
  await writeFile(
    jsonPath,
    `${JSON.stringify({ checkedAt: new Date().toISOString(), status, checks, observations }, null, 2)}\n`,
    'utf8',
  );
}
const md = markdown(status);
if (process.argv.includes('--markdown') && mdPath) await writeFile(mdPath, md, 'utf8');
if (process.env.GITHUB_STEP_SUMMARY) {
  await writeFile(process.env.GITHUB_STEP_SUMMARY, md, { encoding: 'utf8', flag: 'a' });
}
process.stdout.write(md);

process.exit(exitCodeFor(status));
