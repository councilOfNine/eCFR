# Deployment

Target: **https://ecfr.fixit.works** (Cloudflare, zone `fixit.works`).

Work through the phases in order. Phase 1 must complete before Phase 2, because deploying the
site without data would publish the committed *fixture* — invented sample numbers — under a real
domain. Both `sync.yml` and `deploy.yml` refuse to do that, so a mistake here fails loudly
rather than quietly shipping fabricated figures. That refusal is the point.

---

## Hostname layout

One hostname, split by path. Keeping the API on the same origin avoids CORS on the docs page and
gives API consumers a URL they can guess.

| Path | Worker | Notes |
| --- | --- | --- |
| `ecfr.fixit.works/*` | `ecfr-atlas-web` | Static assets. Free, unmetered, no Worker invocation. |
| `ecfr.fixit.works/v1/*` | `ecfr-atlas-api` | The public API. |
| `ecfr.fixit.works/docs` | `ecfr-atlas-api` | Self-hosted Scalar reference. |
| `ecfr.fixit.works/openapi.json` | `ecfr-atlas-api` | The spec. |

Routes are matched most-specific-first, so the three API routes win over the site's catch-all.

---

## Phase 0 — Provision

Everything here is one-time. Run from the repo root with `wrangler` authenticated
(`pnpm exec wrangler login`).

### 0.1 D1

```bash
pnpm exec wrangler d1 create ecfr-atlas
```

Copy the returned `database_id` into `apps/api/wrangler.jsonc`, replacing the
`00000000-0000-0000-0000-000000000000` placeholder. **This is a required edit** — the placeholder
is deliberately invalid so a deploy against an unprovisioned account fails immediately instead of
writing somewhere unexpected.

```bash
pnpm exec wrangler d1 migrations apply ecfr-atlas --remote --config apps/api/wrangler.jsonc
```

### 0.2 R2

```bash
pnpm exec wrangler r2 bucket create ecfr-atlas-content
pnpm exec wrangler r2 bucket create ecfr-atlas-content-preview
pnpm exec wrangler r2 bucket create ecfr-atlas-exports      # Phase 5, public
```

`ecfr-atlas-content` holds rendered part HTML, memoised diffs, and the published snapshot.
`ecfr-atlas-exports` is the public nightly SQL dump and is the only bucket with public access.

The sync pipeline signs its own SigV4 PUTs rather than going through wrangler, so it needs an
**R2 API token** — S3-style credentials, a *different* thing from the Workers deploy token in 0.3
and not interchangeable with it.

Dashboard → **R2 Object Storage** → **API** (top right) → **Manage API tokens** → *Create API
token* → permission **Object Read & Write**, scoped to `ecfr-atlas-content`. The result is an
**Access Key ID** and a **Secret Access Key**; the secret is shown exactly once.

Four variables are needed together, and the pipeline treats them as all-or-nothing:

```bash
export R2_ACCOUNT_ID=<your Cloudflare account id>   # same value as CLOUDFLARE_ACCOUNT_ID
export R2_BUCKET=ecfr-atlas-content
export R2_ACCESS_KEY_ID=<access key id>
export R2_SECRET_ACCESS_KEY=<secret access key>
```

**R2 is optional for a first backfill.** If any of the four is missing, `readR2Config()` returns
null and the pipeline uses a `NullObjectSink`: it renders and measures the body text, counts the
bytes, and uploads nothing. Structure, word counts, rollups and amendments all still land in D1.

Be aware of the cost of deferring it, though. The checkpoint in `.sync-cache/` stores node
metadata, **not the fetched XML**, so it makes a *crashed* run resumable but does not make a
*second* run cheap — adding R2 later means another full ~810 MB pull at ≤8 req/s. Getting the
token first is a few minutes; re-running the backfill is closer to an hour. Do it first unless you
are deliberately smoke-testing the pipeline.

### 0.3 Cloudflare API token

Dashboard → My Profile → API Tokens → Create Token → Custom. Scope it to exactly:

- Account · Workers Scripts · **Edit**
- Account · Workers R2 Storage · **Edit**
- Account · D1 · **Edit**
- Account · Account Settings · **Read**
- Zone · Workers Routes · **Edit** (zone `fixit.works`)

Never use a Global API Key. It is account-wide and cannot be scoped or rotated independently.

### 0.4 Secrets on the API Worker

```bash
openssl rand -base64 32 | pnpm exec wrangler secret put ANON_SALT --config apps/api/wrangler.jsonc
```

`ANON_SALT` is **required**. Anonymous quota keys are `sha256(salt + client IP + UTC day)`; IPv4
is a 32-bit space, so an unsalted hash of an address is not a pseudonym, it is an address. Without
the secret the API answers 500 on anonymous requests and logs `anon_salt_misconfigured` rather
than metering dishonestly. `ADMIN_TOKEN` is optional — while unset, the operator-only tier-grant
route returns 404 and the deployment has no privileged surface at all.

### 0.5 GitHub repository secrets and variables

Settings → Secrets and variables → Actions.

| Name | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | From 0.3 |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Dashboard sidebar |
| `R2_ACCESS_KEY_ID` | secret | From the R2 API token in 0.2 |
| `R2_SECRET_ACCESS_KEY` | secret | From the R2 API token in 0.2 |
| `HEALTHCHECK_SYNC_URL` | secret | Optional. Without it the nightly runs unmonitored and says so in the run summary. |
| `HEALTHCHECK_EXPORT_URL` | secret | Optional, Phase 5. |
| `API_ORIGIN` | variable | `https://ecfr.fixit.works` — enables deploy.yml's post-deploy smoke test |
| `R2_CONTENT_BUCKET` | variable | Optional; defaults to `ecfr-atlas-content` in the workflows |

No `R2_ACCOUNT_ID` secret: the workflows derive it from `CLOUDFLARE_ACCOUNT_ID`
(sync.yml maps one onto the other). It is only a distinct name in a LOCAL shell, where the
pipeline reads the four `R2_*` variables directly.

---

## Phase 1 — First data load

The backfill pulls all 49 non-reserved titles: **810,419,929 B** of XML (163 MB gzipped on the
wire, ~331 s of transfer) and parses them into ~275,271 structure nodes. It needs roughly 8 GB of
heap, which is why `sync:backfill` sets `--max-old-space-size=8192`.

Run it **locally or on the homelab**, not in CI. A GitHub runner would work, but a local run keeps
`.sync-cache/` so a failure resumes per-title instead of re-downloading 810 MB and re-hammering
eCFR's rate limiter.

```bash
# D1 writes go through `wrangler d1 execute`, so an interactive `wrangler login` is enough
# locally and these two are only needed for a non-interactive shell or CI.
export CLOUDFLARE_API_TOKEN=...  CLOUDFLARE_ACCOUNT_ID=...

# All four, or none — see 0.2.
export R2_ACCOUNT_ID=...         R2_BUCKET=ecfr-atlas-content
export R2_ACCESS_KEY_ID=...      R2_SECRET_ACCESS_KEY=...

pnpm sync:backfill --remote --dry-run   # fetch, parse, validate; write nothing
pnpm sync:backfill --remote             # for real
```

`--remote` is not optional here. The pipeline defaults to `--local` — a deliberate guard so a
contributor cannot write to production by forgetting a flag — and the local miniflare database
has no schema unless you have run `pnpm db:reset`. Omitting the flag fails with
"no such table: sync_run".

**If a run dies mid-way** — crash, network drop, Ctrl-C, or a mid-apply failure ("segments were
only partly applied") — rerun **without** `--fresh`: completed titles are skipped via their
checkpoints, their staged SQL is requeued, and their staged HTML survives to be promoted by the
resume. D1 applies retry transient wrangler failures on their own (run 7 forfeited a 95-minute
run to a single upstream `Authentication error [code: 10000]` that the retry now absorbs).
`--fresh` remains for exactly two situations: the publish gate **refused** the previous run — a
judgement against the data itself, so its staged content is discarded — or parser/measurement
code changed and the checkpoints no longer describe what the code would produce.

On macOS the entries hold a `caffeinate` sleep assertion while they run. That is not decoration:
run 5 froze under Deep Idle sleep mid-title-40, and the first R2 `PUT` transmitted after a freeze
carried a signature old enough for R2 to reject it (`403 RequestTimeTooSkewed`).

The dry run is worth the time on a first attempt: it exercises the fetch, the parser and the
publish gate without touching D1, so a credential or schema problem surfaces before an hour of
downloading. Watch the log for `no R2 credentials` — that line means body text will be measured
but not stored.

Expect 30–60 minutes wall clock. The pipeline holds itself to ≤8 req/s because eCFR runs a token
bucket, not a concurrency gate — serialising does *not* avoid it. Two failure bodies are retried
differently: a 162-byte body is a 429 with no `Retry-After` (blind exponential backoff), a
246-byte body is a 504 at ~50 s on a large title (longer patience, it is roughly a coin flip on
title-49).

**Before deploying anything, read the publish gate output.** It refuses to advance the published
pointer if totals move more than 5%, if agency or title counts drop at all, if uncounted nodes
grow more than 10%, or if any title was left half-written. On a first run most checks report
"skipped — no previous run", which is expected.

Sanity-check the result:

```bash
pnpm exec wrangler d1 execute ecfr-atlas --remote --config apps/api/wrangler.jsonc \
  --command "SELECT (SELECT COUNT(*) FROM agency)         AS agencies,
                    (SELECT COUNT(*) FROM title)          AS titles,
                    (SELECT COUNT(*) FROM structure_node) AS nodes,
                    (SELECT COUNT(*) FROM amendment)      AS amendments,
                    (SELECT COUNT(*) FROM structure_node WHERE word_count IS NULL) AS unknown"
```

Expect roughly: 316 agencies, 50 titles, ~275,000 nodes, ~478,000 amendments. A non-zero `unknown`
is **not** a failure — it is the system working. Those rows are what `/data-quality` publishes.

---

## Phase 2 — Deploy

### 2.1 First deploy

```bash
pnpm --filter @ecfr-atlas/api vendor:scalar         # self-hosted docs bundle
pnpm exec wrangler deploy --config apps/api/wrangler.jsonc

ECFR_SNAPSHOT_DIR=sync-output/snapshot pnpm build
pnpm exec wrangler deploy --config apps/web/wrangler.jsonc
```

### 2.2 Routes

Add to `apps/web/wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "ecfr.fixit.works/*", "zone_name": "fixit.works" }]
```

and to `apps/api/wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "ecfr.fixit.works/v1/*",         "zone_name": "fixit.works" },
  { "pattern": "ecfr.fixit.works/docs",         "zone_name": "fixit.works" },
  { "pattern": "ecfr.fixit.works/openapi.json", "zone_name": "fixit.works" }
]
```

Then set the plain vars in `apps/api/wrangler.jsonc`'s `vars` block:
`SITE_ORIGIN=https://ecfr.fixit.works`, `DOCS_URL=https://ecfr.fixit.works/docs`,
`ENVIRONMENT=production`, and `PUBLIC_CONTENT_BASE_URL` once a public R2 route exists.

Redeploy both. DNS needs no manual record — a Workers route on a zone Cloudflare already manages
is sufficient.

### 2.3 Verify

```bash
curl -s https://ecfr.fixit.works/v1/meta | jq '{published_run_id, source_date, corpus}'
curl -sI https://ecfr.fixit.works/ | head -5
curl -s https://ecfr.fixit.works/v1/agencies?limit=1 | jq '.data[0].deduplicated'
```

The third one matters most: it must return a `{words, status, reason, method}` object, never a
bare number. If `words` is `null`, `status` and `reason` must explain why.

Then look at `/data-quality` and `/methodology` in a browser. They are the credibility surface —
if they are wrong or empty, the site is not ready to be public regardless of what the API returns.

---

## Phase 3 — Automate

`deploy.yml` now publishes code changes on every push to `master`, and `sync.yml` publishes data
changes on weekdays at 07:00 UTC. Both are already committed.

### Where the recurring sync should run

**Recommendation: keep the nightly delta in GitHub Actions.** It is free and unlimited for public
repos, it already works, it has logs and a re-run button, and — decisively — the job's real work is
writing to D1 and R2 and deploying to Cloudflare. Running it in the homelab means putting a
Cloudflare deploy token into the cluster and maintaining a container image, for a job that
processes a median of 48 changed sections and finishes in minutes.

**The one thing that flips it:** GitHub disables scheduled workflows in public repos after exactly
60 days with no repository activity, and the disable takes out the *entire workflow file*,
`workflow_dispatch` included. A quiet stretch is enough to silently stop the nightly. This is
mitigated, not eliminated, by the Healthchecks.io dead-man's switch below — which is the only
mechanism that alerts on a run that never *started*. If you would rather not depend on that,
move the cron to the homelab; the pipeline is a plain Node process and does not care where it runs.

### Where the homelab genuinely earns its place

Two jobs, neither of which is the nightly:

1. **The backfill and any full reprocess.** 810 MB of XML, 8 GB of heap, and a resumable
   `.sync-cache/`. On Longhorn that cache survives, so re-deriving word counts after a parser
   change costs zero eCFR requests instead of another full 810 MB pull. That is a real,
   repeated saving and it is the strongest argument for the homelab in this project.

2. **A raw-corpus mirror.** Keeping the fetched XML lets you answer "what did the CFR look like
   on date X" without depending on eCFR retaining it.

If you want the recurring sync there too, the shape matches your existing
`infrastructure/registry-gc-cronjob.yaml` pattern — MicroK8s `CronJob`, image built and pushed to
the in-cluster registry at `10.10.1.202:5000`, a Longhorn PVC mounted at `/cache` for
`.sync-cache/`, and credentials from a `Secret` sourced from the Ansible vault rather than
committed. Schedule `0 7 * * 1-5` to match, and point the same Healthchecks.io URL at it so the
alerting story does not change. Set `concurrencyPolicy: Forbid` — a second sync starting while one
is mid-flight would interleave two insert-then-prune passes.

### Dead-man's switch

Create a check at healthchecks.io with a cron schedule of `0 7 * * 1-5` (so weekends are not
counted as misses) and a grace period of ~3 hours. Put the ping URL in `HEALTHCHECK_SYNC_URL`.
`sync.yml` already pings `/start` on entry, the bare URL on success, and `/fail` in the failure
branch. This is the only alert that fires when a run never starts.

---

## Phase 4 — Open the API

The API is live from Phase 2 but unannounced. Before pointing anyone at it:

- Register a real account through `POST /v1/account/register` and confirm the verification flow.
  **Email is not wired up** — `LoggingMailer` writes the token to the Worker log instead of
  sending it. Outside `production`/`staging` the token also comes back in the response body so
  registration is testable. Wiring Cloudflare Email Service is the remaining task here.
- Exercise `/v1/diff` on a section you know changed and confirm the second call returns
  `cached: true`. First viewer pays, everyone after is served from R2.
- Confirm the 429 body explains the tier and how to get a key.

---

## Phase 5 — Open data

`export.yml` runs `wrangler d1 export`, gzips (~30 MB), and uploads to the public exports bucket
as `YYYY-MM-DD.sql.gz` plus `latest.sql.gz` with a row-count manifest and a sha256. Enable public
access on `ecfr-atlas-exports` and link it from `/about`. R2 egress is free, so a nightly public
SQLite dump of CFR structure, word counts and ~478,000 amendment records costs storage only —
and it is the actual civic deliverable.

---

## Operational notes

**Rollback.** `wrangler rollback --config apps/<app>/wrangler.jsonc` reverts a Worker to its
previous version. It does **not** revert D1 or R2. If a sync published bad data, the fix is to
re-run the sync from a corrected pipeline; the publish gate is what should have prevented it, so
a bad publish is also a bug report against the gate.

**Migrations must stay additive.** `deploy.yml` applies migrations *before* deploying the Worker,
so a new column read by new code exists before the code that reads it. The reverse order is a
window of 500s. A destructive migration breaks the currently-live Worker during that window —
add columns, backfill, then drop in a later release.

**Cost.** $0/month until the API's request-time work exceeds the free plan's 10 ms CPU per
invocation. Static assets are free and unmetered; D1 at ~180 MB is inside the 500 MB free cap;
R2 at ~163 MB is inside the 10 GB-month free tier with free egress. The likely first paid line is
Workers Paid at $5/month if `/v1/diff` gets real traffic.

**The invariant worth protecting.** No user-facing route may fetch ecfr.gov. `/v1/diff` is the
single documented exception and must memoise to R2 permanently. There is a test that stubs
`fetch` to throw on any ecfr.gov host and exercises every other route — if it ever fails, the
site's uptime has been quietly coupled to someone else's.
