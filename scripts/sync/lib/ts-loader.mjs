/**
 * ESM resolve hook for the sync pipeline. Two jobs, both forced by the same constraint: the
 * entry points are fixed by the root package.json as `node scripts/sync/{backfill,delta}.mjs`
 * — no flags, no build step, no `tsx`.
 *
 * JOB 1: `./x.js` -> `./x.ts` when the `.js` does not exist.
 *
 *   Node 22.18+ strips types from `.ts` natively, so the pipeline runs from source. What Node
 *   does NOT do is rewrite a `.js` specifier to the `.ts` that will eventually produce it.
 *   `@ecfr-atlas/core` exports `./src/index.ts`, which does `export * from './measurement.js'`
 *   — correct for tsc and every bundler, unloadable by bare Node. Forking the contract is
 *   forbidden and duplicating its types is worse, so resolution is patched instead.
 *
 * JOB 2: resolve `@ecfr-atlas/*` against the workspace.
 *
 *   `scripts/` is not a pnpm workspace package (pnpm-workspace.yaml globs `packages/*` and
 *   `apps/*`), so nothing links the workspace packages into the root node_modules and a bare
 *   `@ecfr-atlas/core` has nowhere to resolve from. Rather than litter the pipeline with
 *   `../../../packages/core/src/index.js`, the hook reads each workspace package's own
 *   `exports` map and resolves against it — the same subpaths, resolved the same way, just
 *   without the symlink pnpm would have made if scripts/ were a member.
 *
 * Verified on Node v22.23.0. Both jobs are fallbacks: anything Node can already resolve is
 * left entirely alone, so if `scripts/` later becomes a workspace member this hook quietly
 * stops doing anything.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCOPE = '@ecfr-atlas/';

function findRepoRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(resolvePath(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** name -> { dir, exports } for every @ecfr-atlas package under packages/. */
function readWorkspacePackages() {
  const root = findRepoRoot();
  const map = new Map();
  if (!root) return map;

  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) return map;

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.name === 'string' && manifest.name.startsWith(SCOPE)) {
        map.set(manifest.name, { dir, exports: manifest.exports, main: manifest.main });
      }
    } catch {
      // A malformed package.json is not this hook's problem to report.
    }
  }
  return map;
}

const workspacePackages = readWorkspacePackages();

/**
 * Minimal `exports` resolution: string targets and the `import`/`default` conditions, which
 * is all these packages use. Anything more exotic is left to fail loudly rather than be
 * half-supported.
 */
function resolveExportTarget(target) {
  if (typeof target === 'string') return target;
  if (target && typeof target === 'object') {
    for (const condition of ['import', 'module', 'default']) {
      if (condition in target) {
        const resolved = resolveExportTarget(target[condition]);
        if (resolved) return resolved;
      }
    }
  }
  return null;
}

function resolveWorkspace(specifier) {
  const slash = specifier.indexOf('/', SCOPE.length);
  const name = slash === -1 ? specifier : specifier.slice(0, slash);
  const subpath = slash === -1 ? '.' : `.${specifier.slice(slash)}`;

  const pkg = workspacePackages.get(name);
  if (!pkg) return null;

  let relative = null;
  if (pkg.exports && typeof pkg.exports === 'object') {
    relative = resolveExportTarget(pkg.exports[subpath]);
  } else if (typeof pkg.exports === 'string' && subpath === '.') {
    relative = pkg.exports;
  }
  if (!relative && subpath === '.' && pkg.main) relative = pkg.main;
  if (!relative) return null;

  const candidates = [join(pkg.dir, relative)];
  // The package may point at build output that does not exist yet; fall back to the source.
  if (relative.endsWith('.js')) candidates.push(join(pkg.dir, `${relative.slice(0, -3)}.ts`));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    const notFound = code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_UNSUPPORTED_DIR_IMPORT';
    if (!notFound) throw error;

    const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
    const isAbsolute = specifier.startsWith('/') || specifier.startsWith('file://');

    if (specifier.endsWith('.js') && (isRelative || isAbsolute)) {
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }

    if (specifier.startsWith(SCOPE)) {
      const url = resolveWorkspace(specifier);
      if (url)
        return {
          url,
          shortCircuit: true,
          format: url.endsWith('.ts') ? 'module-typescript' : undefined,
        };
    }

    throw error;
  }
}
