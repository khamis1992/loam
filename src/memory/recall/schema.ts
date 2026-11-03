import type { DatabaseSync } from "node:sqlite";

const TABLES = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS recall_memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  content TEXT NOT NULL,
  lang TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  confidence REAL NOT NULL DEFAULT 0.8,
  prominence REAL NOT NULL DEFAULT 1.0,
  state TEXT NOT NULL DEFAULT 'active',
  is_latest INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,
  confirmations INTEGER NOT NULL DEFAULT 0,
  access_count INTEGER NOT NULL DEFAULT 0,
  event_at INTEGER,
  document_at INTEGER NOT NULL,
  last_access_at INTEGER,
  trashed_at INTEGER,
  source_ref TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  embedding BLOB,
  embedding_model TEXT,
  content_hash TEXT NOT NULL,
  decay_rate REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rm_scope_latest ON recall_memories(scope, is_latest, state, prominence DESC);
CREATE INDEX IF NOT EXISTS ix_rm_event ON recall_memories(scope, event_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_rm_hash ON recall_memories(scope, content_hash) WHERE state <> 'trashed';
CREATE TABLE IF NOT EXISTS recall_relations (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES recall_memories(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES recall_memories(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  confidence REAL NOT NULL,
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(from_id, to_id, type)
);
CREATE TABLE IF NOT EXISTS recall_lsh (
  memory_id TEXT NOT NULL REFERENCES recall_memories(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  model TEXT NOT NULL,
  tbl INTEGER NOT NULL,
  bucket INTEGER NOT NULL,
  PRIMARY KEY(memory_id, model, tbl)
);
CREATE INDEX IF NOT EXISTS ix_lsh ON recall_lsh(model, tbl, bucket, scope);
CREATE TABLE IF NOT EXISTS recall_core (
  scope TEXT NOT NULL,
  block TEXT NOT NULL,
  entries TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope, block)
);
CREATE TABLE IF NOT EXISTS recall_core_history (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  block TEXT NOT NULL,
  op TEXT NOT NULL,
  before TEXT,
  after TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recall_events (
  id TEXT PRIMARY KEY,
  memory_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recall_gardener_runs (
  id TEXT PRIMARY KEY,
  tick TEXT NOT NULL,
  catch_up INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  report TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS recall_ingest_queue (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS recall_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  review_mode TEXT NOT NULL,
  files INTEGER,
  ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  verdict TEXT,
  findings TEXT,
  accepted INTEGER,
  created_at INTEGER NOT NULL
);
`;

export interface SchemaStatus {
  fts: boolean;
}

export function ensureRecallSchema(db: DatabaseSync): SchemaStatus {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  db.exec(TABLES);
  const fts = probeFts(db);
  return { fts };
}

function probeFts(db: DatabaseSync): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(norm_content, content='', tokenize='unicode61 remove_diacritics 2')");
    return true;
  } catch {
    return false;
  }
}
