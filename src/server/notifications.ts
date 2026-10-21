/**
 * Sidebar notification feed (option #20).
 *
 * Store: the shared entities table under kind="notifications" ({ id, kind,
 * title, body, taskId, readAt, createdAt }). Fed by minimal hooks: task
 * completion/failure (db.setTaskStatus), schedule run failures
 * (db.recordScheduleOutcome) and pending sensitive-action approvals
 * (approvals.createApproval).
 */
import crypto from "node:crypto";
import { allEntities, putEntity, getEntity, removeEntity } from "./sqliteStore.js";

export const NOTIFICATION_KIND = "notifications";

export type NotificationKind = "task-done" | "task-failed" | "approval-pending" | "schedule-failed";

export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  taskId?: string;
  readAt?: string;
  createdAt: string;
}

/**
 * Agent-facing feed representation (snake_case ids per the API contract).
 */
export interface NotificationApi {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  task_id: string | null;
  read_at: string | null;
  created_at: string;
}

export function toApi(n: NotificationRecord): NotificationApi {
  return { id: n.id, kind: n.kind, title: n.title, body: n.body, task_id: n.taskId ?? null, read_at: n.readAt ?? null, created_at: n.createdAt };
}

/** Keep the feed bounded: read notifications beyond this list size are pruned. */
const KEEP_LIMIT = 200;

export function createNotification(input: { kind: NotificationKind; title: string; body: string; taskId?: string; dedupe?: boolean }): NotificationRecord | undefined {
  const title = (input.title ?? "").trim().slice(0, 200);
  const body = (input.body ?? "").trim().slice(0, 500);
  if (!title) return undefined;
  const record: NotificationRecord = {
    id: `ntfy_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`,
    kind: input.kind,
    title,
    body,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    createdAt: new Date().toISOString(),
  };
  if (input.dedupe && input.taskId) {
    // Suppress duplicate emits for the same event: same kind + task within a
    // short window (e.g. completeTaskRun and a direct setTaskStatus call both
    // firing during one completion). A later run still notifies again.
    const windowStart = new Date(Date.now() - 10_000).toISOString();
    const duplicate = allEntities<NotificationRecord>(NOTIFICATION_KIND).some(
      (n) => n.kind === input.kind && n.taskId === input.taskId && n.createdAt > windowStart,
    );
    if (duplicate) return undefined;
  }
  putEntity(NOTIFICATION_KIND, record);
  pruneOldRead();
  return record;
}

/** Feed task status changes: done and error only. */
export function notifyTaskStatus(taskId: string, status: "done" | "error", extra?: { title?: string; error?: string }): NotificationRecord | undefined {
  if (status === "done") {
    return createNotification({ kind: "task-done", title: extra?.title?.trim() || "Task completed", body: `${extra?.title?.trim() || "The task"} finished successfully.`, taskId, dedupe: true });
  }
  return createNotification({ kind: "task-failed", title: extra?.title?.trim() || "Task failed", body: (extra?.error ?? "The task ended with an error.").slice(0, 500), taskId, dedupe: true });
}

export function notifyScheduleFailed(scheduleId: string, prompt: string, error: string): NotificationRecord | undefined {
  return createNotification({ kind: "schedule-failed", title: "Routine run failed", body: `Routine "${prompt.slice(0, 80)}" failed repeatedly: ${error.slice(0, 200)}`, taskId: scheduleId, dedupe: true });
}

export function notifyApprovalPending(approval: { id: string; taskId: string; tool: string; summary: string }): NotificationRecord | undefined {
  return createNotification({ kind: "approval-pending", title: `Approval needed: ${approval.tool}`, body: approval.summary.slice(0, 400) || approval.tool, taskId: approval.taskId });
}

export function listNotifications(opts?: { unreadOnly?: boolean; limit?: number }): NotificationRecord[] {
  const rows = allEntities<NotificationRecord>(NOTIFICATION_KIND)
    .filter((n) => !opts?.unreadOnly || !n.readAt);
  const limit = Math.max(0, opts?.limit ?? rows.length);
  return limit > 0 ? rows.slice(0, limit) : rows;
}

export function unreadNotifications(): number {
  return listNotifications({ unreadOnly: true }).length;
}

export function markNotificationRead(id: string): NotificationRecord | undefined {
  const existing = getEntity<NotificationRecord>(NOTIFICATION_KIND, id);
  if (!existing) return undefined;
  if (existing.readAt) return existing;
  const updated: NotificationRecord = { ...existing, readAt: new Date().toISOString() };
  putEntity(NOTIFICATION_KIND, updated);
  return updated;
}

export function markAllNotificationsRead(): number {
  let count = 0;
  for (const n of listNotifications({ unreadOnly: true })) {
    if (markNotificationRead(n.id)) count++;
  }
  return count;
}

/** Retention: drop the oldest read notifications once the feed exceeds KEEP_LIMIT. */
function pruneOldRead(): void {
  const rows = allEntities<NotificationRecord>(NOTIFICATION_KIND);
  if (rows.length <= KEEP_LIMIT) return;
  for (const n of rows.slice(KEEP_LIMIT)) {
    if (n.readAt) removeEntity(NOTIFICATION_KIND, n.id);
  }
}
