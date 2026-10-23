/**
 * Pending-plan store + wait primitives (D4, Devin `suggest_plan`).
 *
 * Split out of `planApprovalGate.ts` so the gate classifier (and the tools
 * module) can be imported without pulling the server-side store into the
 * protocol/UI boundary.
 */
import crypto from "node:crypto";
import { getSettings } from "../server/settings.js";
import type {
  PlanApprovalDecision,
  PlanApprovalRecord,
  PlanApprovalStatus,
  SuggestPlanArgs,
} from "./planApprovalGate.js";

const TTL_MS = 30 * 60_000;
const MAX_PENDING_PLANS = 200;

const pendingPlans = new Map<string, PlanApprovalRecord>();
/** Per-task FIFO queue so a waiting tool resumes in creation order. */
const waiters = new Map<string, Array<(status: PlanApprovalStatus) => void>>();

function newId(): string {
  return `plan_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}

function resolveWaiters(record: PlanApprovalRecord): void {
  const queue = waiters.get(record.taskId);
  if (!queue) return;
  while (queue.length > 0) queue.shift()!(record.status);
  waiters.delete(record.taskId);
}

function expire(record: PlanApprovalRecord): boolean {
  if (record.status !== "pending") return false;
  if (Date.parse(record.createdAt) + TTL_MS >= Date.now()) return false;
  record.status = "expired";
  record.decidedAt = new Date().toISOString();
  resolveWaiters(record);
  return true;
}

function prune(): void {
  if (pendingPlans.size <= MAX_PENDING_PLANS) return;
  const cutoff = Date.now() - TTL_MS;
  for (const [id, rec] of pendingPlans) {
    if (rec.status !== "pending" && Date.parse(rec.decidedAt ?? rec.createdAt) < cutoff) pendingPlans.delete(id);
  }
}

/** Store a plan and return its record; the caller waits on `waitForPlanDecision`. */
export function createPlanApproval(input: { taskId: string; plan: SuggestPlanArgs }): PlanApprovalRecord {
  if (!input.taskId) throw new Error("taskId is required");
  const record: PlanApprovalRecord = {
    id: newId(),
    taskId: input.taskId,
    summary: input.plan.summary,
    steps: input.plan.steps,
    filesToEdit: input.plan.filesToEdit,
    trivial: input.plan.trivial,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  pendingPlans.set(record.id, record);
  prune();
  // Trivial-task bypass (D4): a single obvious action needs no approval card.
  if (input.plan.trivial && getSettings().planApprovalSkipTrivial === true) {
    record.status = "approved";
    record.decidedAt = new Date().toISOString();
    resolveWaiters(record);
  }
  return record;
}

export function getPlanApproval(id: string): PlanApprovalRecord | undefined {
  const record = pendingPlans.get(id);
  if (record) expire(record);
  return record;
}

export function listPlanApprovals(pendingOnly = true): PlanApprovalRecord[] {
  const rows = [...pendingPlans.values()];
  for (const record of rows) expire(record);
  return rows
    .filter((r) => (pendingOnly ? r.status === "pending" : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The pending plan awaiting a decision for a task, if any. */
export function pendingPlanForTask(taskId: string): PlanApprovalRecord | undefined {
  for (const record of listPlanApprovals(true)) {
    if (record.taskId === taskId) return record;
  }
  return undefined;
}

/** True when a plan for this task is waiting on the user. */
export function hasPendingPlan(taskId: string): boolean {
  return pendingPlanForTask(taskId) !== undefined;
}

/**
 * Apply a user decision. `edit` stores the revised plan so the agent can
 * re-present it, and the pending state clears either way.
 */
export function decidePlanApproval(id: string, decision: PlanApprovalDecision): PlanApprovalRecord | undefined {
  const record = pendingPlans.get(id);
  if (!record) return undefined;
  expire(record);
  if (record.status !== "pending") return record;
  if (decision.decision === "approve") {
    record.status = "approved";
  } else if (decision.decision === "edit") {
    record.status = "edited";
    record.editedPlan = {
      summary:
        typeof decision.plan?.summary === "string" && decision.plan.summary.trim()
          ? decision.plan.summary.trim()
          : record.summary,
      steps: Array.isArray(decision.plan?.steps)
        ? decision.plan.steps.filter((s): s is string => typeof s === "string")
        : record.steps,
      filesToEdit: Array.isArray(decision.plan?.filesToEdit)
        ? decision.plan.filesToEdit.filter((s): s is string => typeof s === "string")
        : Array.isArray(decision.plan?.files_to_edit)
          ? decision.plan.files_to_edit.filter((s): s is string => typeof s === "string")
        : record.filesToEdit,
      trivial: decision.plan?.trivial ?? record.trivial,
    };
  } else {
    record.status = "rejected";
  }
  record.decidedAt = new Date().toISOString();
  resolveWaiters(record);
  return record;
}

/**
 * Wait until the plan is decided, expires or the run is cancelled.
 *
 * Returns the final status. A rejected/edited/expired plan is the caller's
 * signal to stop mutating and return to planning.
 */
export async function waitForPlanDecision(
  id: string,
  signal: AbortSignal | undefined,
  timeoutMs = TTL_MS,
): Promise<PlanApprovalStatus> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) {
      const cancelled = pendingPlans.get(id);
      if (cancelled && cancelled.status === "pending") {
        cancelled.status = "rejected";
        cancelled.decidedAt = new Date().toISOString();
        pendingPlans.delete(id);
        resolveWaiters(cancelled);
      }
      return "rejected";
    }
    const record = pendingPlans.get(id);
    if (!record) return "rejected";
    expire(record);
    if (record.status !== "pending") return record.status;
    if (Date.now() >= until) {
      record.status = "expired";
      record.decidedAt = new Date().toISOString();
      resolveWaiters(record);
      return "expired";
    }
    await new Promise<void>((resolve) => {
      const waiter = () => resolve();
      const queue = waiters.get(record.taskId) ?? [];
      queue.push(waiter);
      waiters.set(record.taskId, queue);
      const timer = setTimeout(() => {
        const idx = queue.indexOf(waiter);
        if (idx >= 0) queue.splice(idx, 1);
        resolve();
      }, 250);
      // Avoid keeping the event loop alive for an idle wait.
      if (typeof timer.unref === "function") timer.unref();
    });
  }
}

/** Serialize a record for the wire (the card and the HTTP payload). */
export function serializePlanApproval(record: PlanApprovalRecord): Record<string, unknown> {
  return {
    id: record.id,
    taskId: record.taskId,
    summary: record.summary,
    steps: record.steps,
    filesToEdit: record.filesToEdit,
    trivial: record.trivial,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.decidedAt ? { decidedAt: record.decidedAt } : {}),
    ...(record.editedPlan ? { editedPlan: record.editedPlan } : {}),
  };
}
