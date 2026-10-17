import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../config.js";
import { log } from "../log.js";
import { getLoamMode } from "../modes/catalog.js";

export interface AgentRecord {
  id: string;
  name: string;
  emoji: string;
  description: string;
  /** System-level instructions injected for every run of this agent. */
  instructions: string;
  /** Optional model override for this agent. */
  model?: string;
  /** Default run mode for this agent (build = act, ask = read-only answers). */
  mode?: string;
  /** Default effort budget for this agent. */
  effort?: "max" | "high" | "medium" | "low";
  /** Tool names disabled for this agent (empty = full system toolset). */
  disabledTools?: string[];
  createdAt: string;
  updatedAt: string;
}

const FILE = path.join(DATA_DIR, "agents.json");
let agents: AgentRecord[] = [];

function save(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ agents }, null, 1), "utf8");
    fs.renameSync(tmp, FILE);
  } catch (err) {
    log.warn(`agents: save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function loadAgents(): void {
  try {
    if (!fs.existsSync(FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8")) as { agents?: AgentRecord[] };
    agents = (parsed.agents ?? []).filter((a) => a && typeof a.id === "string" && typeof a.name === "string");
  } catch {
    agents = [];
  }
}

export function listAgents(): AgentRecord[] {
  return [...agents].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getAgent(id: string): AgentRecord | undefined {
  return agents.find((a) => a.id === id);
}

export function createAgent(input: { name: string; emoji?: string; description?: string; instructions?: string; model?: string; mode?: string; effort?: string; disabledTools?: unknown }): AgentRecord {
  const mode = input.mode ? getLoamMode(input.mode).id : undefined;
  const now = new Date().toISOString();
  const agent: AgentRecord = {
    id: `agent_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
    name: input.name.trim().slice(0, 80),
    emoji: (input.emoji ?? "🤖").trim().slice(0, 8) || "🤖",
    description: (input.description ?? "").trim().slice(0, 300),
    instructions: (input.instructions ?? "").trim().slice(0, 8000),
    ...(input.model && input.model.trim() ? { model: input.model.trim() } : {}),
    ...(mode ? { mode } : {}),
    ...(input.effort === "max" || input.effort === "high" || input.effort === "medium" || input.effort === "low" ? { effort: input.effort } : {}),
    ...sanitizeDisabled(input.disabledTools),
    createdAt: now,
    updatedAt: now,
  };
  agents.push(agent);
  save();
  log.info(`agent created: ${agent.name} (${agent.id})`);
  return agent;
}

function sanitizeDisabled(value: unknown): { disabledTools?: string[] } {
  if (!Array.isArray(value)) return {};
  const list = value.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, 120));
  return list.length > 0 ? { disabledTools: [...new Set(list)].slice(0, 500) } : { disabledTools: [] };
}

export function updateAgent(id: string, patch: { name?: string; emoji?: string; description?: string; instructions?: string; model?: string | null; mode?: string | null; effort?: string | null; disabledTools?: unknown }): AgentRecord | undefined {
  const agent = agents.find((a) => a.id === id);
  if (!agent) return undefined;
  const mode = typeof patch.mode === "string" ? getLoamMode(patch.mode).id : undefined;
  if (typeof patch.name === "string" && patch.name.trim()) agent.name = patch.name.trim().slice(0, 80);
  if (typeof patch.emoji === "string" && patch.emoji.trim()) agent.emoji = patch.emoji.trim().slice(0, 8);
  if (typeof patch.description === "string") agent.description = patch.description.trim().slice(0, 300);
  if (typeof patch.instructions === "string") agent.instructions = patch.instructions.trim().slice(0, 8000);
  if (patch.model === null) delete agent.model;
  else if (typeof patch.model === "string" && patch.model.trim()) agent.model = patch.model.trim();
  if (patch.mode === null) delete agent.mode;
  else if (mode) agent.mode = mode;
  if (patch.effort === null) delete agent.effort;
  else if (patch.effort === "max" || patch.effort === "high" || patch.effort === "medium" || patch.effort === "low") agent.effort = patch.effort;
  if (patch.disabledTools !== undefined) {
    const s = sanitizeDisabled(patch.disabledTools);
    if (s.disabledTools && s.disabledTools.length > 0) agent.disabledTools = s.disabledTools;
    else delete agent.disabledTools;
  }
  agent.updatedAt = new Date().toISOString();
  save();
  return agent;
}

export function deleteAgent(id: string): boolean {
  const before = agents.length;
  agents = agents.filter((a) => a.id !== id);
  if (agents.length !== before) save();
  return agents.length < before;
}

/** Suffix injected into the system prompt when a task runs under this agent. */
export function agentSystemSuffix(agent: AgentRecord): string {
  const lines = [
    `أنت "${agent.name}"${agent.description ? ` — ${agent.description}` : ""}: وكيل متخصص داخل Loam.`,
    "اتبع التعليمات التالية في كل خطوة:",
    agent.instructions || "(لا تعليمات إضافية)",
  ];
  return lines.join("\n");
}