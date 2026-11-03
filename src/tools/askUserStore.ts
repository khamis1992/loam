/**
 * Neo N9: the "Ask User More" request store.
 *
 * An ask-user request is a structured clarification that pauses a run: one or
 * more questions (each with optional preset options), an optional free-text
 * answer and an optional uploaded file. The `ask_user` tool creates a record,
 * emits a `ask_user_required` event (rendered by the web client as an ask-user
 * card) and blocks until the user answers, dismisses or lets the request expire.
 *
 * The store is deliberately split from the gate classifier (`askUserGate.ts`) so
 * the classifier can be imported at the protocol/UI boundary without pulling the
 * server-side store in. Only the primitives that can block live here, so the
 * classifier is a pure function of those primitives.
 *
 * Files are uploaded to `<workspace>/uploads/<requestId>/<name>` by the web
 * client through `/api/upload`; the answer records the workspace-relative path,
 * which the resumed run attaches to its context as an attachment.
 */
import crypto from "node:crypto";
import path from "node:path";

/** How long a request waits for the user before it expires. */
export const ASK_USER_TTL_MS = 30 * 60_000;

/** Hard ceiling so a runaway mission cannot exhaust memory. */
export const MAX_PENDING_ASKS = 200;

/** One question of an ask-user request. */
export interface AskUserQuestion {
  /** Stable key the answer is stored under (`q1`, `q2`, ...). */
  id: string;
  /** The question shown to the user. */
  prompt: string;
  /** Optional preset answers the user can pick with one click. */
  options?: string[];
  /** True when the user may upload a file for this question. */
  allowFile?: boolean;
}

/** A file the user attached to a request. */
export interface AskUserFile {
  /** Workspace-relative path inside `<workspace>/uploads/<requestId>/`. */
  path: string;
  name: string;
  bytes: number;
  contentType: string;
}

export type AskUserStatus = "pending" | "answered" | "dismissed" | "expired";

export interface AskUserAnswer {
  /** Free-text answer to the whole request. */
  text: string;
  /** Answers keyed by question id. */
  answers: Record<string, string>;
  /** Files the user attached, in the order they were added. */
  files: AskUserFile[];
}

export interface AskUserRecord {
  id: string;
  taskId: string;
  /** Short headline shown on the card ("Before I build this…"). */
  title: string;
  /** Why the agent is asking (auto-trigger reason or the model's own text). */
  reason: string;
  questions: AskUserQuestion[];
  status: AskUserStatus;
  createdAt: string;
  decidedAt?: string;
  /** The user's answer once the request is answered. */
  answer?: AskUserAnswer;
  /**
   * Who raised the request. "auto" is the orchestrator's vague/missing-context
   * trigger, whose headline and reason are localized by the client from
   * `reasonCode`; "model" is a `ask_user` call, whose title/reason the model
   * already wrote in the user's language and must be shown verbatim.
   */
  source?: AskUserSource;
  /** Machine-readable trigger reason, present only for `source: "auto"`. */
  reasonCode?: AskUserReasonCode;
}

export type AskUserSource = "auto" | "model";

/** Why the auto-trigger fired; the client maps it to a localized explanation. */
export type AskUserReasonCode = "vague" | "missing_context" | "ambiguous_target";

/** The upload directory of one request, relative to the task workspace. */
export function askUserUploadDir(requestId: string): string {
  return path.posix.join("uploads", requestId);
}

import { persistGate, settleGate, gatesToRehydrate } from "../orchestration/durable/gateBridge.js";
const pending = new Map<string, AskUserRecord>();
/** Per-task FIFO queue so a waiting tool resumes in creation order. */
const waiters = new Map<string, Array<(status: AskUserStatus) => void>>();

function newId(): string {
  return `ask_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}

function resolveWaiters(record: AskUserRecord): void {
  const queue = waiters.get(record.taskId);
  if (!queue) return;
  while (queue.length > 0) queue.shift()!(record.status);
  waiters.delete(record.taskId);
}

function expire(record: AskUserRecord): boolean {
  if (record.status !== "pending") return false;
  if (Date.parse(record.createdAt) + ASK_USER_TTL_MS >= Date.now()) return false;
  record.status = "expired";
  record.decidedAt = new Date().toISOString();
  resolveWaiters(record);
  return true;
}

function prune(): void {
  if (pending.size <= MAX_PENDING_ASKS) return;
  const cutoff = Date.now() - ASK_USER_TTL_MS;
  for (const [id, rec] of pending) {
    if (rec.status !== "pending" && Date.parse(rec.decidedAt ?? rec.createdAt) < cutoff) pending.delete(id);
  }
}

/** Create a request and return its record; the caller waits on `waitForAskUser`. */
export function createAskUser(input: {
  taskId: string;
  title: string;
  reason?: string;
  questions: AskUserQuestion[];
  source?: AskUserSource;
  reasonCode?: AskUserReasonCode;
}): AskUserRecord {
  if (!input.taskId) throw new Error("taskId is required");
  const record: AskUserRecord = {
    id: newId(),
    taskId: input.taskId,
    title: input.title,
    reason: input.reason ?? "",
    questions: input.questions,
    status: "pending",
    createdAt: new Date().toISOString(),
    source: input.source ?? "model",
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
  };
  pending.set(record.id, record);
  try { persistGate("ask_user", record.id, record.taskId, record, ASK_USER_TTL_MS); } catch { /* best effort */ }
  prune();
  return record;
}

export function getAskUser(id: string): AskUserRecord | undefined {
  const record = pending.get(id);
  if (record) expire(record);
  return record;
}

export function listAskUsers(pendingOnly = true): AskUserRecord[] {
  const rows = [...pending.values()];
  for (const record of rows) expire(record);
  return rows
    .filter((r) => (pendingOnly ? r.status === "pending" : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The pending request awaiting an answer for a task, if any. */
export function pendingAskForTask(taskId: string): AskUserRecord | undefined {
  for (const record of listAskUsers(true)) {
    if (record.taskId === taskId) return record;
  }
  return undefined;
}

/** True when this task has a request waiting on the user. */
export function hasPendingAsk(taskId: string): boolean {
  return pendingAskForTask(taskId) !== undefined;
}

/** Apply a user answer. The request leaves the pending state either way. */
export function answerAskUser(id: string, answer: AskUserAnswer): AskUserRecord | undefined {
  const record = pending.get(id);
  if (!record) return undefined;
  expire(record);
  if (record.status !== "pending") return record;
  record.status = "answered";
  record.answer = answer;
  record.decidedAt = new Date().toISOString();
  try { settleGate(id, answer); } catch { /* best effort */ }
  resolveWaiters(record);
  return record;
}

/** Dismiss a request without answering (the user closed the card). */
export function dismissAskUser(id: string): AskUserRecord | undefined {
  const record = pending.get(id);
  if (!record) return undefined;
  expire(record);
  if (record.status !== "pending") return record;
  record.status = "dismissed";
  record.decidedAt = new Date().toISOString();
  try { settleGate(id, undefined); } catch { /* best effort */ }
  resolveWaiters(record);
  return record;
}

/**
 * Wait until the request is answered, dismissed, expires or the run is
 * cancelled. Returns the final status; the caller reads the answer from
 * `getAskUser(id)`.
 */
export async function waitForAskUser(id: string, signal: AbortSignal | undefined, timeoutMs = ASK_USER_TTL_MS): Promise<AskUserStatus> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) {
      const cancelled = pending.get(id);
      if (cancelled && cancelled.status === "pending") {
        cancelled.status = "dismissed";
        cancelled.decidedAt = new Date().toISOString();
        pending.delete(id);
        resolveWaiters(cancelled);
      }
      return "dismissed";
    }
    const record = pending.get(id);
    if (!record) return "dismissed";
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
export function serializeAskUser(record: AskUserRecord): Record<string, unknown> {
  return {
    id: record.id,
    taskId: record.taskId,
    title: record.title,
    reason: record.reason,
    questions: record.questions,
    status: record.status,
    createdAt: record.createdAt,
    source: record.source ?? "model",
    ...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
    ...(record.decidedAt ? { decidedAt: record.decidedAt } : {}),
    ...(record.answer ? { answer: record.answer } : {}),
  };
}

// C2: re-create cards pending before a restart so routes and the UI keep working.
export function rehydrateAskUsers(): void {
  for (const g of gatesToRehydrate("ask_user")) {
    const r = g.payload as AskUserRecord;
    if (r && typeof r === "object" && Array.isArray(r.questions)) pending.set(g.id, { ...r, status: "pending" });
  }
}
