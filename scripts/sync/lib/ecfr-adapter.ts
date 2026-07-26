/**
 * Adapter over `@ecfr-atlas/ecfr`.
 *
 * That package is built in parallel with this one, so this module is the single place where
 * an assumption about its surface lives. Everything downstream depends on the interfaces
 * declared here, which means a signature change upstream is a one-file fix and a typecheck
 * error rather than a runtime failure at 3am halfway through a corpus pull.
 *
 * The import is dynamic and lazy on purpose: `db-reset`, the unit tests and the render
 * planner all run without it, and a package that does not exist yet must not break them.
 *
 * ASSUMED SURFACE (mirrored in contractNotes):
 *   new EcfrClient(opts)  .fetchAgencies() .fetchTitles() .fetchStructure(n, date)
 *                         .fetchTitleXml(n, date, {part?, section?}) .fetchVersions(n, {issueDateGte?})
 *   parser                .findNode(doc, selector) .extractText(node) .toHtml(node)
 *   wordcount             .countWords(text) .measureNode(node)
 *
 * Two things the brief left open and this adapter therefore pins down:
 *   - `findNode` needs a way to say WHICH node. It is called with `{ type, identifier }`.
 *   - Nothing was specified for turning an XML string into whatever `findNode` traverses, so
 *     the adapter accepts `parse` / `parseXml` / `parseDocument` under any of those names and
 *     falls back to handing `findNode` the raw string.
 */

import type { Measurement } from '@ecfr-atlas/core';
import type { Agency, ContentVersion, StructureNode, Title } from '@ecfr-atlas/core/ecfr-schemas';

/**
 * Note what is NOT here: a per-client rate.
 *
 * `@ecfr-atlas/ecfr` defaults every client to a process-wide `RateGovernor` so that all
 * callers share one budget. eCFR's limiter is a token bucket, not a concurrency gate, so a
 * per-client rate would let two clients in one process quietly double the real rate. The
 * ceiling is therefore configured once, on the SHARED governor — see
 * `installSharedRateGovernor` and `SyncConfig.maxRps`.
 */
export interface EcfrClientOptions {
  userAgent?: string;
  baseUrl?: string;
}

/**
 * The governor surface this pipeline uses. Only the two entry points it needs, so a change to
 * the governor's own options object is not a change to this file.
 */
export interface RateGovernorLike {
  readonly ratePerSecond: number;
}

export interface RateGovernorCtor {
  new (options: { ratePerSecond?: number }): RateGovernorLike;
}

export interface EcfrSliceOptions {
  /** Only `?part=` and `?section=` actually slice a title. `?chapter=` validates and returns */
  /** the WHOLE title, which is the trap that produced the predecessor's invented counts. */
  part?: string;
  section?: string;
}

/**
 * Why these are the client's RESULT types, not eCFR's response shapes.
 *
 * `@ecfr-atlas/ecfr` validates every response against the core Zod schemas and then returns a
 * digested result — `importInProgress` instead of `meta.import_in_progress`, a `truncation`
 * record instead of a row count to second-guess. Re-parsing here would validate twice and,
 * worse, would parse the wrong shape. This pipeline consumes the digest.
 *
 * Declared structurally rather than by importing the client's own interfaces so that `zod`
 * (not resolvable from `scripts/`, which is not a workspace package) stays out of this
 * module's type surface.
 */
export interface AgenciesResult {
  agencies: Agency[];
}

export interface TitlesResult {
  titles: Title[];
  /** eCFR's snapshot date for the listing, when it reports one. */
  date: string | null;
  /** TRUE means eCFR is mid-import and the run must abort. */
  importInProgress: boolean;
}

export interface VersionsTruncation {
  rows: number;
  reason: string;
}

export interface VersionsResult {
  versions: ContentVersion[];
  /**
   * `meta.total_pages`, coerced from the STRING eCFR sends. Present on unfiltered responses
   * (title 12's full history is 18,752 rows over 19 pages) and absent on filtered ones, which
   * is why `truncation` exists at all.
   */
  totalPages: number | null;
  /**
   * `meta.page` — which page eCFR says it served, coerced from its STRING form.
   *
   * The pager compares this against the page it asked for. That is the only DIRECT evidence
   * that `page` was honoured; everything else is inference from whether the rows looked new.
   * Null when eCFR omits the field, which it does when the result fits on one page.
   */
  page: number | null;
  /** Non-null when the page may be silently short. Authoritative; do not re-derive it. */
  truncation: VersionsTruncation | null;
}

/**
 * Filters on `/versions`. `page` is 1-based and the page size is fixed upstream at 1,000.
 *
 * A backfill MUST page: `runBackfill` writes the full amendment history per title, and
 * requesting page 1 of 19 and stopping would leave 94% of title 12's history missing while
 * every downstream chart still rendered confidently. `fetchAllVersions` in versions.ts refuses
 * to accept a response that shows the page parameter was ignored.
 */
export interface VersionsFilters {
  issueDateGte?: string;
  page?: number;
}

export interface EcfrClientLike {
  fetchAgencies(): Promise<AgenciesResult>;
  fetchTitles(): Promise<TitlesResult>;
  fetchStructure(title: number, date: string): Promise<StructureNode>;
  /** `slice` is positional third — only `part` and `section` actually slice a title. */
  fetchTitleXml(title: number, date: string, slice?: EcfrSliceOptions): Promise<string>;
  fetchVersions(title: number, filters?: VersionsFilters): Promise<VersionsResult>;
}

/** How this pipeline names a node to the parser. */
export interface NodeSelector {
  type: string;
  identifier: string;
}

// The parsed document is opaque to this module — it belongs to the parser. `unknown` rather
// than `any` so nothing here can accidentally call into it. `ParsedNode` covers "no such
// node" itself rather than being unioned with null at each use, because `unknown | null`
// collapses back to `unknown` and reads as though the null were load-bearing when it is not.
export type ParsedDocument = unknown;
export type ParsedNode = unknown;

/** `toHtml` returns the markup PLUS extracted metadata, not a bare string. */
export interface RenderedNode {
  html: string;
  meta: {
    heading: string | null;
    authority: string[];
    source: string[];
    frCitations: string[];
  };
}

export interface EcfrParserLike {
  parse(xml: string): ParsedDocument;
  /** Returns null (or undefined) when the node is absent; callers must check both. */
  findNode(doc: ParsedDocument, selector: NodeSelector): ParsedNode;
  extractText(node: ParsedNode): string;
  toHtml(node: ParsedNode): RenderedNode;
}

export interface EcfrWordcountLike {
  countWords(text: string): number;
  measureNode(node: ParsedNode): Measurement;
  /**
   * The text a node owns DIRECTLY, excluding every nested structure node.
   *
   * The composition the whole roll-up rests on:
   *
   *     measureNode(parent) === measureOwnText(parent) + Σ measureNode(child)
   *
   * A parent is therefore not the sum of its children. Measured upstream across seven parts:
   * 29 CFR 1910 carries 146 words directly under the part, 21 CFR 201 carries 15, 26 CFR 20
   * carries 5. Composing a parent from children alone silently drops those — an under-report,
   * which is the failure mode that looks most like a plausible number. `rollUpTree` feeds this
   * in as one more addend so the identity holds by construction rather than by luck.
   */
  measureOwnText(node: ParsedNode): Measurement;
}

export interface EcfrModule {
  EcfrClient: new (options: EcfrClientOptions) => EcfrClientLike;
  parser: EcfrParserLike;
  wordcount: EcfrWordcountLike;
  /**
   * Replace the process-wide governor. Null resets it to the package default.
   *
   * Optional: a build of `@ecfr-atlas/ecfr` without it simply runs at the package default
   * rate, which is the same 8 req/s. `installSharedRateGovernor` says so out loud rather than
   * letting a configured `ECFR_MAX_RPS` look effective when it is not.
   */
  setSharedRateGovernor?: (governor: RateGovernorLike | null) => void;
  RateGovernor?: RateGovernorCtor;
}

/** Pull a member out of either a namespace export or a flat named export. */
function pick<T>(mod: Record<string, unknown>, namespace: string, member: string): T | undefined {
  const ns = mod[namespace];
  if (ns && typeof ns === 'object' && member in (ns as Record<string, unknown>)) {
    return (ns as Record<string, T>)[member];
  }
  return mod[member] as T | undefined;
}

let cached: EcfrModule | null = null;

export async function loadEcfr(): Promise<EcfrModule> {
  if (cached) return cached;

  let raw: Record<string, unknown>;
  try {
    raw = await import('@ecfr-atlas/ecfr');
  } catch (error) {
    throw new Error(
      `could not load @ecfr-atlas/ecfr. Run \`pnpm install\` and make sure the package is built ` +
        `or exports TypeScript sources. Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const EcfrClient = raw.EcfrClient as EcfrModule['EcfrClient'] | undefined;
  const findNode = pick<EcfrParserLike['findNode']>(raw, 'parser', 'findNode');
  const extractText = pick<EcfrParserLike['extractText']>(raw, 'parser', 'extractText');
  const toHtml = pick<EcfrParserLike['toHtml']>(raw, 'parser', 'toHtml');
  const countWords = pick<EcfrWordcountLike['countWords']>(raw, 'wordcount', 'countWords');
  const measureNode = pick<EcfrWordcountLike['measureNode']>(raw, 'wordcount', 'measureNode');
  const measureOwnText = pick<EcfrWordcountLike['measureOwnText']>(
    raw,
    'wordcount',
    'measureOwnText',
  );

  const missing = Object.entries({
    EcfrClient,
    findNode,
    extractText,
    toHtml,
    countWords,
    measureNode,
    measureOwnText,
  })
    .filter(([, value]) => typeof value !== 'function')
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `@ecfr-atlas/ecfr is missing required exports: ${missing.join(', ')}. ` +
        `scripts/sync/lib/ecfr-adapter.ts documents the surface it expects.`,
    );
  }

  const parse =
    pick<(xml: string) => ParsedDocument>(raw, 'parser', 'parse') ??
    pick<(xml: string) => ParsedDocument>(raw, 'parser', 'parseXml') ??
    pick<(xml: string) => ParsedDocument>(raw, 'parser', 'parseDocument') ??
    // No parse step exported: assume findNode takes the XML string itself.
    ((xml: string): ParsedDocument => xml);

  cached = {
    EcfrClient: EcfrClient as EcfrModule['EcfrClient'],
    parser: {
      parse,
      findNode: findNode as EcfrParserLike['findNode'],
      extractText: extractText as EcfrParserLike['extractText'],
      toHtml: toHtml as EcfrParserLike['toHtml'],
    },
    wordcount: {
      countWords: countWords as EcfrWordcountLike['countWords'],
      measureNode: measureNode as EcfrWordcountLike['measureNode'],
      measureOwnText: measureOwnText as EcfrWordcountLike['measureOwnText'],
    },
    ...(typeof raw.setSharedRateGovernor === 'function'
      ? {
          setSharedRateGovernor: raw.setSharedRateGovernor as NonNullable<
            EcfrModule['setSharedRateGovernor']
          >,
        }
      : {}),
    ...(typeof raw.RateGovernor === 'function'
      ? { RateGovernor: raw.RateGovernor as RateGovernorCtor }
      : {}),
  };
  return cached;
}

/**
 * Point the process-wide governor at the configured ceiling.
 *
 * Called once, before any client is constructed, so every request in the process — including
 * ones made by code that constructs its own client — draws on the same bucket. Returns the
 * rate actually in force, which is what the caller should log: an `ECFR_MAX_RPS` that was
 * accepted by config and then silently ignored here is worse than one that was never set.
 */
export function installSharedRateGovernor(
  ecfr: EcfrModule,
  ratePerSecond: number,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
): number | null {
  const { RateGovernor, setSharedRateGovernor } = ecfr;
  if (!RateGovernor || !setSharedRateGovernor) {
    log.warn(
      'this build of @ecfr-atlas/ecfr exposes no shared RateGovernor; ECFR_MAX_RPS cannot be ' +
        'applied and the package default rate is in force',
      { requested: ratePerSecond },
    );
    return null;
  }
  const governor = new RateGovernor({ ratePerSecond });
  setSharedRateGovernor(governor);
  return governor.ratePerSecond;
}

/** Test seam: inject a fake module so the pipeline can be exercised without the network. */
export function __setEcfrModule(mod: EcfrModule | null): void {
  cached = mod;
}
