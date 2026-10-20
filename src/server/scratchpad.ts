import crypto from "node:crypto";
import { database, transaction } from "./sqliteStore.js";

export type ScratchpadStatus = "open" | "done";

export interface ScratchpadItem {
  id: string;
  agentId: string;
  text: string;
  status: ScratchpadStatus;
  createdAt: string;
  doneAt?: string;
}

function newId(): string {
  return `todo_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function ensureTable(): void {
  const db = database();
  db.exec(`CREATE TABLE IF NOT EXISTS scratchpad_items (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','done')),
    created_at TEXT NOT NULL,
    done_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scratchpad_agent_status ON scratchpad_items(agent_id, status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scratchpad_created ON scratchpad_items(agent_id, created_at);`);
}

ensureTable();

function rowToItem(row: Record<string, unknown>): ScratchpadItem {
  const doneAt = row.done_at;
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    text: String(row.text),
    status: row.status === "done" ? "done" : "open",
    createdAt: String(row.created_at),
    ...(doneAt && typeof doneAt === "string" ? { doneAt } : {}),
  };
}

export function addScratchpadItem(agentId: string, text: string): ScratchpadItem {
  const id = newId();
  const createdAt = new Date().toISOString();
  const trimmed = text.trim();
  if (!trimmed) throw new Error("scratchpad text is required");
  const db = database();
  db.prepare(
    "INSERT INTO scratchpad_items (id, agent_id, text, status, created_at) VALUES (?, ?, ?, 'open', ?)",
  ).run(id, agentId, trimmed, createdAt);
  return { id, agentId, text: trimmed, status: "open", createdAt };
}

export function listScratchpadItems(agentId: string, status?: ScratchpadStatus): ScratchpadItem[] {
  const db = database();
  if (status) {
    const rows = db
      .prepare(
        "SELECT id, agent_id, text, status, created_at, done_at FROM scratchpad_items WHERE agent_id = ? AND status = ? ORDER BY created_at DESC",
      )
      .all(agentId, status) as Record<string, unknown>[];
    return rows.map(rowToItem);
  }
  const rows = db
    .prepare(
      "SELECT id, agent_id, text, status, created_at, done_at FROM scratchpad_items WHERE agent_id = ? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC",
    )
    .all(agentId) as Record<string, unknown>[];
  return rows.map(rowToItem);
}

export function completeScratchpadItem(agentId: string, id: string): ScratchpadItem | undefined {
  const doneAt = new Date().toISOString();
  return transaction(() => {
    const db = database();
    const result = db
      .prepare("UPDATE scratchpad_items SET status = 'done', done_at = ? WHERE id = ? AND agent_id = ? AND status = 'open'")
      .run(doneAt, id, agentId);
    if (Number(result.changes) === 0) return undefined;
    const row = db.prepare("SELECT id, agent_id, text, status, created_at, done_at FROM scratchpad_items WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToItem(row) : undefined;
  });
}

export function removeScratchpadItem(agentId: string, id: string): boolean {
  const result = database().prepare("DELETE FROM scratchpad_items WHERE id = ? AND agent_id = ?").run(id, agentId);
  return Number(result.changes) > 0;
}
