/**
 * Copy the Scalar API-reference bundle out of node_modules and into the Worker's static
 * assets, so /docs loads it from this origin instead of from a CDN.
 *
 * WHY THIS EXISTS
 *
 * /docs used to load `https://cdn.jsdelivr.net/npm/@scalar/api-reference` — no version, no
 * integrity hash — and `docsCsp()` allowlisted that host in `script-src`. That is arbitrary
 * third-party JavaScript, chosen at request time by whatever the CDN decided `@scalar/
 * api-reference` meant that day, executing on a public endpoint of an API that mints
 * credentials. A compromised or merely mistaken publish would have run in every reader's
 * browser, and there was nothing in the page that could have noticed.
 *
 * Serving it ourselves removes the CDN from `script-src` entirely, which is strictly stronger
 * than pinning plus SRI: there is no third-party host left to trust for availability either.
 * Workers Static Assets cost nothing and do not count against the Worker's script size.
 *
 * WHY THE FILE IS NOT COMMITTED
 *
 * It is 3.7 MB of minified code that nobody will ever read in a diff, and committing it would
 * mean the artifact in the repository and the artifact in the lockfile could disagree. Built
 * from node_modules instead, the bundle is exactly the one pnpm installed, whose tarball hash
 * is pinned in pnpm-lock.yaml and verified on every install. `public/dist/` is git-ignored
 * and this script runs from the `dev` and `deploy` scripts, so the two cannot drift.
 *
 * WHY standalone.js AND NOT standalone.esm.js
 *
 * The ESM build is smaller (701 KB) but splits into 93 chunks resolved relative to the script
 * URL. One self-contained IIFE is one file, one script tag, and no resolution to get wrong;
 * over the wire it compresses to roughly a quarter of its size and is cached immutably.
 *
 * Runs as TypeScript directly under Node's type stripping (default since 22.18), so nothing
 * here may use non-erasable syntax — no `enum`, no parameter properties.
 */

import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(here, '..');

const require = createRequire(import.meta.url);

/**
 * The two manifest fields this script consumes. Validated rather than asserted, because the
 * input is a file on disk: a corrupt or half-written package.json should fail with a message
 * that names the problem, not a TypeError three lines later.
 */
interface ScalarManifest {
  name: string;
  version: string;
}

function isScalarManifest(value: unknown): value is ScalarManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; version?: unknown };
  return typeof candidate.name === 'string' && typeof candidate.version === 'string';
}

/**
 * Locate the installed package through node's own resolution rather than a hardcoded path, so
 * the pnpm store's hashed directory name is never spelled out here.
 *
 * The `exports` map exposes neither `./package.json` nor `./dist/browser/`, so resolution goes
 * via the `.` entry point and then walks up to the directory that owns it. That is the only
 * way to reach a file a package chose not to export, and vendoring is exactly the case where
 * that is legitimate.
 */
const packageName = '@scalar/api-reference';
const entryPoint = require.resolve(packageName);

let packageRoot = path.dirname(entryPoint);
let manifest: ScalarManifest | null = null;
for (;;) {
  const candidate = path.join(packageRoot, 'package.json');
  const text = await readFile(candidate, 'utf8').catch(() => null);
  const parsed: unknown = text === null ? null : JSON.parse(text);
  if (isScalarManifest(parsed) && parsed.name === packageName) {
    manifest = parsed;
    break;
  }
  const parent = path.dirname(packageRoot);
  if (parent === packageRoot) {
    throw new Error(`could not find the package root for ${packageName} above ${entryPoint}`);
  }
  packageRoot = parent;
}

const { version } = manifest;
const source = path.join(packageRoot, 'dist', 'browser', 'standalone.js');

/**
 * `public/dist/`, and the directory name is load-bearing.
 *
 * It is genuinely build output — copied, never edited — and `dist` is the segment the
 * repository already treats as such everywhere: the root .gitignore ignores `dist/` at any
 * depth and the root lint config ignores `**\/dist\/**`. Naming it anything else would
 * mean 3.7 MB of minified third-party code showing up as ten thousand lint errors and, if
 * anyone forgot the ignore, in a commit. Vendoring therefore needs no change outside this
 * package. `apps/api/.gitignore` states it locally as well, so the reason is discoverable
 * without reading the root config.
 *
 * The filename carries no version. `docs.ts` appends `?v=<SCALAR_VERSION>` for cache busting,
 * and test/docs.test.ts asserts that constant matches the installed dependency and that the
 * filename here matches the one the page requests.
 */
const destinationDir = path.join(apiRoot, 'public', 'dist');
const destination = path.join(destinationDir, 'scalar-api-reference.js');

await stat(source).catch(() => {
  throw new Error(
    `@scalar/api-reference ${version} has no dist/browser/standalone.js at ${source}. ` +
      'The bundle layout changed; update apps/api/scripts/vendor-scalar.ts and the ' +
      'SCALAR_VERSION constant in apps/api/src/docs.ts together.',
  );
});

await mkdir(destinationDir, { recursive: true });
await copyFile(source, destination);

const { size } = await stat(destination);
console.log(
  `vendored @scalar/api-reference ${version} -> ${path.relative(apiRoot, destination)} ` +
    `(${(size / 1_048_576).toFixed(1)} MB)`,
);
