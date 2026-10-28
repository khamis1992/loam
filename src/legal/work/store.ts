import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { FieldCipher, type KeyProvider } from "../crypto.js";
import type { MatterWorkItem, MatterWorkKind, MatterWorkPatch, MatterWorkReport, MatterWorkStatus, NewMatterWorkItem } from "./types.js";
import type { AuditLog } from "../audit.js";

export const WORK_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  payload_enc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_items_matter ON work_items(matter_id, status, due_at);
`;

const KINDS: readonly MatterWorkKind[] = ["task", "deadline", "hearing", "filing"];
const STATUSES: readonly MatterWorkStatus[] = ["pending", "in_progress", "done", "cancelled"];

function due(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error("invalid work item due date");
  return value;
}

export class WorkStore {
  private readonly cipher: FieldCipher;
  constructor(private readonly db: DatabaseSync, keys: KeyProvider, private readonly audit: AuditLog, private readonly now: () => Date = () => new Date()) {
    this.cipher = new FieldCipher(keys);
  }

  add(matterId: string, input: NewMatterWorkItem, actor: string): MatterWorkItem {
    if (!input.title.trim()) throw new Error("work item title is required");
    if (!KINDS.includes(input.kind)) throw new Error("invalid work item kind");
    if (!STATUSES.includes(input.status)) throw new Error("invalid work item status");
    const at = this.now().toISOString();
    const item: MatterWorkItem = {
      id: `work-${crypto.randomBytes(6).toString("hex")}`, matterId, kind: input.kind, title: input.title.trim(), status: input.status,
      dueAt: due(input.dueAt), assignee: input.assignee?.trim() || null, notes: input.notes?.trim() || null,
      createdAt: at, updatedAt: at, completedAt: input.status === "done" ? at : null,
    };
    this.db.prepare("INSERT INTO work_items(id,matter_id,kind,status,due_at,created_at,updated_at,completed_at,payload_enc) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(item.id, matterId, item.kind, item.status, item.dueAt, at, at, item.completedAt, this.cipher.sealJson(item, `work-item:${item.id}`));
    this.audit.append(actor, "work.create", matterId, item.id, { kind: item.kind, status: item.status });
    return item;
  }

  get(id: string): MatterWorkItem | undefined {
    const row = this.db.prepare("SELECT payload_enc FROM work_items WHERE id=?").get(id) as { payload_enc?: string } | undefined;
    return row?.payload_enc ? this.cipher.openJson<MatterWorkItem>(row.payload_enc, `work-item:${id}`) : undefined;
  }

  list(matterId: string): MatterWorkItem[] {
    const rows = this.db.prepare("SELECT id FROM work_items WHERE matter_id=? ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, created_at").all(matterId) as Array<{ id: string }>;
    return rows.map((row) => this.get(row.id)!).filter(Boolean);
  }

  update(id: string, matterId: string, patch: MatterWorkPatch, actor: string): MatterWorkItem {
    const current = this.get(id);
    if (!current || current.matterId !== matterId) throw new Error("work item not found");
    if (patch.kind !== undefined && !KINDS.includes(patch.kind)) throw new Error("invalid work item kind");
    if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw new Error("invalid work item status");
    if (patch.title !== undefined && !patch.title.trim()) throw new Error("work item title is required");
    const next: MatterWorkItem = {
      ...current, ...patch,
      title: patch.title?.trim() ?? current.title,
      dueAt: patch.dueAt === undefined ? current.dueAt : due(patch.dueAt),
      assignee: patch.assignee === undefined ? current.assignee : patch.assignee?.trim() || null,
      notes: patch.notes === undefined ? current.notes : patch.notes?.trim() || null,
      updatedAt: this.now().toISOString(),
      completedAt: patch.status === "done" ? current.completedAt ?? this.now().toISOString() : patch.status === undefined ? current.completedAt : null,
    };
    this.db.prepare("UPDATE work_items SET kind=?,status=?,due_at=?,updated_at=?,completed_at=?,payload_enc=? WHERE id=?")
      .run(next.kind, next.status, next.dueAt, next.updatedAt, next.completedAt, this.cipher.sealJson(next, `work-item:${id}`), id);
    this.audit.append(actor, "work.update", matterId, id, { status: next.status });
    return next;
  }

  delete(id: string, matterId: string, actor: string): boolean {
    const current = this.get(id);
    if (!current || current.matterId !== matterId) return false;
    const result = this.db.prepare("DELETE FROM work_items WHERE id=?").run(id);
    if (Number(result.changes) > 0) this.audit.append(actor, "work.delete", matterId, id, {});
    return Number(result.changes) > 0;
  }

  report(matterId: string): MatterWorkReport {
    const items = this.list(matterId);
    const today = this.now().toISOString().slice(0, 10);
    const open = items.filter((item) => item.status !== "done" && item.status !== "cancelled");
    return {
      total: items.length,
      pending: items.filter((item) => item.status === "pending").length,
      inProgress: items.filter((item) => item.status === "in_progress").length,
      done: items.filter((item) => item.status === "done").length,
      cancelled: items.filter((item) => item.status === "cancelled").length,
      overdue: open.filter((item) => item.dueAt !== null && item.dueAt < today).length,
      nextDueAt: open.map((item) => item.dueAt).filter((value): value is string => value !== null).sort()[0] ?? null,
    };
  }
}
