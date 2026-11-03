/** C7: persistence for workflow definitions and runs (manus.db). */
import { database } from "../../server/sqliteStore.js";
import type { WorkflowDef, WorkflowRunState } from "./types.js";

export const WORKFLOW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflow_defs (
  workflow_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  source TEXT NOT NULL CHECK (source IN ('user', 'template', 'import')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  superstep INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_runs_task ON workflow_runs (task_id);
CREATE INDEX IF NOT EXISTS workflow_runs_status ON workflow_runs (status);
CREATE TABLE IF NOT EXISTS workflow_steps (
  run_id TEXT NOT NULL REFERENCES workflow_runs (run_id) ON DELETE CASCADE,
  superstep INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped', 'waiting')),
  output TEXT CHECK (output IS NULL OR json_valid(output)),
  error TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, superstep, node_id)
);
`;

let ready = false;
function db() {
  const d = database();
  if (!ready) {
    d.exec(WORKFLOW_SCHEMA_SQL);
    ready = true;
  }
  return d;
}
export function resetWorkflowSchemaFlag(): void {
  ready = false;
}

export function saveWorkflow(def: WorkflowDef, source: "user" | "template" | "import", now = Date.now()): void {
  db()
    .prepare(
      "INSERT INTO workflow_defs (workflow_id, title, definition, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (workflow_id) DO UPDATE SET title = excluded.title, definition = excluded.definition, updated_at = excluded.updated_at",
    )
    .run(def.id, def.title, JSON.stringify(def), source, now, now);
}

export function loadWorkflow(id: string): WorkflowDef | undefined {
  const r = db().prepare("SELECT definition FROM workflow_defs WHERE workflow_id = ?").get(id) as { definition: string } | undefined;
  return r ? (JSON.parse(r.definition) as WorkflowDef) : undefined;
}

export function listWorkflows(): Array<{ id: string; title: string; source: string; updatedAt: number }> {
  return (db().prepare("SELECT workflow_id, title, source, updated_at FROM workflow_defs ORDER BY updated_at DESC").all() as Array<{ workflow_id: string; title: string; source: string; updated_at: number }>).map(
    (r) => ({ id: r.workflow_id, title: r.title, source: r.source, updatedAt: r.updated_at }),
  );
}

export function deleteWorkflow(id: string): boolean {
  return Number(db().prepare("DELETE FROM workflow_defs WHERE workflow_id = ?").run(id).changes) === 1;
}

/** Checkpoint of one run, written after every superstep. */
export function saveRun(run: WorkflowRunState, now = Date.now()): void {
  db()
    .prepare(
      "INSERT INTO workflow_runs (run_id, workflow_id, task_id, status, snapshot, superstep, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (run_id) DO UPDATE SET status = excluded.status, snapshot = excluded.snapshot, superstep = excluded.superstep, updated_at = excluded.updated_at",
    )
    .run(run.runId, run.workflowId, run.taskId, run.status, JSON.stringify(run), run.superstep, now, now);
}

export function loadRun(runId: string): WorkflowRunState | undefined {
  const r = db().prepare("SELECT snapshot FROM workflow_runs WHERE run_id = ?").get(runId) as { snapshot: string } | undefined;
  return r ? (JSON.parse(r.snapshot) as WorkflowRunState) : undefined;
}

export function recordStep(s: { runId: string; superstep: number; nodeId: string; status: "succeeded" | "failed" | "skipped" | "waiting"; output?: unknown; error?: string; startedAt: number; endedAt: number }): void {
  db()
    .prepare("INSERT OR REPLACE INTO workflow_steps (run_id, superstep, node_id, status, output, error, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(s.runId, s.superstep, s.nodeId, s.status, s.output === undefined ? null : JSON.stringify(s.output), s.error ?? null, s.startedAt, s.endedAt);
}

export function stepsOf(runId: string): Array<{ superstep: number; nodeId: string; status: string; error: string | null }> {
  return (db().prepare("SELECT superstep, node_id, status, error FROM workflow_steps WHERE run_id = ? ORDER BY superstep, node_id").all(runId) as Array<{ superstep: number; node_id: string; status: string; error: string | null }>).map((r) => ({
    superstep: r.superstep,
    nodeId: r.node_id,
    status: r.status,
    error: r.error,
  }));
}
