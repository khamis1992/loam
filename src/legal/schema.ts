/**
 * SQL schemas for the two legal databases.
 *
 *  - Corpus DB (`<DATA_DIR>/legal/qatar-law.db`): public law text, versions,
 *    amendments and the derived lexical/vector index. Not secret, not encrypted;
 *    integrity is protected by per-version sha256 and the import audit trail.
 *  - Matters DB (`<DATA_DIR>/legal/matters.db`): client matters, contracts,
 *    clauses, review records, the retrieval ledger and the hash-chained audit
 *    log. Every column that can hold client text is an AES-256-GCM envelope
 *    (see crypto.ts); only ids, hashes, dates and enums are stored in clear.
 *
 * Both files are separate from `manus.db` (OBSERVED: Loam keeps derived
 * indexes in their own sqlite files, e.g. `.loam/code-index.db` and the wiki's
 * `.index.sqlite`), so the corpus can be rebuilt or replaced without touching
 * task history, and the matters file can be backed up or purged on its own.
 */

export const CORPUS_SCHEMA_VERSION = 1;
export const MATTERS_SCHEMA_VERSION = 1;

export const CORPUS_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legislations (
  key TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  year INTEGER NOT NULL,
  number INTEGER NOT NULL,
  title_ar TEXT NOT NULL,
  title_en TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  issue_date TEXT,
  publish_date TEXT,
  effective_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('in_force','amended','partially_repealed','repealed','not_yet_in_force')),
  repealed_by TEXT,
  repealed_at TEXT,
  source_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS legislation_aliases (
  alias_norm TEXT NOT NULL,
  leg_key TEXT NOT NULL REFERENCES legislations(key) ON DELETE CASCADE,
  PRIMARY KEY (alias_norm, leg_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS articles (
  key TEXT PRIMARY KEY,
  leg_key TEXT NOT NULL REFERENCES legislations(key) ON DELETE CASCADE,
  part TEXT NOT NULL CHECK (part IN ('issuance','body')),
  label TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  heading TEXT,
  repealed_at TEXT,
  repealed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_articles_leg ON articles(leg_key, part, ordinal);
CREATE TABLE IF NOT EXISTS article_versions (
  avid TEXT PRIMARY KEY,
  article_key TEXT NOT NULL REFERENCES articles(key) ON DELETE CASCADE,
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('original','amendment')),
  introduced_by TEXT,
  provenance TEXT NOT NULL CHECK (provenance IN ('official_gazette','almeezan_manual','moj_data_agreement','research_snapshot')),
  source_json TEXT NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS idx_versions_article ON article_versions(article_key, effective_from);
CREATE TABLE IF NOT EXISTS amendments (
  id TEXT PRIMARY KEY,
  amending_leg_key TEXT NOT NULL,
  amending_article TEXT NOT NULL,
  target_article_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('replace','insert','repeal')),
  effective_date TEXT NOT NULL,
  new_text TEXT,
  heading TEXT,
  source_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_amend_target ON amendments(target_article_key, effective_date);
CREATE TABLE IF NOT EXISTS postings (
  term TEXT NOT NULL,
  avid TEXT NOT NULL REFERENCES article_versions(avid) ON DELETE CASCADE,
  tf INTEGER NOT NULL,
  PRIMARY KEY (term, avid)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS doc_len (avid TEXT PRIMARY KEY REFERENCES article_versions(avid) ON DELETE CASCADE, len INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS vectors (
  avid TEXT NOT NULL REFERENCES article_versions(avid) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  PRIMARY KEY (avid, model)
) WITHOUT ROWID;
`;

export const MATTERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS matters (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  confidentiality TEXT NOT NULL CHECK (confidentiality IN ('public','internal','confidential','privileged')),
  egress TEXT NOT NULL CHECK (egress IN ('local_only','cloud_redacted','cloud_full')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retain_until TEXT,
  payload_enc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  payload_enc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clauses (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  categories TEXT NOT NULL,
  payload_enc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clauses_contract ON clauses(contract_id, idx);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('draft','verified','in_review','approved','rejected')),
  verified_sha256 TEXT,
  approved_sha256 TEXT,
  payload_enc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS retrieval_ledger (
  task_id TEXT NOT NULL,
  avid TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (task_id, avid)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  matter_id TEXT,
  subject TEXT NOT NULL,
  details_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`;
