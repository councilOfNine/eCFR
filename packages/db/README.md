# `@ecfr-atlas/db` — the schema package

This package is the **D1 schema and nothing else**: the migrations in `migrations/`, and the
tests in `test/` that prove the schema's CHECK constraints actually reject a fabricated number.

There is no `src/`. It does not export a query layer, row types, or any TypeScript at all. The
package name appears in `package.json` and in this file; no code imports it.

## Why there is no shared query layer

There was one — `src/queries.ts`, `src/writes.ts`, `src/helpers.ts`, ~2,200 lines — and it was
deleted, because nothing imported it. Its own header claimed "one implementation, two consumers,
so the site and the public API cannot drift into reporting different numbers." That claim was
false the moment it was written: both consumers had already built their own layer, so the file
was a description of an intention rather than of the system.

Dead code that looks canonical is worse than no code at all. The next contributor edits it,
changes nothing, and loses an afternoon finding out why.

It was not restored, because the two consumers genuinely do not want the same thing:

|                         | `apps/api`                                                   | `apps/web`                                                        |
| ----------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| when                    | per request, in a Worker                                     | once, at build time, in Node                                      |
| how it reaches the data | a bound `D1Database`                                         | `node:sqlite` over a local file, **or** a JSON snapshot directory |
| what it needs back      | rows shaped to the wire schemas in `apps/api/src/schemas.ts` | page view models, including **regulation body text**              |

The last row is the one that settles it. Body text is not in D1 at all —
`structure_node.content_key` is a pointer into R2, because six sections exceed D1's 2,000,000-byte
row cap and 26 CFR Part 1 is 69,598,633 bytes. A production site build therefore reads a snapshot
directory and never opens a database, so a D1 query layer could not have served it even in
principle. The `node:sqlite` path exists only as a contributor convenience and says so on every
page it renders.

Forcing one abstraction over "a Worker answering a request from D1" and "a Node build reading
JSON off disk" would have produced an interface that fits neither.

The thing that must not drift between them is the _meaning_ of a measurement, and that is held by
`@ecfr-atlas/core` — `Measurement`, `fromRow`, `toRow` — which both consumers do import, and by
the constraints below, which both are stored behind.

## Migrations

| file                      | what it does                                                       |
| ------------------------- | ------------------------------------------------------------------ |
| `0001_init.sql`           | The whole corpus schema. Every table, index, and CHECK constraint. |
| `0002_api_usage_anon.sql` | Anonymous per-day usage counters for the API's quota accounting.   |

They are applied by:

- `pnpm db:migrate:local` / `pnpm db:migrate:remote` — `wrangler d1 migrations apply`, pointed
  here by `migrations_dir` in `apps/api/wrangler.jsonc`;
- `pnpm db:reset` (`scripts/db-reset.mjs`) for a clean local database;
- every Worker-side test, via `readD1Migrations()` in the root `vitest.config.ts` and
  `test/setup/apply-migrations.ts`. Tests apply these files **verbatim** rather than a
  hand-maintained copy of the schema, so a migration and the tests cannot disagree.

`.prettierignore` excludes `migrations/*.sql`: they are hand-formatted, and column alignment in a
DDL diff is worth more than uniformity with the rest of the repo.

Migrations are append-only. D1 records applied filenames in `d1_migrations`; editing a file that
has been applied anywhere means production and a fresh database silently have different schemas.
Add `0003_*.sql` instead.

## What the constraints are for

This project exists because its predecessor published invented word counts. The defence against
that is layered, and every layer above this one is a convention a contributor can route around:
the `Measurement` union in `@ecfr-atlas/core` can be cast away, `toRow` can be bypassed, a raw
`INSERT` can be hand-written in a one-off script.

The CHECK constraints cannot. They are what makes "we measured 104,642" and "we do not know"
distinguishable _at rest_:

- a word count with an unknown status is rejected;
- a known status with a `NULL` count is rejected;
- an unknown status with no stated reason is rejected.

All three were verified by hand in real SQLite before the schema was committed, and
`test/schema-constraints.test.ts` runs them in workerd — the same SQLite that enforces them in
production — so the verification is something CI does rather than something somebody once did.

Run them with `pnpm test`.
