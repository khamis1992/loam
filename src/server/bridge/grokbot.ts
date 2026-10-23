import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../../config.js";
import { log } from "../../log.js";
import { database, transaction } from "../sqliteStore.js";
import { newId, appendMessage, getTask, createTask } from "../db.js";
import { getThread } from "../agentThreads.js";
import { getAgent, listAgents } from "../agents.js";
import { BoundedMap } from "../../memory/cache.js";
import { registerCacheStats } from "../../memory/stats.js";

/**
 * One-way Grok Bot -> Loam bridge (Phase 3).
 *
 * - POST /api/bridge/grokbot/mirror {agentRef, from, text, ts, execute?:false}
 *   stores the message (in-memory + sqlite) and, when the agent already has a
 *   mapped chat thread, appends a READ-ONLY labelled note into that thread. It
 *   never starts a run or any tool/action.
 * - POST /api/bridge/grokbot/task {agentRef, text, execute:true, token}
 *   enqueues a real run only when execute===true AND the token matches the local
 *   bridge token (env LOAM_BRIDGE_TOKEN, then data/bridge-token), rate-limited;
 *   logs the agent name only, never the token.
 */

export const GROKBOT_MIRROR_KIND = "grokbotMirror";
export const GROKBOT_NOTE_HEADER = "from Grok Bot:";

export interface GrokBotMirrorMessage {
  id: string;
  agentId: string;
  from: string;
  text: string;
  ts: string;
  receivedAt: string;
  /** Always false for mirror ingest; true only for explicit execute tasks. */
  execute: boolean;
  /** True when the note was also appended into the agent's mapped chat thread. */
  threadAppended: boolean;
}

/** Labelled note content written into the agent thread (history + context). */
export function mirrorNoteContent(text: string): string {
  return `${GROKBOT_NOTE_HEADER}\n${text}`;
}

const ensureTable = (): void => {
  database().exec(`CREATE TABLE IF NOT EXISTS grokbot_mirror (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    from_name TEXT NOT NULL,
    text TEXT NOT NULL,
    ts TEXT NOT NULL,
    received_at TEXT NOT NULL,
    execute INTEGER NOT NULL DEFAULT 0,
    thread_appended INTEGER NOT NULL DEFAULT 0
  );`);
};

try {
  ensureTable();
} catch (err) {
  log.warn(`grokbot bridge: table init delayed: ${err instanceof Error ? err.message : String(err)}`);
}

function ensureTableSafe(): void {
  try { ensureTable(); } catch { /* sqlite closed during tests */ }
}

// Small in-memory cache of the most recent messages per agent for fast reads.
// Bounded (J6): each agent keeps at most RECENT_CACHE_LIMIT messages, and the
// number of agents retained is capped too (an unbounded agent count is a leak
// in a long-lived bridge process).
const recentByAgent = new BoundedMap<string, GrokBotMirrorMessage[]>(128, "grokbot-recent");
registerCacheStats("grokbot-recent", () => recentByAgent.stats());
const RECENT_CACHE_LIMIT = 100;

export function resetGrokbotBridgeForTests(): void {
  recentByAgent.clear();
  executeRate.clear();
}

export function storeMirror(input: { agentId: string; from: string; text: string; ts?: string; execute?: boolean; threadAppended: boolean }): GrokBotMirrorMessage {
  const record: GrokBotMirrorMessage = {
    id: newId("gbmirror"),
    agentId: input.agentId,
    from: input.from.trim() || "Grok Bot",
    text: input.text,
    ts: input.ts && /^\d{4}-\d{2}-\d{2}T/.test(String(input.ts)) ? String(input.ts) : new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    execute: input.execute === true,
    threadAppended: input.threadAppended,
  };
  ensureTableSafe();
  try {
    transaction(() => {
      database().prepare(
        "INSERT INTO grokbot_mirror (id, agent_id, from_name, text, ts, received_at, execute, thread_appended) VALUES (?,?,?,?,?,?,?,?)",
      ).run(record.id, record.agentId, record.from, record.text, record.ts, record.receivedAt, record.execute ? 1 : 0, record.threadAppended ? 1 : 0);
    });
  } catch (err) {
    log.warn(`grokbot bridge: sqlite store failed (memory only): ${err instanceof Error ? err.message : String(err)}`);
  }
  const list = recentByAgent.get(record.agentId) ?? [];
  list.push(record);
  if (list.length > RECENT_CACHE_LIMIT) list.shift();
  recentByAgent.set(record.agentId, list);
  return record;
}

export function listMirrors(agentId: string, limit = 50): GrokBotMirrorMessage[] {
  ensureTableSafe();
  const cached = recentByAgent.get(agentId);
  if (cached && cached.length > 0) return [...cached].slice(-(Math.max(1, limit)));
  try {
    const rows = database().prepare(
      "SELECT id, agent_id, from_name, text, ts, received_at, execute, thread_appended FROM grokbot_mirror WHERE agent_id = ? ORDER BY ts ASC LIMIT ?",
    ).all(agentId, Math.max(1, limit)) as Array<{ id: string; agent_id: string; from_name: string; text: string; ts: string; received_at: string; execute: number; thread_appended: number }>;
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      from: r.from_name,
      text: r.text,
      ts: r.ts,
      receivedAt: r.received_at,
      execute: r.execute === 1,
      threadAppended: r.thread_appended === 1,
    }));
  } catch {
    return [];
  }
}

/** Resolve agentRef (a grokbot-sourced Loam id or agent name). */
export function resolveGrokbotAgentRef(agentRef: string): string | undefined {
  const ref = agentRef.trim().toLowerCase();
  if (!ref) return undefined;
  const agents = listAgents(true).filter((a) => a.source === "grokbot");
  return (
    agents.find((a) => a.id.toLowerCase() === ref)
    ?? agents.find((a) => a.name.trim().toLowerCase() === ref)
  )?.id;
}

/**
 * Append the labelled note into the agent's mapped chat thread if one exists.
 * This only mutates stored messages (context), it never starts a run.
 */
export function appendMirrorToThread(agentId: string, text: string): boolean {
  const thread = getThread(agentId);
  if (!thread || !getTask(thread.threadUid)) return false;
  appendMessage(thread.threadUid, "user", mirrorNoteContent(text));
  return true;
}

// --- execute path ---

export function bridgeToken(): string {
  const env = process.env.LOAM_BRIDGE_TOKEN;
  if (env && env.trim()) return env.trim();
  try {
    const file = path.join(DATA_DIR, "bridge-token");
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  } catch { /* unreadable token file = empty */ }
  return "";
}

const RATE_LIMIT_WIN_MS = 60_000;
const RATE_LIMIT_MAX = 20;
/** Bounded (J6): one hit list per calling agent reference. */
const executeRate = new BoundedMap<string, number[]>(256, "grokbot-rate");
registerCacheStats("grokbot-rate", () => executeRate.stats());

export function checkExecuteRate(agentRef: string): boolean {
  const now = Date.now();
  const hits = (executeRate.get(agentRef) ?? []).filter((t) => now - t < RATE_LIMIT_WIN_MS);
  if (hits.length >= RATE_LIMIT_MAX) {
    executeRate.set(agentRef, hits);
    return false;
  }
  hits.push(now);
  executeRate.set(agentRef, hits);
  return true;
}

type RunTaskFn = (opts: { prompt: string; emit: (event: unknown) => void; taskId?: string; agentId?: string }) => Promise<{ taskId: string; text: string }>;

function runTaskRef(): RunTaskFn | undefined {
  return (globalThis as { __loamRunTask?: RunTaskFn }).__loamRunTask;
}

/** Fixed-length timing-safe token comparison (digests never leak by timing). */
function tokenMatches(provided: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export interface ExecuteResult {
  status: number;
  body: Record<string, unknown>;
}

/** Decide (and start) the execute path for POST /api/bridge/grokbot/task. */
export function executeGrokbotTask(input: { agentRef?: unknown; text?: unknown; execute?: unknown; token?: unknown }): ExecuteResult {
  if (input.execute !== true) return { status: 400, body: { error: "execute must be true to run a task" } };
  // Rate-limit checks come before any expensive work (and before token checks).
  const rateKey = typeof input.agentRef === "string" ? input.agentRef : "";
  if (!checkExecuteRate(rateKey || "unknown")) return { status: 429, body: { error: "bridge rate limit exceeded; slow down" } };
  const expected = bridgeToken();
  if (!expected) return { status: 503, body: { error: "bridge token is not configured (set LOAM_BRIDGE_TOKEN or data/bridge-token)" } };
  if (typeof input.token !== "string" || !tokenMatches(input.token, expected)) {
    return { status: 403, body: { error: "invalid bridge token" } };
  }
  if (typeof input.text !== "string" || !input.text.trim()) {
    return { status: 400, body: { error: "text is required" } };
  }
  const agentId = resolveGrokbotAgentRef(typeof input.agentRef === "string" ? input.agentRef : "");
  if (!agentId) return { status: 404, body: { error: "no grokbot agent matches agentRef" } };
  const runTask = runTaskRef();
  if (!runTask) return { status: 503, body: { error: "run engine is not ready" } };
  const task = createTask(input.text.trim(), "Grok Bot task", null, agentId);
  const agentName = getAgent(agentId)?.name ?? agentId;
  // Fire-and-forget like the remote trigger; failures land in the runtime log.
  void runTask({ taskId: task.id, prompt: input.text.trim(), agentId, emit: () => {} }).catch((e) =>
    log.warn(`grokbot bridge: run failed for agent ${agentName}: ${e instanceof Error ? e.message : String(e)}`),
  );
  // Only the agent name is logged; the token and its prefix never appear anywhere.
  log.info(`grokbot bridge: executed task for agent ${agentName} (${agentId})`);
  return { status: 202, body: { taskId: task.id, agentId, note: "run enqueued" } };
}
