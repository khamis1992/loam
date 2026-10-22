import { database } from "./sqliteStore.js";

/** Entity for mapping an agent to its persistent thread. */
export interface AgentThreadInfo {
  agentId: string;
  threadUid: string;
  updatedAt: string;
  lastSeenAt?: string;
  lastMessageAt?: string;
  unread: boolean;
}

function ensureTable(): void {
  database().exec(`CREATE TABLE IF NOT EXISTS agent_threads (
    agent_id TEXT PRIMARY KEY,
    thread_uid TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seen_at TEXT,
    last_message_at TEXT
  );`);
}

ensureTable();

function unreadOf(row: { lastSeenAt?: string | null; lastMessageAt?: string | null }): boolean {
  if (!row.lastMessageAt) return false;
  return !row.lastSeenAt || row.lastMessageAt > row.lastSeenAt;
}

function fromRow(row: unknown): AgentThreadInfo {
  const data = row as { agentId: string; threadUid: string; updatedAt: string; lastSeenAt?: string | null; lastMessageAt?: string | null };
  return {
    agentId: data.agentId,
    threadUid: data.threadUid,
    updatedAt: data.updatedAt,
    ...(data.lastSeenAt ? { lastSeenAt: data.lastSeenAt } : {}),
    ...(data.lastMessageAt ? { lastMessageAt: data.lastMessageAt } : {}),
    unread: unreadOf(data),
  };
}

/** Given a thread uid, convert it to info with unread computed. */
function toInfo(agentId: string, threadUid: string, updatedAt: string, lastSeenAt?: string | null, lastMessageAt?: string | null): AgentThreadInfo {
  return {
    agentId,
    threadUid,
    updatedAt,
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(lastMessageAt ? { lastMessageAt } : {}),
    unread: unreadOf({ lastSeenAt, lastMessageAt }),
  };
}

function rowToInfo(row: { agent_id: string; thread_uid: string; updated_at: string; last_seen_at?: string | null; last_message_at?: string | null }): AgentThreadInfo {
  return toInfo(row.agent_id, row.thread_uid, row.updated_at, row.last_seen_at, row.last_message_at);
}

const SELECT_COLUMNS = "agent_id, thread_uid, updated_at, last_seen_at, last_message_at";

export function getThread(agentId: string): AgentThreadInfo | undefined {
  const db = database();
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM agent_threads WHERE agent_id = ?`).get(agentId) as
    | { agent_id: string; thread_uid: string; updated_at: string; last_seen_at?: string | null; last_message_at?: string | null }
    | undefined;
  if (!row) return undefined;
  return rowToInfo(row);
}

export function setThread(agentId: string, threadUid: string): AgentThreadInfo {
  const trimmed = threadUid.trim();
  if (!trimmed) throw new Error("threadUid is required");
  const db = database();
  const now = new Date().toISOString();
  const prev = getThread(agentId);
  if (prev && prev.threadUid === trimmed) {
    return prev;
  }
  db.prepare("INSERT INTO agent_threads (agent_id, thread_uid, updated_at) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET thread_uid = excluded.thread_uid, updated_at = excluded.updated_at, last_seen_at = NULL, last_message_at = NULL").run(agentId, trimmed, now);
  return toInfo(agentId, trimmed, now);
}

export function markSeen(agentId: string, at?: string): AgentThreadInfo {
  const seenAt = at && /^\d{4}-\d{2}-\d{2}T/.test(at) ? at : new Date().toISOString();
  const db = database();
  const prev = getThread(agentId);
  if (!prev) throw new Error("agent thread not found");
  db.prepare("UPDATE agent_threads SET last_seen_at = ? WHERE agent_id = ?").run(seenAt, agentId);
  return { ...prev, lastSeenAt: seenAt, unread: false };
}

export function touchMessage(agentId: string, at?: string): void {
  const touchedAt = at && /^\d{4}-\d{2}-\d{2}T/.test(at) ? at : new Date().toISOString();
  const db = database();
  const prev = getThread(agentId);
  if (!prev) return;
  if (prev.lastMessageAt && prev.lastMessageAt >= touchedAt) return;
  db.prepare("UPDATE agent_threads SET last_message_at = ? WHERE agent_id = ?").run(touchedAt, agentId);
}

export function listThreads(): AgentThreadInfo[] {
  const db = database();
  const rows = db.prepare(`SELECT ${SELECT_COLUMNS} FROM agent_threads ORDER BY updated_at DESC, agent_id ASC`).all() as
    Array<{ agent_id: string; thread_uid: string; updated_at: string; last_seen_at?: string | null; last_message_at?: string | null }>;
  return rows.map(rowToInfo);
}
