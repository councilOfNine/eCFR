/**
 * Shared reader for the built output, used by scripts/build-headers.ts and
 * scripts/check-headers.ts.
 *
 * Both need the same answer to "what inline scripts does this build actually emit?", and the
 * whole point of deriving the CSP from the output is defeated if the generator and the verifier
 * can disagree about it. So there is one implementation.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIST = fileURLToPath(new URL('../../dist/client/', import.meta.url));
export const HEADERS_FILE = join(DIST, '_headers');

/** One inline script found in the build, identified by the first page that carries it. */
export interface InlineScript {
  /** DIST-relative path of the first page the script was seen on. */
  page: string;
  /** The exact bytes between the tags — what the CSP hash is computed over. */
  body: string;
}

export interface InlineScriptScan {
  /** Sorted CSP hashes, one per distinct script body. */
  hashes: string[];
  byHash: Map<string, InlineScript>;
}

/** Every .html file under dist/client, as absolute paths. */
export async function listHtml(dir: string = DIST): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listHtml(full)));
    else if (entry.name.endsWith('.html')) found.push(full);
  }
  return found;
}

/**
 * `<script>` elements with a body and no `src`.
 *
 * The attribute test is deliberately `src=` rather than a full parse: a script with a `src` has
 * no body to hash, and this app emits no scripts that have both. A `nonce` is impossible on a
 * statically served file, so hashes are the only mechanism available.
 */
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/**
 * CSP hashes the bytes BETWEEN the tags, exactly as they appear — no trimming, no entity
 * decoding, UTF-8. Getting this wrong produces a policy that looks right and blocks everything.
 */
export function cspHash(body: string): string {
  return `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`;
}

/** Collect every distinct inline script across the build. */
export async function collectInlineScripts(): Promise<InlineScriptScan> {
  const byHash = new Map<string, InlineScript>();
  for (const page of await listHtml()) {
    const html = await readFile(page, 'utf8');
    for (const match of html.matchAll(SCRIPT_RE)) {
      const attrs = match[1] ?? '';
      const body = match[2] ?? '';
      if (/\bsrc\s*=/i.test(attrs)) continue;
      if (body.trim() === '') continue;
      const hash = cspHash(body);
      if (!byHash.has(hash)) byHash.set(hash, { page: relative(DIST, page), body });
    }
  }
  // Sorted so the emitted _headers is byte-stable across builds and a diff means a real change.
  return { hashes: [...byHash.keys()].sort(), byHash };
}
