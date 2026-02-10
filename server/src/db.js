import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, "..", "data", "app.db");

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS agencies (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    short_name TEXT,
    display_name TEXT,
    sortable_name TEXT,
    parent_slug TEXT,
    cfr_references TEXT DEFAULT '[]',
    word_count INTEGER DEFAULT 0,
    checksum TEXT,
    last_fetched TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS titles (
    number INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    latest_amended_on TEXT,
    latest_issue_date TEXT,
    up_to_date_as_of TEXT,
    reserved INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS agency_cfr_content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agency_slug TEXT NOT NULL,
    title_number INTEGER NOT NULL,
    chapter TEXT,
    subtitle TEXT,
    subchapter TEXT,
    part TEXT,
    word_count INTEGER DEFAULT 0,
    section_count INTEGER DEFAULT 0,
    checksum TEXT,
    last_fetched TEXT,
    FOREIGN KEY (agency_slug) REFERENCES agencies(slug)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_agency_cfr_unique
    ON agency_cfr_content(agency_slug, title_number, COALESCE(chapter,''), COALESCE(subtitle,''), COALESCE(subchapter,''), COALESCE(part,''));

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agency_slug TEXT NOT NULL,
    word_count INTEGER DEFAULT 0,
    checksum TEXT,
    snapshot_date TEXT NOT NULL,
    FOREIGN KEY (agency_slug) REFERENCES agencies(slug)
  );

  CREATE TABLE IF NOT EXISTS ingest_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT DEFAULT 'idle',
    progress INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    message TEXT,
    started_at TEXT,
    completed_at TEXT
  );

  INSERT OR IGNORE INTO ingest_status (id, status) VALUES (1, 'idle');
`);

export default db;
