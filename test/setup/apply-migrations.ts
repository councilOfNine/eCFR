/**
 * Give every Worker-side test a real, fully migrated, empty D1.
 *
 * The point of running these tests in workerd at all is that the CHECK constraints in
 * 0001_init.sql are enforced by the same SQLite that enforces them in production. Applying the
 * migration files verbatim — not a hand-maintained copy of the schema — is what makes that
 * true. If a migration and the tests ever disagree, the tests are wrong by construction.
 *
 * The pool does not roll storage back between tests in this version, so truncation is
 * explicit, and it is derived from `sqlite_master` rather than a hardcoded list: a table added
 * by a future migration is cleaned automatically and the teardown cannot drift out of sync
 * with the schema. A leftover row from a previous test is exactly the sort of thing that makes
 * a constraint test pass for the wrong reason.
 */

import { applyD1Migrations, type D1Migration, env } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';

interface TestEnv {
  DB: D1Database;
  /** Injected by vitest.config.ts; workerd cannot read the migrations directory itself. */
  __MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestEnv;

/** Bookkeeping for `applyD1Migrations`. Clearing it would re-run every migration. */
const MIGRATIONS_TABLE = 'd1_migrations';

let tableNames: string[] = [];

/**
 * Delete every row, children before parents.
 *
 * The order is discovered by attempting and retrying rather than read from the foreign-key
 * graph, because D1 denies `PRAGMA foreign_key_list`, `PRAGMA foreign_keys` and
 * `PRAGMA defer_foreign_keys` alike (SQLITE_AUTH) — the constraints can be neither inspected
 * nor suspended. Parsing the DDL text out of `sqlite_master` would work and is worse: it is a
 * regex over SQL that breaks the first time a column is named `references`.
 *
 * Deliberately NOT cached across tests. The order that "works" is a function of which tables
 * currently hold rows: learned once against an empty database it is meaningless, because every
 * delete succeeds in any order. Re-deriving it costs around fifteen statements per test, which
 * is nothing next to being wrong in a way that only shows up as a foreign-key error three
 * tests later.
 */
async function truncate(db: D1Database): Promise<void> {
  let pending = [...tableNames];
  // Each pass must clear at least one table or the loop is not making progress; bounding by
  // the table count means a genuine cycle surfaces as a thrown constraint error rather than a
  // hang.
  for (let pass = 0; pass < tableNames.length && pending.length > 0; pass++) {
    const blocked: string[] = [];
    for (const name of pending) {
      try {
        await db.prepare(`DELETE FROM "${name}"`).run();
      } catch {
        // Still has children pointing at it. Try again next pass.
        blocked.push(name);
      }
    }
    if (blocked.length === pending.length) break;
    pending = blocked;
  }

  if (pending.length > 0) {
    // Let the real error out rather than swallowing it, so a future circular foreign key is
    // diagnosable instead of showing up as mystery leftover rows.
    await db.batch(pending.map((name) => db.prepare(`DELETE FROM "${name}"`)));
  }
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.__MIGRATIONS, MIGRATIONS_TABLE);
  const { results } = await testEnv.DB.prepare(
    // `_cf_METADATA` is D1's own bookkeeping table. It is visible in sqlite_master but writes
    // to it are SQLITE_AUTH-denied, so including it turns every truncation into a failure.
    `SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
       AND name != ?`,
  )
    .bind(MIGRATIONS_TABLE)
    .all<{ name: string }>();
  tableNames = results.map((row) => row.name);
});

beforeEach(async () => {
  await truncate(testEnv.DB);
  // 0001_init.sql seeds the app_meta singleton and the truncation removes it; every read path
  // assumes the row exists.
  await testEnv.DB.prepare(
    `INSERT OR IGNORE INTO app_meta (id, schema_version) VALUES (1, 1)`,
  ).run();
});
