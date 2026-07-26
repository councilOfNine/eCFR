/**
 * Two projects, because this package has two kinds of test and they cannot share a runtime.
 *
 * `node` — the counter rules, the parser, the citation algebra, and the routes driven through
 *   a node:sqlite-backed D1 shim (test/helpers/d1.ts). That shim runs the API's REAL SQL
 *   against the REAL migrations, which is the property that matters, and it does it with no
 *   miniflare download and no network. The two bindings those tests care about — the rate
 *   limiter and R2 — are two methods each and are faked in test/helpers/env.ts.
 *
 * `workers` — everything under test/workers/, which asserts things that are only true of a
 *   real workerd isolate and would be vacuous against a shim:
 *     - the daily quota counter under actual concurrent writers. A read-then-write counter
 *       passes a sequential test perfectly and loses increments the moment two requests
 *       overlap; node:sqlite runs every statement to completion, so it cannot see that.
 *     - "no user-facing route reaches ecfr.gov", asserted against the deployed Worker with
 *       outbound fetch intercepted at the isolate level rather than at a module boundary a
 *       route could route around.
 *     - the /v1/diff memo round-tripping through a REAL R2 binding.
 *
 * The workers project takes its bindings, vars and `main` entrypoint from wrangler.jsonc, so
 * the tests cannot pass against a Worker shaped differently from the one that ships, and it
 * applies packages/db/migrations verbatim — never a hand-maintained copy of the schema, which
 * is what makes the D1 CHECK constraints testable at all.
 *
 * The root vitest.config.ts runs these same suites as part of the whole-repo run. Both configs
 * exist on purpose: `pnpm --filter @ecfr-atlas/api test` has to be green on its own, because
 * that is what someone working on this package actually runs.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.join(here, '..', '..');

/**
 * The real migration files, split into statements by wrangler's own quote- and comment-aware
 * splitter — the same code path `wrangler d1 migrations apply` uses.
 *
 * Read here in Node and handed to the Worker as a binding, because the tests run in workerd
 * and workerd has no filesystem.
 */
const migrations = await readD1Migrations(path.join(repoRoot, 'packages/db/migrations'));

/**
 * The committed fixture, as executable statements, for the Worker tests that need real rows.
 *
 * Splitting on `;\n` is safe for THIS file specifically and would not be in general: every
 * literal in it was emitted by `sqlString()`, which hex-encodes control characters, so no
 * newline can occur inside a quoted string. Comment lines are dropped for the same reason —
 * `--` can only start a comment here, never appear mid-literal.
 */
async function readSeedStatements(): Promise<string[]> {
  const sql = await readFile(path.join(repoRoot, 'fixtures/seed.sql'), 'utf8');
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

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          root: here,
          environment: 'node',
          include: ['test/**/*.test.ts'],
          // Needs a real isolate; see the `workers` project below.
          exclude: ['**/node_modules/**', '**/dist/**', 'test/workers/**'],
          testTimeout: 30_000,
        },
      },

      {
        plugins: [
          cloudflareTest({
            // Bindings, vars and `main` all come from the real deploy config. Duplicating them
            // here would let the tests pass against a Worker shaped differently from the one
            // that ships.
            wrangler: { configPath: path.join(here, 'wrangler.jsonc') },
            miniflare: {
              // NOTE: static assets are deliberately not wired here. `SELF` in this pool is a
              // service binding straight to the user Worker's entrypoint, so it bypasses the
              // asset router that sits in front of the Worker in production — an assertion
              // that /vendor/… is served would fail against a perfectly correct deployment.
              // The asset wiring is checked as configuration instead (test/docs.test.ts) and
              // by `wrangler deploy --dry-run`.
              r2Buckets: ['CONTENT'],
              d1Databases: ['DB'],
              bindings: {
                __MIGRATIONS: migrations,
                __SEED: seed,
                // Not a secret in tests, but present because ANON_SALT is REQUIRED at runtime
                // and its absence is a hard failure — see src/auth/quota.ts.
                ANON_SALT: 'test-salt-not-a-secret-but-long-enough',
                ADMIN_TOKEN: 'test-admin-token',
              },
            },
          }),
        ],
        test: {
          name: 'workers',
          root: here,
          include: ['test/workers/**/*.test.ts'],
          setupFiles: [path.join(here, 'test/setup/apply-migrations.ts')],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
