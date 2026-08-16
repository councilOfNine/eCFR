/**
 * Render planning: which HTML files exist, how big they are allowed to be, and how many of
 * them the free plan will accept.
 *
 * Two hard ceilings drive everything here, and neither is negotiable at build time:
 *
 *   - Workers Static Assets caps a single file at 25 MiB. 26 CFR Part 1 is 69,598,633 bytes
 *     of XML. Rendered as one page it does not deploy — the build fails at upload, after the
 *     whole corpus has been processed. It MUST be split.
 *
 *   - The free plan caps a deployment at 20,000 files. The planned site is ~11,100 pages, so
 *     there is real headroom, but part splitting is the one input that can grow without
 *     anyone noticing. CI fails at 18,000 so the ceiling is hit in a pull request rather than
 *     in a deploy.
 *
 * Splitting is planned from `xmlBytes` — eCFR's additive structure size — because the plan
 * has to exist before any XML is fetched. Size is used here purely as a bin-packing input;
 * it never becomes a published number.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path';

import type { FlatNode } from './structure.js';

/** Parts above this get split. 94 parts corpus-wide exceed it. */
export const SPLIT_THRESHOLD_BYTES = 1_000_000;

/**
 * Hard ceiling for one emitted file. The platform limit is 25 MiB; the margin absorbs the
 * HTML wrapper, which inflates raw XML rather than shrinking it.
 */
export const MAX_ASSET_BYTES = 24 * 1024 * 1024;

/** Target size for a group of sibling nodes packed into one page. */
export const TARGET_CHUNK_BYTES = 4 * 1024 * 1024;

/** CI fails above this. The platform refuses above 20,000. */
export const FILE_BUDGET_LIMIT = 18_000;

/** Logged as a warning so the ceiling is visible before it is hit. */
export const FILE_BUDGET_WARN = 16_000;

export interface RenderUnit {
  /** Site route. Citable, and stable as long as the identifiers are. */
  route: string;
  titleNumber: number;
  /** The part this unit belongs to. Equal to `citations[0]` when the part is not split. */
  partCitation: string;
  /** Nodes included, in document order. */
  citations: string[];
  /**
   * The content key. ONE string with three consumers, which is why it carries no extension:
   *
   *   - the R2 object key this unit's HTML is PUT to;
   *   - `structure_node.content_key`, which apps/api serves as `${publicBase}/${key}`;
   *   - the snapshot file the Astro build reads, which
   *     apps/web/src/data/sources/snapshot-dir.ts opens as `content/${key}.html`.
   *
   * It used to be `parts${route}.html`, which made the snapshot loader look for
   * `content/parts/title-40/chapter-I/part-60.html.html` and fail every part page. The
   * consumer owns the shape; the extension belongs to the file the consumer names, not to the
   * key. Mirrors the route otherwise, so an object can be found from a URL by eye.
   */
  contentKey: string;
  label: string;
  /** From the structure fingerprint. Planning input, not a measurement. */
  estimatedBytes: number;
  /** Null when the unit is a whole part. */
  splitOf: string | null;
}

export interface RenderPlan {
  units: RenderUnit[];
  /** Parts that had to be split, with how many pieces each became. */
  splits: Array<{ partCitation: string; pieces: number; estimatedBytes: number }>;
  /**
   * Nodes that exceed MAX_ASSET_BYTES on their own and cannot be split further. Empty on the
   * measured corpus — the largest single section is 50 CFR 17.95 at 5,010,215 B — but if a
   * future amendment creates one, this is the list that says so instead of a failed upload.
   */
  oversized: Array<{ citation: string; estimatedBytes: number }>;
}

function slugSegment(value: string): string {
  // Identifiers contain dots (`1.60`), and occasionally spaces or slashes. Slashes would
  // invent a route level, so they are the only ones that must go.
  return value.replace(/\//g, '-').replace(/\s+/g, '-');
}

/**
 * Route -> content key. `/title-40/chapter-I/part-60` becomes
 * `parts/title-40/chapter-I/part-60`.
 *
 * No leading slash (an R2 key beginning with `/` produces an object nobody can address by URL
 * without a double slash) and no extension (see `RenderUnit.contentKey`).
 */
export function contentKeyFor(route: string): string {
  return `parts${route}`;
}

/**
 * The inverse: content key -> the file `snapshot-dir.ts` opens as `content/${key}.html`.
 *
 * Lives beside `contentKeyFor` because the two must agree; the hydration step rebuilds the
 * whole content directory through this function, from keys listed out of the R2 bucket.
 *
 * Those keys are written by this pipeline, but they arrive over the network, and a key
 * carrying `../` would otherwise place a file anywhere the process can write. Refusing is
 * cheap and the check does not depend on trusting the bucket.
 */
export function contentPathFor(contentDir: string, contentKey: string): string {
  const target = resolvePath(contentDir, `${contentKey}.html`);
  const rel = relative(contentDir, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to write ${contentKey}: it escapes ${contentDir}`);
  }
  return target;
}

function routeFor(node: FlatNode): string {
  const parts = [`title-${node.titleNumber}`];
  if (node.chapterId) parts.push(`chapter-${slugSegment(node.chapterId)}`);
  if (node.identifier) parts.push(`part-${slugSegment(node.identifier)}`);
  return `/${parts.join('/')}`;
}

/**
 * Pack siblings into groups that stay under the target.
 *
 * Greedy first-fit in document order, never reordering: a page whose sections are out of
 * order is useless to the audience this site is for. A single child larger than the target
 * becomes its own group rather than being dropped.
 */
function packSiblings(children: readonly FlatNode[], targetBytes: number): FlatNode[][] {
  const groups: FlatNode[][] = [];
  let current: FlatNode[] = [];
  let currentBytes = 0;

  for (const child of children) {
    const bytes = child.xmlBytes ?? 0;
    if (current.length > 0 && currentBytes + bytes > targetBytes) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(child);
    currentBytes += bytes;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function rangeLabel(group: readonly FlatNode[]): string {
  const first = group[0];
  const last = group[group.length - 1];
  if (!first) return 'part';
  const firstId = first.identifier ?? first.citation.split('/').pop() ?? '';
  const lastId = last?.identifier ?? firstId;
  return group.length === 1 || firstId === lastId ? firstId : `${firstId}--${lastId}`;
}

/**
 * Plan one render unit per part, splitting the oversized ones.
 *
 * Splitting is recursive by intent but shallow in practice. The first attempt is the part's
 * direct children — usually subparts. 26 CFR Part 1 has no subparts at all; its direct
 * children are sections and subject groups, so the same code path packs those into ranges
 * instead. That is why the split is written against "direct children" rather than against
 * subparts specifically, despite subparts being the common case.
 */
export function planRender(nodes: readonly FlatNode[]): RenderPlan {
  const childrenOf = new Map<string, FlatNode[]>();
  const byCitation = new Map<string, FlatNode>();
  for (const node of nodes) byCitation.set(node.citation, node);
  for (const node of nodes) {
    if (!node.parentCitation) continue;
    const bucket = childrenOf.get(node.parentCitation);
    if (bucket) bucket.push(node);
    else childrenOf.set(node.parentCitation, [node]);
  }

  const plan: RenderPlan = { units: [], splits: [], oversized: [] };

  for (const part of nodes) {
    if (part.nodeType !== 'part') continue;

    const baseRoute = routeFor(part);
    const bytes = part.xmlBytes ?? 0;

    if (bytes <= SPLIT_THRESHOLD_BYTES) {
      plan.units.push({
        route: baseRoute,
        titleNumber: part.titleNumber,
        partCitation: part.citation,
        citations: [part.citation],
        contentKey: contentKeyFor(baseRoute),
        label: part.label,
        estimatedBytes: bytes,
        splitOf: null,
      });
      continue;
    }

    // Split. Descend until every group fits, so a huge subpart becomes several pages rather
    // than one that fails to upload.
    const groups: FlatNode[][] = [];
    const expand = (parent: FlatNode, depth: number): void => {
      const children = childrenOf.get(parent.citation) ?? [];
      if (children.length === 0) {
        // Nothing left to split by. Emit it and record it if it is over the ceiling.
        groups.push([parent]);
        if ((parent.xmlBytes ?? 0) > MAX_ASSET_BYTES) {
          plan.oversized.push({ citation: parent.citation, estimatedBytes: parent.xmlBytes ?? 0 });
        }
        return;
      }
      for (const group of packSiblings(children, TARGET_CHUNK_BYTES)) {
        const groupBytes = group.reduce((sum, n) => sum + (n.xmlBytes ?? 0), 0);
        const only = group.length === 1 ? group[0] : undefined;
        // A single child that is still too big gets descended into; depth is bounded because
        // the CFR tree is bounded, but the guard makes that independent of the data.
        if (only && groupBytes > TARGET_CHUNK_BYTES && depth < 4) expand(only, depth + 1);
        else groups.push(group);
      }
    };
    expand(part, 0);

    for (const group of groups) {
      const label = rangeLabel(group);
      const route = `${baseRoute}/${slugSegment(label)}`;
      plan.units.push({
        route,
        titleNumber: part.titleNumber,
        partCitation: part.citation,
        citations: group.map((n) => n.citation),
        contentKey: contentKeyFor(route),
        label: `${part.label} — ${label}`,
        estimatedBytes: group.reduce((sum, n) => sum + (n.xmlBytes ?? 0), 0),
        splitOf: part.citation,
      });
    }

    plan.splits.push({
      partCitation: part.citation,
      pieces: groups.length,
      estimatedBytes: bytes,
    });
  }

  return plan;
}

// ─── file budget ─────────────────────────────────────────────────────────────

export interface PageCounts {
  /** Dashboard, methodology, data-quality, shared-jurisdiction, diff, docs, 404… */
  staticPages: number;
  agencies: number;
  titles: number;
  chapters: number;
  /** Render units — parts plus their splits. */
  partPages: number;
}

export class FileBudgetError extends Error {
  // Plain fields, not constructor parameter properties: Node's strip-only mode rejects those
  // and the pipeline runs from source. Enforced by `erasableSyntaxOnly`.
  readonly total: number;
  readonly counts: PageCounts;

  constructor(total: number, counts: PageCounts) {
    const n = (value: number): string => value.toLocaleString('en-US');
    super(
      `render would emit ${n(total)} files, above the CI limit of ` +
        `${n(FILE_BUDGET_LIMIT)} (Workers free plan refuses above 20,000). ` +
        `Breakdown: ${n(counts.staticPages)} static, ${n(counts.agencies)} agencies, ` +
        `${n(counts.titles)} titles, ${n(counts.chapters)} chapters, ` +
        `${n(counts.partPages)} part pages.`,
    );
    this.name = 'FileBudgetError';
    this.total = total;
    this.counts = counts;
  }
}

export function totalFiles(counts: PageCounts): number {
  return counts.staticPages + counts.agencies + counts.titles + counts.chapters + counts.partPages;
}

/** Throws above the CI limit. Returns the total, and whether it is in the warning band. */
export function assertFileBudget(counts: PageCounts): { total: number; warn: boolean } {
  const total = totalFiles(counts);
  if (total > FILE_BUDGET_LIMIT) throw new FileBudgetError(total, counts);
  return { total, warn: total > FILE_BUDGET_WARN };
}

// ─── manifest ────────────────────────────────────────────────────────────────

/**
 * What the Astro build reads.
 *
 * The web build must not query D1 or reach eCFR to know what pages exist — rule 4 forbids the
 * second and the first would make the build depend on a database that may be mid-sync. The
 * manifest is the whole interface between this pipeline and `apps/web`.
 */
export interface RenderManifest {
  runId: number;
  sourceDate: string | null;
  generatedAt: string;
  units: RenderUnit[];
  counts: PageCounts;
  totalFiles: number;
  budget: { limit: number; warnAt: number; platformCap: number };
  splits: RenderPlan['splits'];
  oversized: RenderPlan['oversized'];
}

export function buildManifest(
  runId: number,
  sourceDate: string | null,
  plan: RenderPlan,
  counts: PageCounts,
): RenderManifest {
  const { total } = assertFileBudget(counts);
  return {
    runId,
    sourceDate,
    generatedAt: new Date().toISOString(),
    units: plan.units,
    counts,
    totalFiles: total,
    budget: { limit: FILE_BUDGET_LIMIT, warnAt: FILE_BUDGET_WARN, platformCap: 20_000 },
    splits: plan.splits,
    oversized: plan.oversized,
  };
}

export async function writeManifest(path: string, manifest: RenderManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

// ─── page wrapper ────────────────────────────────────────────────────────────

/**
 * Wrap rendered body HTML in the fragment Astro embeds.
 *
 * Deliberately a fragment, not a document: the layout, navigation and styling live in
 * `apps/web`. What this pipeline owns is the regulation text and the attribution, and the
 * attribution is mandatory on every page — the source link is the reader's route back to the
 * authoritative text, and rule 4 means the site itself will never fetch it for them.
 */
export function wrapFragment(options: {
  citation: string;
  displayCitation: string;
  sourceUrl: string;
  sourceDate: string | null;
  bodyHtml: string;
}): string {
  const asOf = options.sourceDate
    ? `<p class="as-of">Text as published by eCFR on <time datetime="${escapeHtml(options.sourceDate)}">${escapeHtml(options.sourceDate)}</time>.</p>`
    : '';
  return [
    `<article class="cfr" data-citation="${escapeHtml(options.citation)}">`,
    `<header class="cfr-head"><h1>${escapeHtml(options.displayCitation)}</h1>${asOf}</header>`,
    options.bodyHtml,
    `<footer class="cfr-source"><p>Source: <a href="${escapeHtml(options.sourceUrl)}" rel="external nofollow">${escapeHtml(options.sourceUrl)}</a> (eCFR, official).</p></footer>`,
    `</article>`,
  ].join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
