-- ecfr-atlas initial schema
--
-- Design rules, in priority order:
--   1. A number that was not measured cannot be stored. Enforced by CHECK, not convention.
--   2. Agency <-> CFR scope is many-to-many. Shared jurisdiction is a fact to surface, not
--      a bug to hide, and modelling it per-agency is what caused silent double counting.
--   3. Every mutable row carries `last_seen_run_id` so sync can insert-then-prune: a crashed
--      run leaves a superset of the truth, never a hole.
--   4. No regulation body text lives here. Six sections exceed D1's 2,000,000-byte row cap
--      (largest: 50 CFR 17.95 at 5,010,215 B). Text goes to R2; this table holds the pointer.

-- ─── sync bookkeeping ────────────────────────────────────────────────────────

CREATE TABLE sync_run (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT    NOT NULL CHECK (kind IN ('backfill', 'delta', 'recount')),
  status         TEXT    NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'aborted')),
  started_at     TEXT    NOT NULL,
  finished_at    TEXT,
  -- The eCFR snapshot date this run captured. Null until known.
  source_date    TEXT,
  titles_touched INTEGER NOT NULL DEFAULT 0,
  nodes_upserted INTEGER NOT NULL DEFAULT 0,
  nodes_pruned   INTEGER NOT NULL DEFAULT 0,
  fetch_failures INTEGER NOT NULL DEFAULT 0,
  parse_failures INTEGER NOT NULL DEFAULT 0,
  message        TEXT
);

CREATE INDEX idx_sync_run_recent ON sync_run(started_at DESC);

-- Singleton pointer to the last run whose output passed the publish gate. The site and API
-- read this; a failed run never advances it, so a bad sync degrades to stale-but-correct
-- rather than empty-or-wrong.
CREATE TABLE app_meta (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  published_run_id   INTEGER REFERENCES sync_run(id),
  published_at       TEXT,
  -- eCFR's own snapshot date for the published data, surfaced as "current as of".
  source_date        TEXT,
  schema_version     INTEGER NOT NULL DEFAULT 1
);

INSERT INTO app_meta (id, schema_version) VALUES (1, 1);

-- Per-title watermark driving the nightly delta.
-- NOTE: keyed on latest_amended_on, never up_to_date_as_of. The latter advances daily for
-- all 49 titles regardless of content and would mark everything dirty every night.
CREATE TABLE title_watermark (
  title_number       INTEGER PRIMARY KEY REFERENCES title(number),
  latest_amended_on  TEXT,
  latest_issue_date  TEXT,
  last_synced_at     TEXT,
  last_synced_run_id INTEGER REFERENCES sync_run(id)
);

-- ─── reference data ──────────────────────────────────────────────────────────

CREATE TABLE title (
  number            INTEGER PRIMARY KEY,
  name              TEXT    NOT NULL,
  -- All three are NULL for reserved titles (title 35). Callers must null-guard.
  latest_amended_on TEXT,
  latest_issue_date TEXT,
  up_to_date_as_of  TEXT,
  reserved          INTEGER NOT NULL DEFAULT 0 CHECK (reserved IN (0, 1)),
  last_seen_run_id  INTEGER NOT NULL
);

CREATE TABLE agency (
  slug             TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  short_name       TEXT,
  display_name     TEXT NOT NULL,
  sortable_name    TEXT NOT NULL,
  parent_slug      TEXT REFERENCES agency(slug),
  depth            INTEGER NOT NULL DEFAULT 0,
  last_seen_run_id INTEGER NOT NULL
);

CREATE INDEX idx_agency_parent   ON agency(parent_slug);
CREATE INDEX idx_agency_sortable ON agency(sortable_name);

-- ─── structure tree ──────────────────────────────────────────────────────────

CREATE TABLE structure_node (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Full ancestry path, e.g. 'title-40/chapter-I/subchapter-C/part-60'.
  -- Unique across all 275,271 nodes with zero collisions. This is the real key;
  -- eCFR's generated ids churn between imports and must not be keyed on.
  citation          TEXT    NOT NULL UNIQUE,
  parent_citation   TEXT,
  title_number      INTEGER NOT NULL REFERENCES title(number),
  node_type         TEXT    NOT NULL,
  -- NULL for hed1 nodes (151 corpus-wide) and generated subject groups.
  identifier        TEXT,
  label             TEXT,
  reserved          INTEGER NOT NULL DEFAULT 0 CHECK (reserved IN (0, 1)),

  -- Denormalised ancestry: turns the table-of-contents query into one indexed range scan
  -- instead of a recursive CTE. Worth the ~8 bytes/row at 275k rows.
  subtitle_id       TEXT,
  chapter_id        TEXT,
  subchapter_id     TEXT,
  part_id           TEXT,

  -- Additive byte size from eCFR's structure JSON. Free change fingerprint: compare against
  -- the stored value to decide whether to refetch, without downloading any XML.
  xml_bytes         INTEGER,
  -- R2 object key for rendered HTML. Written only after a verified PUT, so a non-null value
  -- always resolves.
  content_key       TEXT,

  word_count        INTEGER,
  word_count_status TEXT    NOT NULL DEFAULT 'not_computed',
  word_count_method TEXT,
  word_count_reason TEXT,
  word_count_run_id INTEGER REFERENCES sync_run(id),

  last_seen_run_id  INTEGER NOT NULL,

  CHECK (word_count_status IN (
    'counted', 'rolled_up', 'reserved_empty', 'stale',
    'not_computed', 'unavailable_fetch_failed',
    'unavailable_parse_failed', 'unavailable_too_large'
  )),
  CHECK (word_count_method IS NULL OR word_count_method IN (
    'xml_parse', 'descendant_sum', 'reserved'
  )),
  -- The load-bearing constraint. It is physically impossible to store a number without
  -- claiming to have measured it, or to claim a measurement without a number.
  CHECK (
    (word_count IS NULL) =
    (word_count_status IN (
      'not_computed', 'unavailable_fetch_failed',
      'unavailable_parse_failed', 'unavailable_too_large'
    ))
  ),
  CHECK (word_count IS NULL OR word_count >= 0),
  -- An unknown must say why; a known must not carry a reason.
  CHECK ((word_count IS NULL) = (word_count_reason IS NOT NULL))
);

CREATE INDEX idx_node_toc        ON structure_node(title_number, chapter_id, node_type, part_id);
CREATE INDEX idx_node_parent     ON structure_node(parent_citation);
CREATE INDEX idx_node_type       ON structure_node(node_type, title_number);
CREATE INDEX idx_node_prune      ON structure_node(last_seen_run_id);
-- Partial index so the /data-quality page is a cheap scan of only the unknowns.
CREATE INDEX idx_node_unknown    ON structure_node(word_count_status) WHERE word_count IS NULL;

-- ─── agency <-> CFR scope (many-to-many) ─────────────────────────────────────

-- One row per (agency, scope). 17 of 487 scopes are claimed by 2-6 agencies; modelling this
-- as a join table is what makes both an honest deduplicated total and a shared-jurisdiction
-- view possible from the same data.
CREATE TABLE agency_cfr_reference (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_slug      TEXT    NOT NULL REFERENCES agency(slug) ON DELETE CASCADE,
  -- Canonical scope key, e.g. 'title-40/chapter-I/part-60'. Normalised so that key order
  -- and empty-string levels cannot produce duplicate rows for the same scope.
  ref_key          TEXT    NOT NULL,
  title_number     INTEGER NOT NULL REFERENCES title(number),
  -- The narrowest level this reference actually specifies. Honouring it is mandatory.
  narrowest_level  TEXT    NOT NULL CHECK (narrowest_level IN
                     ('title', 'subtitle', 'chapter', 'subchapter', 'part')),
  subtitle_id      TEXT,
  chapter_id       TEXT,
  subchapter_id    TEXT,
  part_id          TEXT,
  -- Resolved target node. NULL when the scope does not correspond to a node in the current
  -- structure (eCFR references occasionally point at removed scopes).
  node_citation    TEXT REFERENCES structure_node(citation),
  last_seen_run_id INTEGER NOT NULL,
  UNIQUE (agency_slug, ref_key)
);

CREATE INDEX idx_ref_agency ON agency_cfr_reference(agency_slug);
CREATE INDEX idx_ref_key    ON agency_cfr_reference(ref_key);
CREATE INDEX idx_ref_title  ON agency_cfr_reference(title_number);

-- Materialised overlap: which scopes more than one agency claims. Derived, but stored so
-- the shared-jurisdiction page is a single indexed read.
CREATE TABLE scope_overlap (
  ref_key       TEXT    PRIMARY KEY,
  title_number  INTEGER NOT NULL,
  agency_count  INTEGER NOT NULL CHECK (agency_count > 1),
  agency_slugs  TEXT    NOT NULL,  -- JSON array, ordered by sortable_name
  word_count    INTEGER,           -- NULL when the scope's own count is unknown
  last_seen_run_id INTEGER NOT NULL
);

CREATE INDEX idx_overlap_words ON scope_overlap(word_count DESC);

-- ─── rollups ─────────────────────────────────────────────────────────────────

-- Both totals are published. They differ by the shared scopes, and which one is "right"
-- depends on the question being asked, so the site labels them rather than picking silently.
CREATE TABLE agency_rollup (
  agency_slug             TEXT PRIMARY KEY REFERENCES agency(slug) ON DELETE CASCADE,
  -- Sum over this agency's scopes, counting a shared scope in full. Answers
  -- "how much regulation is this agency responsible for?"
  attributed_word_count   INTEGER,
  -- Shared scopes divided evenly among claimants, so the corpus total is conserved.
  -- Answers "how does the CFR divide up?" This is the dashboard headline.
  deduplicated_word_count INTEGER,
  -- Including sub-agencies.
  subtree_attributed      INTEGER,
  subtree_deduplicated    INTEGER,
  refs_total              INTEGER NOT NULL DEFAULT 0,
  refs_counted            INTEGER NOT NULL DEFAULT 0,
  shared_refs             INTEGER NOT NULL DEFAULT 0,
  children_count          INTEGER NOT NULL DEFAULT 0,
  -- refs_counted / refs_total. Rendered next to every total so partial coverage is visible
  -- rather than silently folded into a smaller number.
  coverage_pct            REAL    NOT NULL DEFAULT 0,
  last_seen_run_id        INTEGER NOT NULL,
  CHECK (refs_counted <= refs_total),
  CHECK (coverage_pct >= 0 AND coverage_pct <= 1)
);

CREATE INDEX idx_rollup_dedup ON agency_rollup(deduplicated_word_count DESC);

-- Time series. One row per agency per successful run, so change over time is chartable and
-- a suspicious jump is auditable back to a run id.
CREATE TABLE agency_snapshot (
  agency_slug             TEXT    NOT NULL REFERENCES agency(slug) ON DELETE CASCADE,
  snapshot_date           TEXT    NOT NULL,
  run_id                  INTEGER NOT NULL REFERENCES sync_run(id),
  attributed_word_count   INTEGER,
  deduplicated_word_count INTEGER,
  coverage_pct            REAL,
  PRIMARY KEY (agency_slug, snapshot_date)
);

CREATE INDEX idx_snapshot_date ON agency_snapshot(snapshot_date DESC);

-- ─── amendments ──────────────────────────────────────────────────────────────

-- (title, section, amendment_date) is NOT unique — 1,619 collisions in title 21 alone.
-- issue_date is required to make the key unique.
CREATE TABLE amendment (
  title_number       INTEGER NOT NULL REFERENCES title(number),
  section_identifier TEXT    NOT NULL,
  amendment_date     TEXT    NOT NULL,
  issue_date         TEXT    NOT NULL,
  part               TEXT,
  subpart            TEXT,
  name               TEXT,
  removed            INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
  substantive        INTEGER NOT NULL DEFAULT 1 CHECK (substantive IN (0, 1)),
  last_seen_run_id   INTEGER NOT NULL,
  PRIMARY KEY (title_number, section_identifier, amendment_date, issue_date)
);

CREATE INDEX idx_amendment_issue ON amendment(issue_date DESC);
CREATE INDEX idx_amendment_part  ON amendment(title_number, part, issue_date DESC);
-- eCFR's full-text horizon. Diffs before this date cannot resolve an old side.
CREATE INDEX idx_amendment_recent ON amendment(issue_date DESC) WHERE issue_date >= '2017-01-01';

-- ─── public API: accounts, keys, quota ───────────────────────────────────────

CREATE TABLE api_account (
  id            TEXT PRIMARY KEY,          -- uuid
  email         TEXT NOT NULL UNIQUE,
  -- Free-text, shown in nothing public; used to contact about abuse or breaking changes.
  organization  TEXT,
  intended_use  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'active', 'suspended')),
  -- Email-verification token, hashed. Cleared once verified.
  verify_token_hash TEXT,
  verify_sent_at    TEXT,
  created_at    TEXT NOT NULL,
  verified_at   TEXT
);

CREATE INDEX idx_account_verify ON api_account(verify_token_hash) WHERE verify_token_hash IS NOT NULL;

CREATE TABLE api_key (
  id            TEXT PRIMARY KEY,          -- uuid; also the public key id prefix
  account_id    TEXT NOT NULL REFERENCES api_account(id) ON DELETE CASCADE,
  -- SHA-256 of the full secret. The secret itself is shown once at creation and never stored.
  key_hash      TEXT NOT NULL UNIQUE,
  -- Last 4 chars, so a user can identify which key is which in a list.
  key_suffix    TEXT NOT NULL,
  label         TEXT,
  tier          TEXT NOT NULL DEFAULT 'registered'
                  CHECK (tier IN ('registered', 'elevated')),
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  revoked_at    TEXT
);

CREATE INDEX idx_key_hash    ON api_key(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_key_account ON api_key(account_id);

-- Daily quota counter.
--
-- The Workers rate-limiting binding is per-Cloudflare-location and documented as "not an
-- accurate accounting system", so it handles burst only. Accurate daily quota needs a real
-- counter, and this is it: one atomic
--   INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count
-- per authenticated request.
CREATE TABLE api_usage_day (
  key_id      TEXT    NOT NULL REFERENCES api_key(id) ON DELETE CASCADE,
  day         TEXT    NOT NULL,            -- YYYY-MM-DD, UTC
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);

-- Lets the retention job drop old rows with one indexed range delete.
CREATE INDEX idx_usage_day ON api_usage_day(day);
