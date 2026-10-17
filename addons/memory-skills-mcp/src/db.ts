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
  embedding     BLOB
);
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  slug UNINDEXED, name, description, body, tags,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

export function openDatabase(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);
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
