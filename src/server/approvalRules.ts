/**
 * Approval rules + idempotent approval replay (MF4 option 14).
 *
 *  - `approval_rules`: saved permission rules per agent/tool ("always allow").
 *    `agent_id IS NULL` means the rule is global. The gate checks agent-specific
 *    rules first, then global ones, BEFORE asking the user.
 *  - `approval_decisions`: each approval request has a stable key
 *    (`taskId + toolCallId`, or a hash of `taskId|tool|args` when no call id is
 *    available). A decision is stored once and replays return the same decision
 *    without re-prompting.
 *  - `approval_task_modes`: per-task auto-approve ("Approve for me") toggle.
 */
import crypto from "node:crypto";
import { database } from "./sqliteStore.js";

export type ApprovalDecision = "allow" | "deny";

export interface ApprovalRule {
  id: string;
  /** null = global rule (applies to every agent). */
  agentId: string | null;
  tool: string;
  /** null = any arguments; otherwise a case-insensitive substring match on the canonical JSON of the args. */
  pattern: string | null;
  decision: ApprovalDecision;
  createdAt: string;
}

export interface ReplayDecision {
  decision: ApprovalDecision;
  source: "user" | "rule" | "auto";
  decidedAt: string;
}

const MAX_DECISION_ROWS = 2000;

function ensureTables(): void {
  database().exec(`CREATE TABLE IF NOT EXISTS approval_rules (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    tool TEXT NOT NULL,
    pattern TEXT,
    decision TEXT NOT NULL CHECK (decision IN ('allow','deny')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS approval_rules_scope ON approval_rules(agent_id, tool);
  CREATE TABLE IF NOT EXISTS approval_decisions (
    key TEXT PRIMARY KEY,
    decision TEXT NOT NULL CHECK (decision IN ('allow','deny')),
    source TEXT NOT NULL,
    decided_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS approval_task_modes (
    task_id TEXT PRIMARY KEY,
    auto INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );`);
}

ensureTables();

function rowToRule(row: unknown): ApprovalRule {
  const r = row as {
    id: string;
    agent_id: string | null;
    tool: string;
    pattern: string | null;
    decision: string;
    created_at: string;
  };
  return {
    id: r.id,
    agentId: r.agent_id ?? null,
    tool: r.tool,
    pattern: r.pattern ?? null,
    decision: r.decision === "deny" ? "deny" : "allow",
    createdAt: r.created_at,
  };
}

function newRuleId(): string {
  return `arule_${Date.now().toString(36)}${crypto.randomBytes(6).toString("hex")}`;
}

/** Deterministic serialization so identical args always hash/compare the same. */
export function canonicalArgsJson(args: unknown): string {
  const walk = (value: unknown): string => {
    if (value === undefined) return "null";
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(walk).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${walk(v)}`).join(",")}}`;
  };
  return walk(args);
}

/** Stable approval key: `taskId + toolCallId` when a call id is supplied, else
 *  a SHA-256 of taskId|tool|args. Never changes for the same logical request. */
export function approvalStableKey(taskId: string, toolCallId: string | undefined, tool: string, args: unknown): string {
  const seed = `${taskId}|${tool}|${canonicalArgsJson(args)}`;
  const hashed = crypto.createHash("sha256").update(seed).digest("hex");
  return toolCallId ? `${taskId}:${toolCallId}` : `hash:${hashed}`;
}

interface RuleRow {
  id: string;
  agent_id: string | null;
  tool: string;
  pattern: string | null;
  decision: string;
  created_at: string;
}

function patternMatches(pattern: string | null, argsSource: string): boolean {
  const p = (pattern ?? "").trim();
  if (!p || p === "*") return true;
  return argsSource.toLowerCase().includes(p.toLowerCase());
}

/** Find a matching rule for one tool call. Agent-specific rules win over global
 *  ones; within a scope the newest rule wins. */
export function matchApprovalRule(input: { agentId?: string | null; tool: string; args?: unknown }): ApprovalRule | undefined {
  const rows = database()
    .prepare("SELECT id, agent_id, tool, pattern, decision, created_at FROM approval_rules WHERE tool = ? ORDER BY created_at DESC, id DESC")
    .all(input.tool) as unknown as RuleRow[];
  const argsSource = canonicalArgsJson(input.args ?? {});
  const pick = (scopeAgentId: string | null): ApprovalRule | undefined => {
    for (const row of rows) {
      if ((row.agent_id ?? null) !== scopeAgentId) continue;
      if (patternMatches(row.pattern, argsSource)) return rowToRule(row);
    }
    return undefined;
  };
  if (input.agentId) {
    const agentRule = pick(input.agentId);
    if (agentRule) return agentRule;
  }
  return pick(null);
}

/** Rules for one agent (its own rules plus global ones). Without an agentId every rule is returned. */
export function listApprovalRules(agentId?: string | null): ApprovalRule[] {
  const rows = database()
    .prepare("SELECT id, agent_id, tool, pattern, decision, created_at FROM approval_rules ORDER BY created_at DESC, id DESC")
    .all() as unknown as RuleRow[];
  return rows
    .map(rowToRule)
    .filter((rule) => (agentId ? rule.agentId === null || rule.agentId === agentId : true));
}

/** Create-or-update: an existing rule with the same scope (agent, tool, pattern)
 *  keeps its identity and only its decision is replaced. */
export function createApprovalRule(input: { agentId?: string | null; tool: string; pattern?: string | null; decision: ApprovalDecision }): ApprovalRule {
  const tool = input.tool.trim();
  if (!tool) throw new Error("tool is required");
  if (input.decision !== "allow" && input.decision !== "deny") throw new Error("decision must be allow or deny");
  const agentId = input.agentId && input.agentId.trim() ? input.agentId.trim() : null;
  const patternRaw = typeof input.pattern === "string" ? input.pattern.trim() : "";
  const pattern = patternRaw || null;
  const db = database();
  const existing = db
    .prepare("SELECT id, agent_id, tool, pattern, decision, created_at FROM approval_rules WHERE tool = ? AND IFNULL(agent_id,'') = IFNULL(?, '') AND IFNULL(pattern,'') = IFNULL(?, '')")
    .get(tool, agentId, pattern) as unknown as RuleRow | undefined;
  if (existing) {
    db.prepare("UPDATE approval_rules SET decision = ? WHERE id = ?").run(input.decision, existing.id);
    const updated = db.prepare("SELECT id, agent_id, tool, pattern, decision, created_at FROM approval_rules WHERE id = ?").get(existing.id) as unknown as RuleRow;
    return rowToRule(updated);
  }
  const now = new Date().toISOString();
  const rule: ApprovalRule = { id: newRuleId(), agentId, tool, pattern, decision: input.decision, createdAt: now };
  db.prepare("INSERT INTO approval_rules (id, agent_id, tool, pattern, decision, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    rule.id,
    rule.agentId,
    rule.tool,
    rule.pattern,
    rule.decision,
    rule.createdAt,
  );
  return rule;
}

export function deleteApprovalRule(id: string): boolean {
  return Number(database().prepare("DELETE FROM approval_rules WHERE id = ?").run(id).changes) > 0;
}

/** Stored decision for a stable key. Replays return the same decision without
 *  ever reaching the prompt again. */
export function getReplayDecision(key: string): ReplayDecision | undefined {
  const row = database().prepare("SELECT decision, source, decided_at FROM approval_decisions WHERE key = ?").get(key) as
    | { decision: string; source: string; decided_at: string }
    | undefined;
  if (!row) return undefined;
  return {
    decision: row.decision === "deny" ? "deny" : "allow",
    source: row.source === "user" ? "user" : row.source === "auto" ? "auto" : "rule",
    decidedAt: row.decided_at,
  };
}

/** Store one decision under its stable key. The FIRST decision wins: a later
 *  conflicting save cannot overwrite it (idempotence of the decision record). */
export function saveApprovalDecision(key: string, decision: ApprovalDecision, source: ReplayDecision["source"], decidedAt?: string): ReplayDecision {
  const at = decidedAt && /^\d{4}-\d{2}-\d{2}T/.test(decidedAt) ? decidedAt : new Date().toISOString();
  database().prepare("INSERT INTO approval_decisions (key, decision, source, decided_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING").run(key, decision, source, at);
  const stored = getReplayDecision(key);
  if (!stored) throw new Error("approval decision could not be stored");
  database().prepare("DELETE FROM approval_decisions WHERE key NOT IN (SELECT key FROM approval_decisions ORDER BY decided_at DESC LIMIT ?)").run(MAX_DECISION_ROWS);
  return stored;
}

/** Per-task "Approve for me": when on, the gate approves sensitive tool calls in
 *  that task without prompting. */
export function setTaskApprovalAuto(taskId: string, auto: boolean): void {
  if (!taskId) throw new Error("taskId is required");
  database()
    .prepare("INSERT INTO approval_task_modes (task_id, auto, updated_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET auto = excluded.auto, updated_at = excluded.updated_at")
    .run(taskId, auto ? 1 : 0, new Date().toISOString());
}

export function taskApprovalAuto(taskId: string): boolean {
  const row = database().prepare("SELECT auto FROM approval_task_modes WHERE task_id = ?").get(taskId) as { auto: number } | undefined;
  return row?.auto === 1;
}
