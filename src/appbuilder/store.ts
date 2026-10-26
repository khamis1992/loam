// src/appbuilder/store.ts — Cap G core (MISSING §5.2): 13 app_* tables, idempotent
// ensureAppBuilderSchema(), and row mappers for app_projects. Later waves extend
// the mappers to every table as their features land.
import { randomBytes } from "node:crypto";
import { database } from "../server/sqliteStore.js";
import type { AppProject, AppProjectSettings, AppRunFlavor, TemplateFeatureId } from "./types.js";

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_projects (
  id                   TEXT PRIMARY KEY,
  task_id              TEXT NOT NULL UNIQUE,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  template_id          TEXT NOT NULL DEFAULT 'web-app',
  features             TEXT NOT NULL DEFAULT '[]',
  workspace_dir        TEXT NOT NULL,
  app_dir              TEXT NOT NULL DEFAULT 'app',
  default_flavor       TEXT NOT NULL DEFAULT 'quick' CHECK (default_flavor IN ('quick','goal')),
  status               TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','clarifying','awaiting_approval','building','verifying','versioning','racing','editing','failed','stopped')),
  active_version       INTEGER,
  settings             TEXT NOT NULL DEFAULT '{}',
  remix_of_project_id  TEXT,
  remix_of_version     INTEGER,
  deps_mode            TEXT NOT NULL DEFAULT 'shared' CHECK (deps_mode IN ('shared','own')),
  ai_base_url          TEXT,
  ai_model             TEXT,
  ai_daily_token_cap   INTEGER,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_runs (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,
  flavor               TEXT NOT NULL CHECK (flavor IN ('quick','goal')),
  prompt               TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','verifying','versioning','done','failed','stopped')),
  started_at           TEXT NOT NULL,
  finished_at          TEXT
);

CREATE TABLE IF NOT EXISTS app_questions (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,
  run_id               TEXT NOT NULL,
  title                TEXT NOT NULL,
  questions            TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','skipped','expired')),
  answers              TEXT,
  created_at           TEXT NOT NULL,
  answered_at          TEXT
);

CREATE TABLE IF NOT EXISTS app_plan_drafts (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,
  run_id               TEXT NOT NULL,
  revision             INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','declined','superseded')),
  doc                  TEXT NOT NULL,
  decline_reason       TEXT,
  created_at           TEXT NOT NULL,
  decided_at           TEXT,
  UNIQUE (project_id, revision)
);

CREATE TABLE IF NOT EXISTS app_assignments (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,
  plan_draft_id        TEXT,
  plan_task_ids        TEXT NOT NULL DEFAULT '[]',
  role                 TEXT NOT NULL,
  brief                TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
  report               TEXT,
  started_at           TEXT,
  finished_at          TEXT
);

CREATE TABLE IF NOT EXISTS app_verify_reports (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,
  run_id               TEXT NOT NULL,
  attempt              INTEGER NOT NULL,
  tier                 TEXT NOT NULL CHECK (tier IN ('fast','standard','strict')),
  pass                 INTEGER NOT NULL,
  steps                TEXT NOT NULL,
  console_errors       INTEGER NOT NULL DEFAULT 0,
  screenshots          TEXT NOT NULL DEFAULT '[]',
  visual_verdict       TEXT NOT NULL DEFAULT 'skipped' CHECK (visual_verdict IN ('pass','fail','unavailable','skipped')),
  visual_notes         TEXT NOT NULL DEFAULT '',
  log_path             TEXT NOT NULL,
  error                TEXT CHECK (error IS NULL OR error IN ('verify_limit','aborted')),
  started_at           TEXT NOT NULL,
  finished_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_versions (
  project_id           TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,
  number               INTEGER NOT NULL,
  title                TEXT NOT NULL,
  summary              TEXT NOT NULL DEFAULT '',
  "commit"             TEXT NOT NULL,
  parent_number        INTEGER,
  source               TEXT NOT NULL CHECK (source IN ('build','restore','edit','race','remix')),
  files_changed        TEXT NOT NULL DEFAULT '[]',
  verify_report_id     TEXT,
  usage                TEXT NOT NULL DEFAULT '{}',
  added_packages       TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL,
  PRIMARY KEY (project_id, number)
);

CREATE TABLE IF NOT EXISTS app_runtime_errors (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('console.error','unhandledrejection','error','vite','http')),
  message              TEXT NOT NULL,
  stack                TEXT,
  source               TEXT,
  url                  TEXT,
  count                INTEGER NOT NULL DEFAULT 1,
  first_seen_at        TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_prompt_queue (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,
  position             INTEGER NOT NULL,
  content              TEXT NOT NULL,
  flavor               TEXT NOT NULL CHECK (flavor IN ('quick','goal')),
  attachments          TEXT NOT NULL DEFAULT '[]',
  status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','removed')),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_queue_state (
  project_id           TEXT PRIMARY KEY REFERENCES app_projects(id) ON DELETE CASCADE,
  paused               INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_races (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,
  prompt               TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('running','scoring','choosing','promoted','aborted','failed')),
  reason               TEXT,
  chosen_branch_id     TEXT,
  created_at           TEXT NOT NULL,
  finished_at          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS app_races_one_running ON app_races(project_id) WHERE status IN ('running','scoring','choosing');

CREATE TABLE IF NOT EXISTS app_race_branches (
  id                   TEXT PRIMARY KEY,
  race_id              TEXT NOT NULL REFERENCES app_races(id) ON DELETE CASCADE,
  idx                  INTEGER NOT NULL,
  model                TEXT NOT NULL,
  tier_label           TEXT NOT NULL,
  worktree_dir         TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed','aborted')),
  score                TEXT,
  preview_url          TEXT,
  usage                TEXT NOT NULL DEFAULT '{}',
  UNIQUE (race_id, idx)
);

CREATE TABLE IF NOT EXISTS app_usage (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id         TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,
  run_id             TEXT,
  role               TEXT NOT NULL,
  step               TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('build','race','title','visual')),
  tier               TEXT NOT NULL,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_tokens      INTEGER NOT NULL DEFAULT 0,
  tool_calls         INTEGER NOT NULL DEFAULT 0,
  duration_ms        INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_usage_run ON app_usage(project_id, run_id);
`;

const APP_TABLES = [
  "app_projects", "app_runs", "app_questions", "app_plan_drafts", "app_assignments",
  "app_verify_reports", "app_versions", "app_runtime_errors", "app_prompt_queue",
  "app_queue_state", "app_races", "app_race_branches", "app_usage",
];

let schemaReady = false;

/** Idempotent: CREATE … IF NOT EXISTS for the 13 app_ tables; stamps appbuilder.schema=1.
 *  Guarded ALTERs migrate tables created by earlier revisions (§4.13 race wiring). */
export function ensureAppBuilderSchema(): void {
  const d = database();
  if (schemaReady) return;
  d.exec(SCHEMA_SQL);
  try {
    d.exec("ALTER TABLE app_runs ADD COLUMN race_id TEXT REFERENCES app_races(id) ON DELETE SET NULL");
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("duplicate column name"))) throw err;
  }
  d.prepare(`INSERT INTO metadata (key, value) VALUES ('appbuilder.schema', '1')
             ON CONFLICT(key) DO UPDATE SET value = '1'`).run();
  schemaReady = true;
}

export function appTableNames(): string[] {
  return [...APP_TABLES];
}

// ---------- app_projects mapper ----------

interface ProjectRow {
  id: string; task_id: string; title: string; description: string;
  template_id: string; features: string; workspace_dir: string; app_dir: string;
  default_flavor: string; status: string; active_version: number | null;
  settings: string; remix_of_project_id: string | null; remix_of_version: number | null;
  deps_mode: string; ai_base_url: string | null; ai_model: string | null; ai_daily_token_cap: number | null;
  created_at: string; updated_at: string;
}

function toProject(r: ProjectRow): AppProject {
  return {
    id: r.id,
    taskId: r.task_id,
    title: r.title,
    description: r.description,
    templateId: r.template_id as AppProject["templateId"],
    features: JSON.parse(r.features) as TemplateFeatureId[],
    workspaceDir: r.workspace_dir,
    appDir: r.app_dir as "app",
    defaultFlavor: r.default_flavor as AppRunFlavor,
    status: r.status as AppProject["status"],
    activeVersion: r.active_version,
    settings: JSON.parse(r.settings) as AppProjectSettings,
    remixOfProjectId: r.remix_of_project_id,
    remixOfVersion: r.remix_of_version,
    depsMode: r.deps_mode as AppProject["depsMode"],
    ai: { baseUrl: r.ai_base_url, model: r.ai_model, dailyTokenCap: r.ai_daily_token_cap },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** app_ + 12 lowercase base32 chars (spec §4.1.3 rule 2). */
export function newAppProjectId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i]! % 32];
  return `app_${out}`;
}

export function insertAppProject(p: AppProject): void {
  ensureAppBuilderSchema();
  database()
    .prepare(`INSERT INTO app_projects (id, task_id, title, description, template_id, features, workspace_dir, app_dir,
               default_flavor, status, active_version, settings, remix_of_project_id, remix_of_version, deps_mode,
               ai_base_url, ai_model, ai_daily_token_cap, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.id, p.taskId, p.title, p.description, p.templateId, JSON.stringify(p.features), p.workspaceDir, p.appDir,
         p.defaultFlavor, p.status, p.activeVersion, JSON.stringify(p.settings), p.remixOfProjectId, p.remixOfVersion, p.depsMode,
         p.ai.baseUrl, p.ai.model, p.ai.dailyTokenCap, p.createdAt, p.updatedAt);
}

export function getAppProject(id: string): AppProject | undefined {
  ensureAppBuilderSchema();
  const r = database().prepare("SELECT * FROM app_projects WHERE id = ?").get(id) as unknown as ProjectRow | undefined;
  return r ? toProject(r) : undefined;
}

export function listAppProjects(): AppProject[] {
  ensureAppBuilderSchema();
  const rows = database().prepare("SELECT * FROM app_projects ORDER BY created_at DESC").all() as unknown as ProjectRow[];
  return rows.map(toProject);
}

export function updateAppProjectRow(id: string, patch: Partial<Pick<AppProject, "title" | "description" | "features" | "defaultFlavor" | "status" | "settings" | "ai" | "activeVersion" | "depsMode">>): AppProject | undefined {
  ensureAppBuilderSchema();
  const cur = getAppProject(id);
  if (!cur) return undefined;
  const next: AppProject = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  database()
    .prepare(`UPDATE app_projects SET title=?, description=?, features=?, default_flavor=?, status=?, active_version=?,
               settings=?, deps_mode=?, ai_base_url=?, ai_model=?, ai_daily_token_cap=?, updated_at=? WHERE id=?`)
    .run(next.title, next.description, JSON.stringify(next.features), next.defaultFlavor, next.status, next.activeVersion,
         JSON.stringify(next.settings), next.depsMode, next.ai.baseUrl, next.ai.model, next.ai.dailyTokenCap, next.updatedAt, id);
  return next;
}

export function deleteAppProjectRow(id: string): boolean {
  ensureAppBuilderSchema();
  return Number(database().prepare("DELETE FROM app_projects WHERE id = ?").run(id).changes) > 0;
}
