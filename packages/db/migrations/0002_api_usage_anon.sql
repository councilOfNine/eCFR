-- Anonymous daily quota.
--
-- WHY THIS EXISTS: the design calls for anonymous requests to be metered on a hash of
-- (client IP + day), and `api_usage_day.key_id` has
--   REFERENCES api_key(id) ON DELETE CASCADE
-- on it. D1 enforces foreign keys, so an anonymous counter row has nowhere to point and the
-- INSERT fails at runtime. The alternatives were both worse: minting a real api_key row per
-- IP per day would fill the key table with principals nobody created, and dropping the FK
-- from 0001 would weaken a constraint that is doing real work for registered keys.
--
-- So anonymous accounting gets its own table with no FK, and the two counters stay
-- structurally different because they ARE different: one meters a credential, the other
-- meters a source.
--
-- PRIVACY: `anon_key` is sha256(secret salt + client IP + UTC day). The raw address is never
-- written and never logged. The day component means yesterday's hash cannot be joined to
-- today's, so the table cannot be used to build a movement history; the salt means a database
-- dump cannot be brute-forced back to addresses, which an unsalted SHA-256 of a 32-bit
-- address space plainly could.

CREATE TABLE api_usage_anon_day (
  -- 64 hex chars. Deliberately not called anything with "ip" in the name — it is not one.
  anon_key   TEXT    NOT NULL,
  day        TEXT    NOT NULL,            -- YYYY-MM-DD, UTC
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (anon_key, day)
);

-- Same shape as idx_usage_day: the retention job drops old rows with one indexed range
-- delete. Anonymous rows are the high-cardinality ones, so this index matters more here.
CREATE INDEX idx_usage_anon_day ON api_usage_anon_day(day);
