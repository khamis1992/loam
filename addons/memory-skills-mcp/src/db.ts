import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;
export type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS episodes (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  goal        TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  summary     TEXT NOT NULL,
  lessons     TEXT NOT NULL DEFAULT '[]',
  tools       TEXT NOT NULL DEFAULT '[]',
  artifacts   TEXT NOT NULL DEFAULT '[]',
  tags        TEXT NOT NULL DEFAULT '[]',
  project     TEXT,
  task_id     TEXT,
  duration_ms INTEGER,
  embedding   BLOB
);
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  id UNINDEXED, goal, summary, lessons, tags,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE INDEX IF NOT EXISTS episodes_created_idx ON episodes(created_at DESC);

CREATE TABLE IF NOT EXISTS facts (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'note',
  key        TEXT,
  text       TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '[]',
  embedding  BLOB
);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  id UNINDEXED, text, tags,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE INDEX IF NOT EXISTS facts_key_idx ON facts(key);
CREATE INDEX IF NOT EXISTS facts_updated_idx ON facts(updated_at DESC);

CREATE TABLE IF NOT EXISTS skills (
  slug          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  path          TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  uses          INTEGER NOT NULL DEFAULT 0,
  successes     INTEGER NOT NULL DEFAULT 0,
  failures      INTEGER NOT NULL DEFAULT 0,
  partials      INTEGER NOT NULL DEFAULT 0,
  last_used     TEXT,
  source        TEXT NOT NULL DEFAULT 'disk',
  tags          TEXT NOT NULL DEFAULT '[]',
  failure_notes TEXT NOT NULL DEFAULT '[]',
  body          TEXT NOT NULL DEFAULT '',
  hash          TEXT NOT NULL DEFAULT '',
  embedding     BLOB,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  pinned          INTEGER NOT NULL DEFAULT 0,
  last_read_at    TEXT,
  reads           INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  slug UNINDEXED, name, description, body, tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS skill_staging (
  slug          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  tool_calls    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const TRIGRAM_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_trigram USING fts5(
  id UNINDEXED, goal, summary, lessons, tools, tags,
  tokenize = 'trigram'
);
`;

/** True when the connected SQLite build provides the FTS5 trigram tokenizer. */
export function hasTrigram(db: Db): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'episodes_trigram'`).get();
  return row !== null && row !== undefined;
}

/** Create the optional trigram index when the tokenizer is available. Never throws. */
export function ensureTrigram(db: Db): boolean {
  if (hasTrigram(db)) return true;
  try {
    db.exec(TRIGRAM_SCHEMA);
    return true;
  } catch {
    return false;
  }
}

/** Episode columns indexed by the optional trigram table (substring search). */
export interface TrigramEpisode {
  id: string;
  goal: string;
  summary: string;
  lessons: string;
  tools: string;
  tags: string;
}

/**
 * Insert one episode into the trigram index when the tokenizer is available.
 * No-op otherwise, so callers never need to branch on tokenizer support.
 */
export function insertEpisodeTrigram(db: Db, e: TrigramEpisode): void {
  if (!hasTrigram(db)) return;
  runStatement(
    db,
    `INSERT INTO episodes_trigram (id, goal, summary, lessons, tools, tags) VALUES (?, ?, ?, ?, ?, ?)`,
    e.id,
    e.goal,
    e.summary,
    e.lessons,
    e.tools,
    e.tags,
  );
}

/** Rebuild the optional trigram index from `episodes`. Returns the row count indexed. */
export function rebuildEpisodeTrigram(db: Db): number {
  if (!hasTrigram(db)) return 0;
  runStatement(db, `DELETE FROM episodes_trigram`);
  const rows = rowsOf(db, `SELECT id, goal, summary, lessons, tools, tags FROM episodes`);
  for (const r of rows) {
    runStatement(
      db,
      `INSERT INTO episodes_trigram (id, goal, summary, lessons, tools, tags) VALUES (?, ?, ?, ?, ?, ?)`,
      String(r["id"]),
      String(r["goal"]),
      String(r["summary"]),
      String(r["lessons"]),
      String(r["tools"]),
      String(r["tags"]),
    );
  }
  return rows.length;
}

function migrate(db: Db): void {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(skills)`).all() as Row[]).map((r) => String(r["name"])),
  );
  if (!cols.has("lifecycle_state")) db.exec(`ALTER TABLE skills ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'`);
  if (!cols.has("pinned")) db.exec(`ALTER TABLE skills ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  if (!cols.has("last_read_at")) db.exec(`ALTER TABLE skills ADD COLUMN last_read_at TEXT`);
  if (!cols.has("reads")) db.exec(`ALTER TABLE skills ADD COLUMN reads INTEGER NOT NULL DEFAULT 0`);
}

export function openDatabase(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);
  migrate(db);
  ensureTrigram(db);
  return db;
}

export function rowsOf(db: Db, sql: string, ...params: Array<string | number | null>): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

export function rowOf(db: Db, sql: string, ...params: Array<string | number | null>): Row | null {
  const row = db.prepare(sql).get(...params);
  return (row as Row | undefined) ?? null;
}

export function runStatement(db: Db, sql: string, ...params: Array<string | number | null | Uint8Array>): void {
  db.prepare(sql).run(...params);
}
