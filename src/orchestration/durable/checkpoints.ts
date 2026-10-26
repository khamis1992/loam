/**
 * C2: checkpoint history, branches and forks.
 *
 * OBSERVED: every ExecutionCheckpoint is already appended to session_events
 * (kind "checkpoint", agent/checkpointLog.ts:86) but only the newest is ever
 * read (readLatestCheckpoint); there are no parent links, no listing and
 * no fork. This module adds an index table over those rows. Payloads are not
 * copied: the event log stays the single store of checkpoint bodies.
 */
import { database, transaction } from "../../server/sqliteStore.js";
import { newId } from "./ids.js";

export type CheckpointSource = "loop" | "interrupt" | "fork" | "final";

export interface CheckpointRef {
  checkpointId: string;
  taskId: string;
  sessionId: string;
  logSeq: number;
  parentCheckpointId: string | null;
  branchId: string;
  round: number;
  nextStep: number;
  completedSteps: number;
  label: string | null;
  source: CheckpointSource;
  createdAt: number;
}

/** Fields of ExecutionCheckpoint (agent/checkpoint.ts) the index needs. */
export interface CheckpointShape {
  round: number;
  nextStep: number;
  completed: unknown[];
  complete?: boolean;
}

/** Reads one event-log row body. Loam: (s, seq) => after(s, seq - 1, 1)[0]?.payload. */
export type CheckpointPayloadReader = (sessionId: string, seq: number) => unknown;

export const CHECKPOINT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  log_seq INTEGER NOT NULL,
  parent_checkpoint_id TEXT REFERENCES run_checkpoints (checkpoint_id) ON DELETE SET NULL,
  branch_id TEXT NOT NULL DEFAULT 'main',
  round INTEGER NOT NULL,
  next_step INTEGER NOT NULL,
  completed_steps INTEGER NOT NULL,
  label TEXT,
  source TEXT NOT NULL CHECK (source IN ('loop', 'interrupt', 'fork', 'final')),
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, log_seq)
);
CREATE INDEX IF NOT EXISTS run_checkpoints_task ON run_checkpoints (task_id, created_at);
CREATE TABLE IF NOT EXISTS run_forks (
  fork_task_id TEXT PRIMARY KEY,
  source_task_id TEXT NOT NULL,
  from_checkpoint_id TEXT NOT NULL REFERENCES run_checkpoints (checkpoint_id),
  note TEXT,
  created_at INTEGER NOT NULL
);
`;

let ready = false;
function db() {
  const d = database();
  if (!ready) {
    d.exec(CHECKPOINT_SCHEMA_SQL);
    ready = true;
  }
  return d;
}
export function resetCheckpointSchemaFlag(): void {
  ready = false;
}

interface Raw {
  checkpoint_id: string;
  task_id: string;
  session_id: string;
  log_seq: number;
  parent_checkpoint_id: string | null;
  branch_id: string;
  round: number;
  next_step: number;
  completed_steps: number;
  label: string | null;
  source: CheckpointSource;
  created_at: number;
}
const toRef = (r: Raw): CheckpointRef => ({
  checkpointId: r.checkpoint_id,
  taskId: r.task_id,
  sessionId: r.session_id,
  logSeq: r.log_seq,
  parentCheckpointId: r.parent_checkpoint_id,
  branchId: r.branch_id,
  round: r.round,
  nextStep: r.next_step,
  completedSteps: r.completed_steps,
  label: r.label,
  source: r.source,
  createdAt: r.created_at,
});

/**
 * Called right after writeCheckpoint() returned `logSeq`. Idempotent: the
 * event log dedups checkpoints by key, so the same seq may come back twice.
 */
export function indexCheckpoint(input: {
  taskId: string;
  sessionId: string;
  logSeq: number;
  cp: CheckpointShape;
  branchId?: string;
  source?: CheckpointSource;
  label?: string;
  keep: number;
  now?: number;
}): CheckpointRef {
  return transaction(() => {
    const d = db();
    const existing = d.prepare("SELECT * FROM run_checkpoints WHERE session_id = ? AND log_seq = ?").get(input.sessionId, input.logSeq) as Raw | undefined;
    if (existing) return toRef(existing);
    const branchId = input.branchId ?? "main";
    const parent = d
      .prepare("SELECT checkpoint_id FROM run_checkpoints WHERE task_id = ? AND branch_id = ? ORDER BY log_seq DESC LIMIT 1")
      .get(input.taskId, branchId) as { checkpoint_id: string } | undefined;
    const ref: CheckpointRef = {
      checkpointId: newId("ck"),
      taskId: input.taskId,
      sessionId: input.sessionId,
      logSeq: input.logSeq,
      parentCheckpointId: parent?.checkpoint_id ?? null,
      branchId,
      round: input.cp.round,
      nextStep: input.cp.nextStep,
      completedSteps: input.cp.completed.length,
      label: input.label ?? null,
      source: input.source ?? (input.cp.complete ? "final" : "loop"),
      createdAt: input.now ?? Date.now(),
    };
    d.prepare(
      "INSERT INTO run_checkpoints (checkpoint_id, task_id, session_id, log_seq, parent_checkpoint_id, branch_id, round, next_step, completed_steps, label, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(ref.checkpointId, ref.taskId, ref.sessionId, ref.logSeq, ref.parentCheckpointId, ref.branchId, ref.round, ref.nextStep, ref.completedSteps, ref.label, ref.source, ref.createdAt);
    // Retention: keep the newest `keep` loop checkpoints per task; interrupt,
    // fork and final checkpoints, and any checkpoint a fork points at, are kept.
    d.prepare(
      `DELETE FROM run_checkpoints WHERE task_id = ? AND source = 'loop'
         AND checkpoint_id NOT IN (SELECT from_checkpoint_id FROM run_forks)
         AND checkpoint_id NOT IN (
           SELECT checkpoint_id FROM run_checkpoints WHERE task_id = ? AND source = 'loop' ORDER BY log_seq DESC LIMIT ?)`,
    ).run(ref.taskId, ref.taskId, input.keep);
    return ref;
  });
}

export function listCheckpoints(taskId: string, limit = 200): CheckpointRef[] {
  const rows = db().prepare("SELECT * FROM run_checkpoints WHERE task_id = ? ORDER BY log_seq DESC LIMIT ?").all(taskId, Math.min(limit, 2000)) as unknown as Raw[];
  return rows.map(toRef);
}

export function getCheckpointRef(checkpointId: string): CheckpointRef | undefined {
  const r = db().prepare("SELECT * FROM run_checkpoints WHERE checkpoint_id = ?").get(checkpointId) as Raw | undefined;
  return r ? toRef(r) : undefined;
}

/** Root-to-leaf ancestry of a checkpoint (oldest first), max 2000 hops. */
export function lineage(checkpointId: string): CheckpointRef[] {
  const out: CheckpointRef[] = [];
  let cur = getCheckpointRef(checkpointId);
  while (cur && out.length < 2000) {
    out.unshift(cur);
    cur = cur.parentCheckpointId ? getCheckpointRef(cur.parentCheckpointId) : undefined;
  }
  return out;
}

export interface ForkPlan<C> {
  forkTaskId: string;
  from: CheckpointRef;
  /** The historic checkpoint body, detached from its log position. */
  checkpoint: C;
}

/**
 * Prepares a fork: the caller starts a new task with `resume: plan.checkpoint`
 * (the same path index.ts already uses for crash resume). `edit` lets the
 * user change the checkpoint before resuming (e.g. rewrite a plan step).
 */
export function planFork<C extends { logSeq?: number; logSessionId?: string; complete?: boolean }>(
  checkpointId: string,
  read: CheckpointPayloadReader,
  opts: { note?: string; edit?: (cp: C) => C; now?: number } = {},
): ForkPlan<C> {
  const from = getCheckpointRef(checkpointId);
  if (!from) throw new Error(`checkpoint_not_found: ${checkpointId}`);
  const body = read(from.sessionId, from.logSeq);
  if (!body || typeof body !== "object") throw new Error(`checkpoint_body_missing: ${checkpointId}`);
  const copy = structuredClone(body) as C;
  delete copy.logSeq;
  delete copy.logSessionId;
  copy.complete = false;
  const checkpoint = opts.edit ? opts.edit(copy) : copy;
  const forkTaskId = newId("task_fork", opts.now);
  db()
    .prepare("INSERT INTO run_forks (fork_task_id, source_task_id, from_checkpoint_id, note, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(forkTaskId, from.taskId, from.checkpointId, opts.note?.slice(0, 500) ?? null, opts.now ?? Date.now());
  return { forkTaskId, from, checkpoint };
}

export function forksOf(taskId: string): Array<{ forkTaskId: string; fromCheckpointId: string; note: string | null; createdAt: number }> {
  const rows = db().prepare("SELECT * FROM run_forks WHERE source_task_id = ? ORDER BY created_at").all(taskId) as unknown as Array<{
    fork_task_id: string;
    from_checkpoint_id: string;
    note: string | null;
    created_at: number;
  }>;
  return rows.map((r) => ({ forkTaskId: r.fork_task_id, fromCheckpointId: r.from_checkpoint_id, note: r.note, createdAt: r.created_at }));
}
