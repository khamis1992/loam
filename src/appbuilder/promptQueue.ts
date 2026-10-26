// src/appbuilder/promptQueue.ts — Cap G §4.11.2: one persisted prompt queue per
// App project (app_prompt_queue + app_queue_state), so a Loam restart keeps it.
// While a run is going, Send adds an item instead of interrupting; when a run
// ends the runner takes the lowest-position queued item. Max 20 items, content
// max 20,000 characters. The queue pauses automatically on failure, waiting
// cards, edit sessions and races; "Resume" restarts it.
import { randomUUID } from "node:crypto";
import { database } from "../server/sqliteStore.js";
import { getAppProject } from "./projects.js";
import type { AppRunFlavor, PromptQueueItem, PromptQueueState, QueueItemStatus } from "./types.js";

export const MAX_QUEUE_ITEMS = 20;
export const MAX_CONTENT_CHARS = 20_000;
const ID_RE = /^pq_[a-z0-9]{12}$/;

interface QueueRow {
  id: string; project_id: string; position: number; content: string; flavor: string;
  attachments: string; status: string; created_at: string; updated_at: string;
}

const nowIso = (): string => new Date().toISOString();

function toQueueItem(r: QueueRow): PromptQueueItem {
  let attachments: string[] = [];
  try { attachments = JSON.parse(r.attachments) as string[]; } catch { /* corrupt row falls back to none */ }
  return {
    id: r.id, projectId: r.project_id, position: r.position, content: r.content,
    flavor: r.flavor as AppRunFlavor, attachments,
    status: r.status as QueueItemStatus, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const liveItems = (projectId: string): PromptQueueItem[] =>
  (database().prepare(
    "SELECT * FROM app_prompt_queue WHERE project_id = ? AND status IN ('queued','sending','failed') ORDER BY position, created_at",
  ).all(projectId) as unknown as QueueRow[]).map(toQueueItem);

const isPaused = (projectId: string): boolean =>
  Boolean((database().prepare("SELECT paused FROM app_queue_state WHERE project_id = ?").get(projectId) as unknown as { paused?: number } | undefined)?.paused);

function setPausedRow(projectId: string, paused: boolean): void {
  database().prepare("INSERT INTO app_queue_state (project_id, paused) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET paused = excluded.paused")
    .run(projectId, paused ? 1 : 0);
}

export function queueState(projectId: string): PromptQueueState {
  return { projectId, paused: isPaused(projectId), items: liveItems(projectId) };
}

export function setQueuePaused(projectId: string, paused: boolean): PromptQueueState {
  setPausedRow(projectId, paused);
  return queueState(projectId);
}

/** Adds one item at the end of the queue. Errors are route codes, not exceptions. */
export function enqueuePrompt(projectId: string, content: string, flavor: AppRunFlavor, attachments: string[] = []): PromptQueueItem | { error: string } {
  if (!getAppProject(projectId)) return { error: "not_found" };
  if (isPaused(projectId)) return { error: "queue_paused" };
  const trimmed = typeof content === "string" ? content.trim() : "";
  if (!trimmed) return { error: "content_required" };
  if (trimmed.length > MAX_CONTENT_CHARS) return { error: "content_too_long" };
  if (attachments.some((a) => typeof a !== "string" || a.length > 500)) return { error: "bad_attachments" };
  if (liveItems(projectId).filter((i) => i.status === "queued").length >= MAX_QUEUE_ITEMS) return { error: "queue_full" };
  const db = database();
  const id = `pq_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const at = nowIso();
  const max = db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM app_prompt_queue WHERE project_id = ?").get(projectId) as unknown as { m: number };
  db.prepare(
    "INSERT INTO app_prompt_queue (id, project_id, position, content, flavor, attachments, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
  ).run(id, projectId, max.m + 1, trimmed, flavor, JSON.stringify(attachments), at, at);
  return toQueueItem(db.prepare("SELECT * FROM app_prompt_queue WHERE id = ?").get(id) as unknown as QueueRow);
}

/** Only `queued` items can be edited or moved (dense positions are re-packed). */
export function updateQueueItem(projectId: string, itemId: string, patch: { content?: unknown; position?: unknown }): PromptQueueState | { error: string } {
  if (!ID_RE.test(itemId)) return { error: "bad_item_id" };
  const db = database();
  const row = db.prepare("SELECT * FROM app_prompt_queue WHERE id = ? AND project_id = ?").get(itemId, projectId) as unknown as QueueRow | undefined;
  if (!row) return { error: "not_found" };
  if (row.status !== "queued") return { error: "not_queued" };
  if (patch.content !== undefined) {
    if (typeof patch.content !== "string" || !patch.content.trim()) return { error: "content_required" };
    if (patch.content.trim().length > MAX_CONTENT_CHARS) return { error: "content_too_long" };
    db.prepare("UPDATE app_prompt_queue SET content = ?, updated_at = ? WHERE id = ?").run(patch.content.trim(), nowIso(), itemId);
  }
  if (patch.position !== undefined) {
    if (typeof patch.position !== "number" || !Number.isInteger(patch.position) || patch.position < 0) return { error: "bad_position" };
    // Move = take the item out of the ordered list and splice it in at the target
    // slot; everyone else shifts, then positions are re-packed densely.
    const ordered = liveItems(projectId).filter((i) => i.status === "queued");
    const at = Math.min(patch.position, Math.max(0, ordered.length - 1));
    const from = ordered.findIndex((i) => i.id === itemId);
    if (from >= 0 && from !== at) {
      const [moved] = ordered.splice(from, 1);
      ordered.splice(at, 0, moved!);
      let pos = 0;
      for (const item of ordered) db.prepare("UPDATE app_prompt_queue SET position = ? WHERE id = ?").run(pos++, item.id);
    }
  }
  rePack(projectId);
  return queueState(projectId);
}

export function removeQueueItem(projectId: string, itemId: string): PromptQueueState | { error: string } {
  if (!ID_RE.test(itemId)) return { error: "bad_item_id" };
  const db = database();
  const row = db.prepare("SELECT * FROM app_prompt_queue WHERE id = ? AND project_id = ?").get(itemId, projectId) as QueueRow | undefined;
  if (!row) return { error: "not_found" };
  if (row.status !== "queued") return { error: "not_queued" };
  db.prepare("DELETE FROM app_prompt_queue WHERE id = ?").run(itemId);
  rePack(projectId);
  return queueState(projectId);
}

/** The runner calls this when a run ends: takes the lowest-position queued item and marks it `sending`. */
export function takeNextQueued(projectId: string): PromptQueueItem | null {
  const db = database();
  const row = db.prepare(
    "SELECT * FROM app_prompt_queue WHERE project_id = ? AND status = 'queued' ORDER BY position, created_at LIMIT 1",
  ).get(projectId) as unknown as QueueRow | undefined;
  if (!row) return null;
  db.prepare("UPDATE app_prompt_queue SET status = 'sending', updated_at = ? WHERE id = ?").run(nowIso(), row.id);
  return toQueueItem(row);
}

export function markQueueItemSent(itemId: string): void {
  database().prepare("UPDATE app_prompt_queue SET status = 'sent', updated_at = ? WHERE id = ?").run(nowIso(), itemId);
}

/** A failure to start pauses the queue (§4.11.2) so it never spins. */
export function markQueueItemFailed(projectId: string, itemId: string, reason: string): void {
  const db = database();
  db.prepare("UPDATE app_prompt_queue SET status = 'failed', updated_at = ? WHERE id = ?").run(nowIso(), itemId);
  setPausedRow(projectId, true);
  void reason;
}

/** Re-numbers live positions densely 0..n by (position, created_at). */
function rePack(projectId: string): void {
  const db = database();
  const rows = db.prepare(
    "SELECT id FROM app_prompt_queue WHERE project_id = ? AND status = 'queued' ORDER BY position, created_at",
  ).all(projectId) as Array<{ id: string }>;
  let pos = 0;
  for (const r of rows) db.prepare("UPDATE app_prompt_queue SET position = ? WHERE id = ?").run(pos++, r.id);
}
