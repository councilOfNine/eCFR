/**
 * `AtlasData` over the JSON snapshot emitted by scripts/sync. The deploy path.
 *
 * This is the only source that can supply regulation body text. D1 holds a pointer into R2, not
 * the text itself — six sections individually exceed D1's 2,000,000-byte row cap, the largest
 * being 50 CFR 17.95 at 5,010,215 B — so the sync, which has R2 credentials, writes the
 * rendered bodies into the snapshot alongside the JSON.
 *
 * Reads are lazy and per-file. Small collection files are memoised because `getStaticPaths`
 * asks for them once per route module; per-part files are not, because there are 9,664 of them
 * and each is needed exactly once.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  AgencyPage,
  AgencyRow,
  AmendmentSeries,
  type AtlasData,
  ChapterPage,
  DataQuality,
  PartPage,
  type PartView,
  RouteIndex,
  SharedScope,
  SnapshotManifest,
  TitlePage,
  TitleRow,
} from '../contract.js';
import { parseChecked } from '../schema.js';

const seg = (value: string | number): string => encodeURIComponent(String(value));

/**
 * A missing file means the route does not exist in this dataset, which is a legitimate answer
 * (`getAgency('nope')` → null). Any other error is a broken snapshot and must not be swallowed:
 * an unreadable file silently becoming a 404 is how a deploy ships with a third of its pages
 * missing and nobody notices.
 */
async function readJsonOrNull(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function readJson(path: string): Promise<unknown> {
  const value = await readJsonOrNull(path);
  if (value === null) {
    throw new Error(`snapshot: required file is missing: ${path}`);
  }
  return value;
}

/** Single-flight memo. Concurrent getStaticPaths calls must not each parse the same 2 MB file. */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => (pending ??= fn());
}

export async function loadSnapshotSource(dir: string): Promise<AtlasData> {
  const manifest = parseChecked(
    SnapshotManifest,
    await readJson(join(dir, 'manifest.json')),
    `${dir}/manifest.json`,
  );

  if (manifest.snapshot_version !== 1) {
    throw new Error(
      `snapshot: version ${String(manifest.snapshot_version)} is not understood by this build. ` +
        'Regenerate the snapshot or check out a matching commit of apps/web.',
    );
  }

  const collection = <T extends z.ZodTypeAny>(file: string, schema: T) =>
    once(async () => parseChecked(schema, await readJson(join(dir, file)), `${dir}/${file}`));

  const routes = collection('routes.json', RouteIndex);
  const agencies = collection('agencies.json', z.array(AgencyRow));
  const titles = collection('titles.json', z.array(TitleRow));
  const shared = collection('shared-jurisdiction.json', z.array(SharedScope));
  const dataQuality = collection('data-quality.json', DataQuality);
  const amendments = collection('amendments.json', AmendmentSeries);

  /**
   * Bodies are stored beside the JSON rather than inside it so a page that needs no text never
   * pays for it, and so a 69 MB part cannot be pulled into the build's heap by a route that
   * only wanted its section list.
   */
  async function readContent(key: string): Promise<string> {
    const path = join(dir, 'content', `${key}.html`);
    try {
      const html = await readFile(path, 'utf8');
      // The renderer opens every part's body with its own `<h1>N CFR Part N</h1>`. The page
      // template already supplies the canonical h1 (part number, heading, context), and the
      // accessibility commitment check-html enforces is exactly one h1 per built page.
      // Demoted rather than stripped: in a very large part the heading is still a useful
      // landmark in the document outline.
      return html.replace(/<h1(\s|>)/g, '<h2$1').replace(/<\/h1>/g, '</h2>');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `snapshot: ${path} is referenced by a part page but does not exist. The exporter must ` +
            'write the content file before the JSON that points at it.',
        );
      }
      throw err;
    }
  }

  return {
    manifest,
    routes,
    listAgencies: agencies,
    listTitles: titles,
    listSharedScopes: shared,
    getDataQuality: dataQuality,
    getAmendmentActivity: amendments,

    async getAgency(slug) {
      const file = join(dir, 'agency', `${seg(slug)}.json`);
      const raw = await readJsonOrNull(file);
      return raw === null ? null : parseChecked(AgencyPage, raw, file);
    },

    async getTitle(titleNumber) {
      const file = join(dir, 'title', `${seg(titleNumber)}.json`);
      const raw = await readJsonOrNull(file);
      return raw === null ? null : parseChecked(TitlePage, raw, file);
    },

    async getChapter(titleNumber, chapterId) {
      const file = join(dir, 'title', seg(titleNumber), 'chapter', `${seg(chapterId)}.json`);
      const raw = await readJsonOrNull(file);
      return raw === null ? null : parseChecked(ChapterPage, raw, file);
    },

    async getPart(titleNumber, partId, subpart) {
      const base = join(dir, 'title', seg(titleNumber), 'part');
      const file =
        subpart === null
          ? join(base, `${seg(partId)}.json`)
          : join(base, seg(partId), `${seg(subpart)}.json`);

      const raw = await readJsonOrNull(file);
      if (raw === null) return null;

      const page = parseChecked(PartPage, raw, file);
      const view: PartView = {
        ...page,
        content_html: page.content_key === null ? null : await readContent(page.content_key),
      };
      return view;
    },
  };
}
