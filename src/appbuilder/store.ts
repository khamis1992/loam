// src/appbuilder/store.ts — Cap G core (MISSING §5.2): 13 app_* tables, idempotent
// ensureAppBuilderSchema(), and row mappers for app_projects. Later waves extend
// the mappers to every table as their features land.
import { randomBytes } from "node:crypto";
import { database } from "../server/sqliteStore.js";
import type {
  AppProject, AppProjectSettings, AppRunFlavor, AppTaskAssignment, AssignmentStatus,
  PlanDocument, PlanDraft, PlanDraftStatus, QuestionAnswer, QuestionsCard, TemplateFeatureId,
} from "./types.js";

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

// ---------- app_runs rows (MISSING §4.15.2 run contracts) ----------

export type AppRunStatus = "running" | "verifying" | "versioning" | "done" | "failed" | "stopped";

export interface AppRun {
  id: string;
  projectId: string;
  flavor: AppRunFlavor;
  prompt: string;
  status: AppRunStatus;
  startedAt: string;
  finishedAt: string | null;
  raceId: string | null;
}

interface RunRow {
  id: string; project_id: string; flavor: string; prompt: string;
  status: string; started_at: string; finished_at: string | null; race_id: string | null;
}

function toRun(r: RunRow): AppRun {
  return {
    id: r.id,
    projectId: r.project_id,
    flavor: r.flavor as AppRunFlavor,
    prompt: r.prompt,
    status: r.status as AppRunStatus,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    raceId: r.race_id,
  };
}

/** Same id rule as the other app_ rows: prefix + 12 lowercase base32 chars. */
export function newAppRowId(prefix: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i]! % 32];
  return `${prefix}${out}`;
}

export function insertRun(input: { id?: string; projectId: string; flavor: AppRunFlavor; prompt: string; raceId?: string | null }): AppRun {
  ensureAppBuilderSchema();
  const id = input.id ?? newAppRowId("run_");
  const at = new Date().toISOString();
  database()
    .prepare("INSERT INTO app_runs (id, project_id, flavor, prompt, status, started_at, race_id) VALUES (?, ?, ?, ?, 'running', ?, ?)")
    .run(id, input.projectId, input.flavor, input.prompt, at, input.raceId ?? null);
  return getRun(id)!;
}

export function getRun(id: string): AppRun | undefined {
  ensureAppBuilderSchema();
  const r = database().prepare("SELECT * FROM app_runs WHERE id = ?").get(id) as unknown as RunRow | undefined;
  return r ? toRun(r) : undefined;
}

export function listRuns(projectId: string): AppRun[] {
  ensureAppBuilderSchema();
  const rows = database().prepare("SELECT * FROM app_runs WHERE project_id = ? ORDER BY started_at DESC").all(projectId) as unknown as RunRow[];
  return rows.map(toRun);
}

export function updateRun(id: string, patch: { status?: AppRunStatus; raceId?: string | null }): AppRun | undefined {
  ensureAppBuilderSchema();
  const cur = getRun(id);
  if (!cur) return undefined;
  const next: AppRun = { ...cur, ...patch };
  database().prepare("UPDATE app_runs SET status = ?, race_id = ? WHERE id = ?").run(next.status, next.raceId, id);
  return next;
}

/** Terminal statuses only; stamps finished_at once (§5.2 app_runs semantics). */
export function finishRun(id: string, status: "done" | "failed" | "stopped"): AppRun | undefined {
  ensureAppBuilderSchema();
  const cur = getRun(id);
  if (!cur) return undefined;
  const finishedAt = cur.finishedAt ?? new Date().toISOString();
  database().prepare("UPDATE app_runs SET status = ?, finished_at = ? WHERE id = ?").run(status, finishedAt, id);
  return { ...cur, status, finishedAt };
}

// ---------- app_questions rows (MISSING §4.2.1 card lifecycle) ----------

interface QuestionRow {
  id: string; project_id: string; run_id: string; title: string; questions: string;
  status: string; answers: string | null; created_at: string; answered_at: string | null;
}

function toQuestionCard(r: QuestionRow): QuestionsCard {
  return {
    id: r.id,
    projectId: r.project_id,
    runId: r.run_id,
    title: r.title,
    questions: JSON.parse(r.questions),
    status: r.status as QuestionsCard["status"],
    answers: r.answers ? (JSON.parse(r.answers) as QuestionAnswer[]) : null,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
  };
}

export function insertQuestion(card: QuestionsCard): void {
  ensureAppBuilderSchema();
  database()
    .prepare("INSERT INTO app_questions (id, project_id, run_id, title, questions, status, answers, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(card.id, card.projectId, card.runId, card.title, JSON.stringify(card.questions), card.status,
         card.answers ? JSON.stringify(card.answers) : null, card.createdAt, card.answeredAt);
}

export function getQuestionCard(cardId: string): QuestionsCard | undefined {
  ensureAppBuilderSchema();
  const r = database().prepare("SELECT * FROM app_questions WHERE id = ?").get(cardId) as unknown as QuestionRow | undefined;
  return r ? toQuestionCard(r) : undefined;
}

export function listQuestionCards(projectId: string): QuestionsCard[] {
  ensureAppBuilderSchema();
  const rows = database().prepare("SELECT * FROM app_questions WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as unknown as QuestionRow[];
  return rows.map(toQuestionCard);
}

/** Answer or skip one card (§4.15.2 POST /questions/:cardId). Only a pending card can be resolved. */
export function answerQuestion(cardId: string, outcome: { answers: QuestionAnswer[] } | { skip: true }): QuestionsCard | { error: string } | undefined {
  ensureAppBuilderSchema();
  const cur = getQuestionCard(cardId);
  if (!cur) return undefined;
  if (cur.status !== "pending") return { error: "already_resolved" };
  const status = "skip" in outcome ? "skipped" : "answered";
  const answers = "skip" in outcome ? null : outcome.answers;
  database()
    .prepare("UPDATE app_questions SET status = ?, answers = ?, answered_at = ? WHERE id = ?")
    .run(status, answers ? JSON.stringify(answers) : null, new Date().toISOString(), cardId);
  return getQuestionCard(cardId);
}

// ---------- app_plan_drafts rows (MISSING §4.2.2 revision + decision rules) ----------

interface PlanDraftRow {
  id: string; project_id: string; run_id: string; revision: number; status: string;
  doc: string; decline_reason: string | null; created_at: string; decided_at: string | null;
}

function toPlanDraft(r: PlanDraftRow): PlanDraft {
  return {
    id: r.id,
    projectId: r.project_id,
    runId: r.run_id,
    revision: r.revision,
    status: r.status as PlanDraftStatus,
    doc: JSON.parse(r.doc) as PlanDocument,
    declineReason: r.decline_reason,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

export function getPlanDraft(draftId: string): PlanDraft | undefined {
  ensureAppBuilderSchema();
  const r = database().prepare("SELECT * FROM app_plan_drafts WHERE id = ?").get(draftId) as unknown as PlanDraftRow | undefined;
  return r ? toPlanDraft(r) : undefined;
}

export function listPlanDrafts(projectId: string): PlanDraft[] {
  ensureAppBuilderSchema();
  const rows = database().prepare("SELECT * FROM app_plan_drafts WHERE project_id = ? ORDER BY revision DESC").all(projectId) as unknown as PlanDraftRow[];
  return rows.map(toPlanDraft);
}

export function latestPlanDraft(projectId: string): PlanDraft | undefined {
  ensureAppBuilderSchema();
  const r = database().prepare("SELECT * FROM app_plan_drafts WHERE project_id = ? ORDER BY revision DESC LIMIT 1").get(projectId) as unknown as PlanDraftRow | undefined;
  return r ? toPlanDraft(r) : undefined;
}

/**
 * Stores one revision. Revisions start at 1 per project and increase by 1
 * (§4.2.2 rule 2); a new draft marks the previous `draft` row `superseded`.
 */
export function insertPlanDraft(input: { projectId: string; runId: string; doc: PlanDocument; id?: string; status?: PlanDraftStatus }): PlanDraft {
  ensureAppBuilderSchema();
  const db = database();
  const max = db.prepare("SELECT COALESCE(MAX(revision), 0) AS m FROM app_plan_drafts WHERE project_id = ?").get(input.projectId) as unknown as { m: number };
  const at = new Date().toISOString();
  const id = input.id ?? newAppRowId("pd_");
  db.prepare("UPDATE app_plan_drafts SET status = 'superseded', decided_at = ? WHERE project_id = ? AND status = 'draft'").run(at, input.projectId);
  db.prepare("INSERT INTO app_plan_drafts (id, project_id, run_id, revision, status, doc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.projectId, input.runId, max.m + 1, input.status ?? "draft", JSON.stringify(input.doc), at);
  return getPlanDraft(id)!;
}

export type PlanDecision = { kind: "approve" } | { kind: "decline"; reason: string };

/**
 * Approve or decline a draft (§4.15.2 POST /plans/:draftId/decision).
 * Stale revisions are refused with the route's 409 contract:
 * `{ error: "stale_revision", latest }` (§4.2.2 rule 3).
 */
export function decidePlanDraft(draftId: string, decision: PlanDecision): PlanDraft | { error: "stale_revision"; latest: number } | { error: string } | undefined {
  ensureAppBuilderSchema();
  const cur = getPlanDraft(draftId);
  if (!cur) return undefined;
  const latest = latestPlanDraft(cur.projectId);
  if (!latest || latest.id !== cur.id) {
    return { error: "stale_revision", latest: latest?.revision ?? cur.revision };
  }
  if (cur.status !== "draft") return { error: "already_decided" };
  const at = new Date().toISOString();
  if (decision.kind === "approve") {
    database().prepare("UPDATE app_plan_drafts SET status = 'approved', decided_at = ? WHERE id = ?").run(at, draftId);
  } else {
    database().prepare("UPDATE app_plan_drafts SET status = 'declined', decline_reason = ?, decided_at = ? WHERE id = ?")
      .run(decision.reason.slice(0, 1_000), at, draftId);
  }
  return getPlanDraft(draftId);
}

// ---------- app_assignments rows (MISSING §4.2.4 assignment lifecycle) ----------

interface AssignmentRow {
  id: string; project_id: string; plan_draft_id: string | null; plan_task_ids: string;
  role: string; brief: string; status: string; report: string | null;
  started_at: string | null; finished_at: string | null;
}

function toAssignment(r: AssignmentRow): AppTaskAssignment {
  return {
    id: r.id,
    projectId: r.project_id,
    planDraftId: r.plan_draft_id,
    planTaskIds: JSON.parse(r.plan_task_ids) as string[],
    role: r.role as AppTaskAssignment["role"],
    brief: r.brief,
    status: r.status as AssignmentStatus,
    report: r.report,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function insertAssignment(a: AppTaskAssignment): void {
  ensureAppBuilderSchema();
  database()
    .prepare(`INSERT INTO app_assignments (id, project_id, plan_draft_id, plan_task_ids, role, brief, status, report, started_at, finished_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(a.id, a.projectId, a.planDraftId, JSON.stringify(a.planTaskIds), a.role, a.brief, a.status,
         a.report, a.startedAt, a.finishedAt);
}

export function getAssignment(id: string): AppTaskAssignment | undefined {
  ensureAppBuilderSchema();
  const r = database().prepare("SELECT * FROM app_assignments WHERE id = ?").get(id) as unknown as AssignmentRow | undefined;
  return r ? toAssignment(r) : undefined;
}

export function listAssignments(projectId: string): AppTaskAssignment[] {
  ensureAppBuilderSchema();
  const rows = database().prepare("SELECT * FROM app_assignments WHERE project_id = ? ORDER BY rowid DESC").all(projectId) as unknown as AssignmentRow[];
  return rows.map(toAssignment);
}

/** Status/report patch; stamps started_at on `running` and finished_at on terminal states. */
export function updateAssignment(id: string, patch: { status?: AssignmentStatus; report?: string }): AppTaskAssignment | undefined {
  ensureAppBuilderSchema();
  const cur = getAssignment(id);
  if (!cur) return undefined;
  const next: AppTaskAssignment = { ...cur, ...patch };
  const at = new Date().toISOString();
  if (patch.status === "running" && !next.startedAt) next.startedAt = at;
  if (patch.status === "done" || patch.status === "failed" || patch.status === "cancelled") next.finishedAt = next.finishedAt ?? at;
  database()
    .prepare("UPDATE app_assignments SET status = ?, report = ?, started_at = ?, finished_at = ? WHERE id = ?")
    .run(next.status, next.report, next.startedAt, next.finishedAt, id);
  return next;
}
