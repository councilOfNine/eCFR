# Contributing to ecfr-atlas

Thanks for looking. This project publishes measurements about federal regulation, and its whole
value rests on those measurements being trustworthy — so most of what follows is about that.

## Getting set up

```bash
pnpm install
pnpm db:reset     # loads fixtures/seed.sql into a local D1 — no network needed
pnpm dev:web      # http://localhost:4321
```

You need **Node 22+** (`.nvmrc`) and **pnpm 10.10.0**. `corepack enable` reads the version out of
`packageManager` so you do not have to think about it.

The fixtures are committed deliberately. You should be able to clone, install and see a working
site in under thirty seconds without touching the eCFR API, without a Cloudflare account, and
without any credentials. If that is not true for you, that is a bug worth filing.

Before pushing:

```bash
pnpm typecheck && pnpm --filter @ecfr-atlas/web typecheck && pnpm lint && pnpm test && pnpm format
```

Both typecheck commands are needed. `pnpm typecheck` is `tsc --build` over the root solution
config, which deliberately excludes `apps/web` — it extends `astro/tsconfigs/strict` and half its
types do not exist until `astro sync` has run. `astro check` is the site's half, and CI runs it as
its own step.

## The rules

These are not style preferences. Each one is a bug that already happened.

**1. Never write a number that was not measured.**
Use the [`Measurement`](packages/core/src/measurement.ts) API. There is no `estimate()`
constructor and there will not be one. If you cannot measure something, call
`unavailable(status, reason)` and let it propagate. Do not substitute a plausible value, do not
default to zero, and do not sum a partial set of children into a parent — `rollUp()` already
refuses to do that and it refuses on purpose.

When its extraction failed, the predecessor fell back to this:

```js
const chapterText = fullText.substring(0, estimatedWords * 6);
```

and then stored the resulting count in the same column as a real one. One agency was
over-credited by 12.7×. Everything in the schema and the core types exists to make that
unrepresentable.

**2. Never use a regex to extract structure from XML.**
Use `fast-xml-parser`. DIV levels in eCFR XML are not sequential — title 7 goes DIV2→DIV5
thirty-five times — and title 40 contains 19,134 untyped `<DIV>` elements inside sections. A
regex that works on the title you tested will fail on another one, and the interesting question
is whether it fails loudly or quietly.

**3. Never interpolate anything into `new RegExp`.**
The old `/diff` route did, and it was a ReDoS. ESLint blocks it; if you genuinely need a dynamic
pattern, escape the input and justify it in a disable comment so it shows up in review.

**4. No user-facing route may call ecfr.gov.**
Cite it, link it, never fetch it on the read path. `/diff` is the one exception and it must
memoise to R2 permanently. A page that depends on a third party's uptime and rate limiter is a
page that is down when that third party is.

**5. Insert-then-prune, always.**
Upsert with `last_seen_run_id = :run`, then `DELETE WHERE last_seen_run_id < :run` — and only
after the unit succeeded. A crashed run must leave a superset of the truth, never a hole.

**6. Real TypeScript.**
No `any` without a comment justifying it (an `eslint-disable-next-line` with a reason counts —
that is the point). No `@ts-ignore`; use `@ts-expect-error` with a description, so it fails once
the underlying problem is fixed.

**7. Comment density matching `packages/core`.**
Explain _why_, especially where a measured fact or an upstream quirk drove the choice. Do not
narrate what the code does — the code already does that. `// eCFR's ?chapter= validates but does
not slice, so this has to fan out to parts` is worth more than twenty lines of paraphrase.

## Things that are already known and measured

Do not re-measure these, and do not write code that contradicts them:

- 49 non-reserved titles. Title 35 is reserved and all three of its date fields are null.
- 316 agencies, 487 CFR references, 275,271 structure nodes, 227,558 sections, 9,664 parts.
- Six sections exceed D1's 2,000,000-byte row cap (largest: 50 CFR 17.95 at 5,010,215 B). Text
  lives in R2; D1 holds the pointer.
- 36 parts exceed 2 MB; 26 CFR Part 1 is 69,598,633 B and also blows the 25 MiB static-asset
  per-file cap, so it must be split by subpart.
- eCFR's `?chapter=` and `?subtitle=` validate but do **not** slice — they return the entire
  title. Only `?part=` and `?section=` slice.
- eCFR rate limiting is a token bucket, not a concurrency gate. Serial does not avoid it.
  Sustained ≤ 8 req/s is clean at any parallelism; ~10 req/s is the onset.
- `amendment_date` differs from `issue_date` in 49.7% of rows, and 40.4% of amendment dates
  predate eCFR's 2017-01-01 full-text horizon. Key content fetches on `issue_date`.
- Never scrape ecfr.gov HTML. Automated clients get redirected to a CAPTCHA. Use the JSON/XML
  API, always with gzip and a descriptive User-Agent carrying a contact URL. Set
  `ECFR_CONTACT_URL` to something that reaches **you** if you run the pipeline from a fork; it
  defaults to this repository, which is honest but points at the wrong people.

If you believe one of these is wrong, that is a great issue to open — bring the measurement.

## Frozen files

`packages/core/src/measurement.ts`, `citation.ts`, `ecfr-schemas.ts` and
`packages/db/migrations/0001_init.sql` are the project's contract. They are written, tested, and
depended on by every other module.

Changing them is allowed, but it is a deliberate act, not a drive-by: open an issue first, and
expect the PR to touch every consumer in the same change. Adding a `word_count_status` variant
means writing a migration, because the CHECK constraint enumerates them.

## Pull requests

- Branch from `master`. Small and focused beats comprehensive.
- CI runs format, typecheck (both halves — `tsc --build` and `astro check`), lint, test, the full
  Astro build, and a static-asset budget assertion. All of it has to pass.
- **Fork PRs do not get a preview deployment.** They run with a read-only token and no repository
  secrets, which is correct and intentional — the alternative (`pull_request_target`) would hand
  this project's Cloudflare credentials to code from the fork. The `verify` job still builds the
  site in full, so a broken build still fails your PR; you just do not get a preview URL. A
  maintainer can produce one by pushing your branch to this repository.
- The eCFR contract test runs on a schedule, never on PRs. It hits a live third-party API and
  would flake on someone else's rate limit, and an external service's availability is not a
  property of your diff.

## The asset-count ceiling

The site prerenders roughly 11,100 pages. Cloudflare's free plan caps a Workers Static Assets
deployment at 20,000 files; CI fails at 18,000.

This is closer than it sounds. Title 40 alone has 24,614 sections, so any change that starts
emitting a page per section instead of per part takes the build past 200,000 files in one commit.
If you need finer-grained pages, the answer is on-demand rendering for the long tail, not a
bigger static build.

## Reporting a wrong number

Use the **"Data looks wrong"** issue template. Include the URL, what we show, what you believe is
correct, and how you arrived at it. Every nightly export is on public R2 with a manifest of row
counts and a sha256, so you can check our arithmetic against the same bytes we used.

Being contradicted with evidence is the intended use of this project.
