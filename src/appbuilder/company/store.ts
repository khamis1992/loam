import { database } from "../../server/sqliteStore.js";
import { ensureAppBuilderSchema } from "../store.js";
import type { AppVersion } from "../types.js";
import type { CompanyRun } from "./types.js";

interface RunRow {
  id: string; project_id: string; idea: string; stage: string; brief: string;
  verify_report_id: string | null; version_number: number | null; preview_url: string | null;
  error: string | null; created_at: string; updated_at: string;
}

function toRun(row: RunRow): CompanyRun {
  return {
    id: row.id, projectId: row.project_id, idea: row.idea, stage: row.stage as CompanyRun["stage"],
    brief: JSON.parse(row.brief) as CompanyRun["brief"], verifyReportId: row.verify_report_id,
    versionNumber: row.version_number, previewUrl: row.preview_url, error: row.error,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function ensureCompanySchema(): void {
  ensureAppBuilderSchema();
  database().exec(`CREATE TABLE IF NOT EXISTS app_company_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,
    idea TEXT NOT NULL,
    stage TEXT NOT NULL,
    brief TEXT NOT NULL,
    verify_report_id TEXT,
    version_number INTEGER,
    preview_url TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS app_company_runs_project ON app_company_runs(project_id, updated_at DESC);`);
  try { database().exec("ALTER TABLE app_versions ADD COLUMN db_snapshot TEXT"); } catch (error) {
    if (!(error instanceof Error && error.message.includes("duplicate column name"))) throw error;
  }
}

export function insertCompanyRun(run: CompanyRun): void {
  ensureCompanySchema();
  database().prepare("INSERT INTO app_company_runs (id, project_id, idea, stage, brief, verify_report_id, version_number, preview_url, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(run.id, run.projectId, run.idea, run.stage, JSON.stringify(run.brief), run.verifyReportId, run.versionNumber, run.previewUrl, run.error, run.createdAt, run.updatedAt);
}

export function getCompanyRun(id: string): CompanyRun | undefined {
  ensureCompanySchema();
  const row = database().prepare("SELECT * FROM app_company_runs WHERE id = ?").get(id) as unknown as RunRow | undefined;
  return row ? toRun(row) : undefined;
}

export function listCompanyRuns(projectId: string): CompanyRun[] {
  ensureCompanySchema();
  const rows = database().prepare("SELECT * FROM app_company_runs WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as unknown as RunRow[];
  return rows.map(toRun);
}

export function updateCompanyRun(id: string, patch: Partial<Pick<CompanyRun, "stage" | "verifyReportId" | "versionNumber" | "previewUrl" | "error">>): CompanyRun {
  const current = getCompanyRun(id);
  if (!current) throw new Error("company run not found");
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  database().prepare("UPDATE app_company_runs SET stage = ?, verify_report_id = ?, version_number = ?, preview_url = ?, error = ?, updated_at = ? WHERE id = ?")
    .run(next.stage, next.verifyReportId, next.versionNumber, next.previewUrl, next.error, next.updatedAt, id);
  return next;
}

export const versionRows = {
  insertVersion(v: AppVersion & { dbSnapshot: string | null }): void {
    database().prepare("INSERT INTO app_versions (project_id, number, title, summary, \"commit\", parent_number, source, files_changed, verify_report_id, usage, added_packages, created_at, db_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(v.projectId, v.number, v.title, v.summary, v.commit, v.parentNumber, v.source, JSON.stringify(v.filesChanged), v.verifyReportId, JSON.stringify(v.usage), JSON.stringify(v.addedPackages), v.createdAt, v.dbSnapshot);
    database().prepare("UPDATE app_projects SET active_version = ?, updated_at = ? WHERE id = ?").run(v.number, new Date().toISOString(), v.projectId);
  },
  latestVersion(projectId: string): (AppVersion & { dbSnapshot: string | null }) | null {
    const row = database().prepare("SELECT * FROM app_versions WHERE project_id = ? ORDER BY number DESC LIMIT 1").get(projectId) as unknown as Record<string, unknown> | undefined;
    return row ? toVersion(row) : null;
  },
  getVersion(projectId: string, n: number): (AppVersion & { dbSnapshot: string | null }) | null {
    const row = database().prepare("SELECT * FROM app_versions WHERE project_id = ? AND number = ?").get(projectId, n) as unknown as Record<string, unknown> | undefined;
    return row ? toVersion(row) : null;
  },
  clearDbSnapshot(projectId: string, n: number): void {
    database().prepare("UPDATE app_versions SET db_snapshot = NULL WHERE project_id = ? AND number = ?").run(projectId, n);
  },
};

function toVersion(row: Record<string, unknown>): AppVersion & { dbSnapshot: string | null } {
  return {
    projectId: String(row.project_id), number: Number(row.number), title: String(row.title), summary: String(row.summary),
    commit: String(row.commit), parentNumber: row.parent_number === null ? null : Number(row.parent_number),
    source: row.source as AppVersion["source"], filesChanged: JSON.parse(String(row.files_changed)) as AppVersion["filesChanged"],
    verifyReportId: row.verify_report_id === null ? null : String(row.verify_report_id), usage: JSON.parse(String(row.usage)) as AppVersion["usage"],
    addedPackages: JSON.parse(String(row.added_packages)) as AppVersion["addedPackages"], createdAt: String(row.created_at),
    dbSnapshot: row.db_snapshot === null || row.db_snapshot === undefined ? null : String(row.db_snapshot),
  };
}
