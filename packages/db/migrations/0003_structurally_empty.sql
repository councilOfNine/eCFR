-- 0003: add the 'structurally_empty' status and 'declared_empty' method.
--
-- eCFR's structure JSON declares 150 leaf nodes with an additive XML size of zero —
-- editorial hed1 headings, one "[Note]" subtitle shell (41/subtitle-A), one
-- reserved-in-name-only subchapter (31/subtitle-B/chapter-II/subchapter-B). Their only
-- content is their label, and headings are excluded from word counts by design, so their
-- count is a definitional zero. Left as 'not_computed' they veto every ancestor roll-up and
-- the corpus total can never publish; reusing 'reserved_empty' would store rows whose
-- reserved flag (0) contradicts their status. A new status keeps every row self-consistent.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt. At this point in the
-- schema's history nothing has ever passed the publish gate and the table is empty in every
-- deployment, so the copy is free — but the INSERT..SELECT is written anyway so the
-- migration stays correct anywhere that assumption fails.

PRAGMA defer_foreign_keys = true;

CREATE TABLE structure_node_v2 (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Full ancestry path, e.g. 'title-40/chapter-I/subchapter-C/part-60'. The real key;
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
    'counted', 'rolled_up', 'reserved_empty', 'structurally_empty', 'stale',
    'not_computed', 'unavailable_fetch_failed',
    'unavailable_parse_failed', 'unavailable_too_large'
  )),
  CHECK (word_count_method IS NULL OR word_count_method IN (
    'xml_parse', 'descendant_sum', 'reserved', 'declared_empty'
  )),
  -- The load-bearing constraint. It is physically impossible to store a number without
  -- claiming to have measured it, or to claim a measurement without a number.
  -- 'structurally_empty' sits on the known side: it MUST carry its zero.
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

INSERT INTO structure_node_v2
  (id, citation, parent_citation, title_number, node_type, identifier, label, reserved,
   subtitle_id, chapter_id, subchapter_id, part_id, xml_bytes, content_key,
   word_count, word_count_status, word_count_method, word_count_reason, word_count_run_id,
   last_seen_run_id)
  SELECT id, citation, parent_citation, title_number, node_type, identifier, label, reserved,
         subtitle_id, chapter_id, subchapter_id, part_id, xml_bytes, content_key,
         word_count, word_count_status, word_count_method, word_count_reason, word_count_run_id,
         last_seen_run_id
    FROM structure_node;

DROP TABLE structure_node;
ALTER TABLE structure_node_v2 RENAME TO structure_node;

CREATE INDEX idx_node_toc        ON structure_node(title_number, chapter_id, node_type, part_id);
CREATE INDEX idx_node_parent     ON structure_node(parent_citation);
CREATE INDEX idx_node_type       ON structure_node(node_type, title_number);
CREATE INDEX idx_node_prune      ON structure_node(last_seen_run_id);
-- Partial index so the /data-quality page is a cheap scan of only the unknowns.
CREATE INDEX idx_node_unknown    ON structure_node(word_count_status) WHERE word_count IS NULL;
