/**
 * C2: one durable interrupt primitive. Re-bases ask_user, suggest_plan,
 * tool approvals, ACP permission requests, stalled-replan re-approval and
 * workflow human nodes on a single SQLite table.
 *
 * OBSERVED gap: tools/askUserStore.ts, tools/planApprovalStore.ts and
 * server/approvals.ts keep pending gates in process memory (Map + waiters,
 * TTL 30 min / plan store / 15 min); a restart loses every pending card.
 * Here the record survives restarts; the waiter is the only in-memory part.
 */
import { database } from "../../server/sqliteStore.js";
import { validate, type JsonSchema, type SchemaIssue } from "../contracts/schema.js";
import { newId } from "./ids.js";

export type InterruptKind = "ask_user" | "plan_approval" | "tool_approval" | "acp_permission" | "stalled_replan" | "workflow_human" | "custom";
export type InterruptStatus = "pending" | "resolved" | "dismissed" | "expired" | "cancelled";
export type ResolvedBy = "user" | "auto" | "policy" | "timeout";

export interface InterruptRecord<P = unknown, R = unknown> {
  interruptId: string;
  taskId: string;
  kind: InterruptKind;
  status: InterruptStatus;
  payload: P;
  responseSchema: JsonSchema;
  response: R | null;
  resolvedBy: ResolvedBy | null;
  checkpointId: string | null;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
}

export const INTERRUPT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_interrupts (
  interrupt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ask_user', 'plan_approval', 'tool_approval', 'acp_permission', 'stalled_replan', 'workflow_human', 'custom')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'dismissed', 'expired', 'cancelled')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  response_schema TEXT NOT NULL CHECK (json_valid(response_schema)),
  response TEXT CHECK (response IS NULL OR json_valid(response)),
  resolved_by TEXT CHECK (resolved_by IS NULL OR resolved_by IN ('user', 'auto', 'policy', 'timeout')),
  checkpoint_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS run_interrupts_task ON run_interrupts (task_id, status);
CREATE INDEX IF NOT EXISTS run_interrupts_expiry ON run_interrupts (status, expires_at);
`;

let ready = false;
function db() {
  const d = database();
  if (!ready) {
    d.exec(INTERRUPT_SCHEMA_SQL);
    ready = true;
  }
  return d;
}
export function resetInterruptSchemaFlag(): void {
  ready = false;
  for (const w of waiters.values()) w.forEach((fn) => fn(undefined));
  waiters.clear();
}

interface Raw {
  interrupt_id: string;
  task_id: string;
  kind: InterruptKind;
  status: InterruptStatus;
  payload: string;
  response_schema: string;
  response: string | null;
  resolved_by: ResolvedBy | null;
  checkpoint_id: string | null;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
}
const toRecord = <P, R>(r: Raw): InterruptRecord<P, R> => ({
  interruptId: r.interrupt_id,
  taskId: r.task_id,
  kind: r.kind,
  status: r.status,
  payload: JSON.parse(r.payload) as P,
  responseSchema: JSON.parse(r.response_schema) as JsonSchema,
  response: r.response === null ? null : (JSON.parse(r.response) as R),
  resolvedBy: r.resolved_by,
  checkpointId: r.checkpoint_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  resolvedAt: r.resolved_at,
});

type Waiter = (rec: InterruptRecord | undefined) => void;
const waiters = new Map<string, Waiter[]>();
const listeners = new Set<(rec: InterruptRecord) => void>();

/** The protocol layer subscribes here to push interruptRequested/interruptResolved. */
export function onInterruptChange(fn: (rec: InterruptRecord) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(rec: InterruptRecord): void {
  for (const fn of listeners) {
    try {
      fn(rec);
    } catch {
      /* a listener must never break a gate */
    }
  }
  if (rec.status !== "pending") {
    const ws = waiters.get(rec.interruptId) ?? [];
    waiters.delete(rec.interruptId);
    ws.forEach((w) => w(rec));
  }
}

export class InterruptLimitError extends Error {
  constructor(taskId: string, max: number) {
    super(`interrupt_limit: task ${taskId} already has ${max} pending interrupts`);
    this.name = "InterruptLimitError";
  }
}

export function createInterrupt<P>(input: {
  taskId: string;
  kind: InterruptKind;
  payload: P;
  responseSchema: JsonSchema;
  ttlMs: number;
  maxPendingPerTask: number;
  checkpointId?: string;
  /** Reuse an id an existing store already issued (keeps routes and cards stable). */
  interruptId?: string;
  now?: number;
}): InterruptRecord<P, unknown> {
  const d = db();
  const now = input.now ?? Date.now();
  const pending = d.prepare("SELECT COUNT(*) AS n FROM run_interrupts WHERE task_id = ? AND status = 'pending'").get(input.taskId) as { n: number };
  if (pending.n >= input.maxPendingPerTask) throw new InterruptLimitError(input.taskId, input.maxPendingPerTask);
  const id = input.interruptId ?? newId("int", now);
  d.prepare(
    "INSERT INTO run_interrupts (interrupt_id, task_id, kind, status, payload, response_schema, checkpoint_id, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
  ).run(id, input.taskId, input.kind, JSON.stringify(input.payload), JSON.stringify(input.responseSchema), input.checkpointId ?? null, now, now + input.ttlMs);
  const rec = getInterrupt<P, unknown>(id) as InterruptRecord<P, unknown>;
  notify(rec);
  return rec;
}

export function getInterrupt<P = unknown, R = unknown>(id: string): InterruptRecord<P, R> | undefined {
  const r = db().prepare("SELECT * FROM run_interrupts WHERE interrupt_id = ?").get(id) as Raw | undefined;
  return r ? toRecord<P, R>(r) : undefined;
}

export function pendingInterrupts(taskId?: string): InterruptRecord[] {
  const rows = (taskId
    ? db().prepare("SELECT * FROM run_interrupts WHERE status = 'pending' AND task_id = ? ORDER BY created_at").all(taskId)
    : db().prepare("SELECT * FROM run_interrupts WHERE status = 'pending' ORDER BY created_at").all()) as unknown as Raw[];
  return rows.map((r) => toRecord(r));
}

export type ResolveResult<R> =
  | { ok: true; record: InterruptRecord<unknown, R>; hadLiveWaiter: boolean }
  | { ok: false; error: "not_found" | "not_pending" | "invalid_response"; issues?: SchemaIssue[] };

function settle(id: string, status: Exclude<InterruptStatus, "pending">, response: unknown, by: ResolvedBy, now: number): boolean {
  const changes = db()
    .prepare("UPDATE run_interrupts SET status = ?, response = ?, resolved_by = ?, resolved_at = ? WHERE interrupt_id = ? AND status = 'pending'")
    .run(status, response === undefined ? null : JSON.stringify(response), by, now, id).changes;
  return Number(changes) === 1;
}

/** Validates the response against the stored schema, then settles exactly once. */
export function resolveInterrupt<R>(id: string, response: R, by: ResolvedBy = "user", now = Date.now()): ResolveResult<R> {
  const rec = getInterrupt(id);
  if (!rec) return { ok: false, error: "not_found" };
  if (rec.status !== "pending") return { ok: false, error: "not_pending" };
  const issues = validate(rec.responseSchema, response);
  if (issues.length) return { ok: false, error: "invalid_response", issues };
  const hadLiveWaiter = (waiters.get(id)?.length ?? 0) > 0;
  if (!settle(id, "resolved", response, by, now)) return { ok: false, error: "not_pending" };
  const done = getInterrupt<unknown, R>(id) as InterruptRecord<unknown, R>;
  notify(done);
  return { ok: true, record: done, hadLiveWaiter };
}

export function dismissInterrupt(id: string, by: ResolvedBy = "user", now = Date.now()): boolean {
  if (!settle(id, "dismissed", undefined, by, now)) return false;
  notify(getInterrupt(id) as InterruptRecord);
  return true;
}

/** Run cancelled or finished: no gate of that task may stay pending. */
export function cancelInterruptsForTask(taskId: string, now = Date.now()): number {
  const ids = (db().prepare("SELECT interrupt_id FROM run_interrupts WHERE task_id = ? AND status = 'pending'").all(taskId) as Array<{ interrupt_id: string }>).map((r) => r.interrupt_id);
  let n = 0;
  for (const id of ids) {
    if (settle(id, "cancelled", undefined, "policy", now)) {
      n++;
      notify(getInterrupt(id) as InterruptRecord);
    }
  }
  return n;
}

/** Called every 30 s by the existing server housekeeping interval, and once at boot. */
export function expireDue(now = Date.now()): number {
  const ids = (db().prepare("SELECT interrupt_id FROM run_interrupts WHERE status = 'pending' AND expires_at <= ?").all(now) as Array<{ interrupt_id: string }>).map((r) => r.interrupt_id);
  let n = 0;
  for (const id of ids) {
    if (settle(id, "expired", undefined, "timeout", now)) {
      n++;
      notify(getInterrupt(id) as InterruptRecord);
    }
  }
  return n;
}

/**
 * Waits until the interrupt leaves "pending". Resolves with the final record,
 * or undefined when aborted. A record already settled resolves immediately.
 */
export function waitForInterrupt<R = unknown>(id: string, signal?: AbortSignal): Promise<InterruptRecord<unknown, R> | undefined> {
  const now = getInterrupt<unknown, R>(id);
  if (!now) return Promise.resolve(undefined);
  if (now.status !== "pending") return Promise.resolve(now);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      expireDue(Date.now());
    }, Math.max(0, now.expiresAt - Date.now()) + 5);
    const w: Waiter = (rec) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(rec as InterruptRecord<unknown, R> | undefined);
    };
    const onAbort = () => {
      const list = waiters.get(id)?.filter((x) => x !== w) ?? [];
      if (list.length) waiters.set(id, list);
      else waiters.delete(id);
      clearTimeout(timer);
      resolve(undefined);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    waiters.set(id, [...(waiters.get(id) ?? []), w]);
  });
}

/**
 * Response contracts for the built-in kinds. Shapes match the existing Loam
 * types exactly: AskUserAnswer (tools/askUserStore.ts),
 * PlanApprovalDecision (tools/planApprovalGate.ts) and the
 * decideApproval decision (server/approvals.ts).
 */
export const RESPONSE_SCHEMAS: Record<Exclude<InterruptKind, "custom" | "workflow_human">, JsonSchema> = {
  ask_user: {
    type: "object",
    required: ["text", "answers", "files"],
    additionalProperties: false,
    properties: {
      text: { type: "string", maxLength: 20_000 },
      /** Record<questionId, answer>; values are checked by askUserGate's own parser. */
      answers: { type: "object" },
      files: { type: "array", maxItems: 10, items: { type: "object" } },
    },
  },
  plan_approval: {
    type: "object",
    required: ["decision"],
    additionalProperties: false,
    properties: {
      decision: { enum: ["approve", "reject", "edit"] },
      plan: {
        type: "object",
        properties: {
          summary: { type: "string", maxLength: 4000 },
          steps: { type: "array", maxItems: 30, items: { type: "string", maxLength: 2000 } },
          filesToEdit: { type: "array", maxItems: 200, items: { type: "string", maxLength: 1000 } },
          files_to_edit: { type: "array", maxItems: 200, items: { type: "string", maxLength: 1000 } },
          trivial: { type: "boolean" },
        },
      },
    },
  },
  tool_approval: {
    type: "object",
    required: ["decision"],
    additionalProperties: false,
    properties: { decision: { enum: ["approve", "deny"] } },
  },
  acp_permission: {
    type: "object",
    required: ["optionId"],
    additionalProperties: false,
    properties: { optionId: { type: "string", minLength: 1, maxLength: 200 } },
  },
  stalled_replan: {
    type: "object",
    required: ["decision"],
    additionalProperties: false,
    properties: { decision: { enum: ["continue", "stop", "edit"] }, guidance: { type: "string", maxLength: 4000 } },
  },
};
