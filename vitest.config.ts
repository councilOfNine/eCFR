/**
 * One config, three projects.
 *
 * The split is not cosmetic. Two of the four things under test can only be checked in a real
 * workerd isolate:
 *
 *   - the D1 CHECK constraints that make a fabricated word count physically unstorable. A
 *     mocked database would assert that our mock rejects the row, which proves nothing. These
 *     run against the actual migrations applied to a real SQLite-backed D1.
 *   - "no user-facing route reaches ecfr.gov". That claim is about the deployed Worker, so the
 *     test drives the deployed Worker, with outbound network disabled at the runtime level
 *     rather than at a module boundary a route could route around.
 *
 * Everything else — the counter, the parser, the citation algebra, the sync SQL emitter — is
 * pure and runs faster in Node.
 *
 * `packages/ecfr/probe/**` is excluded everywhere on purpose. Those files are the live-network
 * measurement harness whose output produced the numbers in the project brief; they hit
 * ecfr.gov, they are not assertions, and a CI run must never depend on an upstream that
 * rate-limits with a token bucket.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * The real migration files, split into statements by wrangler's own quote- and comment-aware
 * splitter — the same code path `wrangler d1 migrations apply` uses.
 *
 * Read here in Node and handed to the Worker as a binding, because the tests run in workerd
 * and workerd has no filesystem. Tests therefore assert against the schema that actually
 * ships, never a hand-maintained copy of it that can drift.
 */
const migrations = await readD1Migrations(path.join(root, 'packages/db/migrations'));

/**
 * The committed fixture, as executable statements, for the Worker tests that need real rows.
 *
 * Splitting on `;\n` is safe for THIS file specifically and would not be in general: every
 * literal in it was emitted by `sqlString()`, which hex-encodes control characters, so no
 * newline can occur inside a quoted string. Comment lines are dropped for the same reason —
 * `--` can only start a comment here, never appear mid-literal.
 *
 * The tests load the real fixture rather than a bespoke one so that a fixture which fails to
 * render a page fails CI, instead of being discovered by a contributor running `pnpm db:reset`.
 */
async function readSeedStatements(): Promise<string[]> {
  const sql = await readFile(path.join(root, 'fixtures/seed.sql'), 'utf8');
  return sql
    .split(/;\s*\n/)
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

const seed = await readSeedStatements();

/** Shared by both Worker projects so a schema fix lands in one place. */
const workerBindings = {
  // Not a secret in tests, but present so anonQuotaKey does not fall back to its
  // development-only default and quietly test a different code path than production.
  ANON_SALT: 'test-salt-not-a-secret',
  ADMIN_TOKEN: 'test-admin-token',
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          /**
           * `scripts/` and the root `test/` directory are not pnpm workspace members
           * (pnpm-workspace.yaml globs `packages/*` and `apps/*`), so nothing links the
           * workspace packages into a node_modules they can see and a bare
           * `@ecfr-atlas/core` has nowhere to resolve from.
           *
           * The sync pipeline solves this at runtime with an ESM resolve hook
           * (scripts/sync/lib/ts-loader.mjs). Vitest does its own resolution, so it needs the
           * same mapping expressed here. Pointing at `src` rather than `dist` is deliberate:
           * a test must never pass against stale build output.
           */
          alias: {
            '@ecfr-atlas/core/ecfr-schemas': path.join(root, 'packages/core/src/ecfr-schemas.ts'),
            '@ecfr-atlas/core/api-schemas': path.join(root, 'packages/core/src/api-schemas.ts'),
            '@ecfr-atlas/core': path.join(root, 'packages/core/src/index.ts'),
            '@ecfr-atlas/ecfr': path.join(root, 'packages/ecfr/src/index.ts'),
            // No `@ecfr-atlas/db`: that package is migrations and tests only. Its migrations are
            // read from disk by `readD1Migrations` above, not imported.
          },
        },
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'packages/core/test/**/*.test.ts',
            'packages/ecfr/test/**/*.test.ts',
            // apps/api's own suite drives the routes through a node:sqlite-backed D1 shim,
            // which is faster and gives it direct access to the database it seeded. Only the
            // files under test/workers/ need a real isolate; everything else belongs here.
            'apps/api/test/**/*.test.ts',
            'scripts/**/*.test.ts',
            'test/**/*.test.ts',
          ],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            'apps/api/test/workers/**',
            // The live-network measurement harness. It talks to ecfr.gov, it asserts nothing,
            // and CI must never depend on an upstream that rate-limits with a token bucket.
            'packages/ecfr/probe/**',
          ],
          // The source-level guard walks the whole repo looking for the proportional-estimate
          // pattern. On a cold cache that is a few hundred files.
          testTimeout: 30_000,
        },
      },

      {
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityDate: '2026-07-01',
              compatibilityFlags: ['nodejs_compat'],
              d1Databases: ['DB'],
              bindings: { __MIGRATIONS: migrations },
            },
          }),
        ],
        test: {
          name: 'db',
          include: ['packages/db/test/**/*.test.ts'],
          setupFiles: ['./test/setup/apply-migrations.ts'],
        },
      },

      {
        plugins: [
          cloudflareTest({
            // Bindings, vars, and the `main` entrypoint all come from the real deploy config.
            // Duplicating them here would let the tests pass against a Worker shaped
            // differently from the one that ships.
            wrangler: { configPath: './apps/api/wrangler.jsonc' },
            miniflare: {
              r2Buckets: ['CONTENT'],
              d1Databases: ['DB'],
              bindings: { __MIGRATIONS: migrations, __SEED: seed, ...workerBindings },
            },
          }),
        ],
        test: {
          name: 'api',
          include: ['apps/api/test/workers/**/*.test.ts'],
          setupFiles: ['./test/setup/apply-migrations.ts'],
        },
      },
    ],
  },
});
