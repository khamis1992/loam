import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../config.js";
import { log } from "../log.js";
import { getLoamMode } from "../modes/catalog.js";
import { normalizeWorkMode, validateServiceIds } from "./companionGateway.js";

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
  /** Default work mode for this agent (chat / loam / user_device / own_device / team / continuous). */
  workMode?: string;
  /** Service grants from the companion gateway. Empty/undefined = all services. */
  allowedServices?: string[];
  /** Voice name used by the UI speech engine for this companion (section 13). */
  voice?: string;
  /** Speech rate 0.5..2 (default 1). */
  voiceRate?: number;
  /** Auto-read assistant replies aloud. */
  voiceAuto?: boolean;
  /** Soft-archive timestamp: archived companions keep all data but leave the active list. */
  archivedAt?: string;
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

export function listAgents(includeArchived = false): AgentRecord[] {
  return [...agents].filter((a) => (includeArchived ? true : !a.archivedAt)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Soft-archive keeps the companion's data for later restore instead of deleting it. */
export function setAgentArchived(id: string, archived: boolean): AgentRecord | undefined {
  const agent = agents.find((a) => a.id === id);
  if (!agent) return undefined;
  if (archived) agent.archivedAt = new Date().toISOString();
  else delete agent.archivedAt;
  agent.updatedAt = new Date().toISOString();
  save();
  return agent;
}

export function getAgent(id: string): AgentRecord | undefined {
  return agents.find((a) => a.id === id);
}

function sanitizeServices(value: unknown): { allowedServices?: string[] } {
  if (!Array.isArray(value)) return {};
  const list = value.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, 60));
  const unique = [...new Set(list)].slice(0, 40);
  if (unique.length === 0) return {};
  validateServiceIds(unique);
  return { allowedServices: unique };
}

export function createAgent(input: { name: string; emoji?: string; description?: string; instructions?: string; model?: string; mode?: string; effort?: string; disabledTools?: unknown; workMode?: string; allowedServices?: unknown; voice?: string; voiceRate?: number; voiceAuto?: boolean }): AgentRecord {
  const mode = input.mode ? getLoamMode(input.mode).id : undefined;
  const workMode = input.workMode ? normalizeWorkMode(input.workMode) : undefined;
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
    ...(workMode ? { workMode } : {}),
    ...sanitizeServices(input.allowedServices),
    ...(input.voice && input.voice.trim() ? { voice: input.voice.trim().slice(0, 60) } : {}),
    ...(Number.isFinite(Number(input.voiceRate)) ? { voiceRate: Math.max(0.5, Math.min(2, Number(input.voiceRate))) } : {}),
    ...(typeof input.voiceAuto === "boolean" ? { voiceAuto: input.voiceAuto } : {}),
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

export function updateAgent(id: string, patch: { name?: string; emoji?: string; description?: string; instructions?: string; model?: string | null; mode?: string | null; effort?: string | null; disabledTools?: unknown; workMode?: string | null; allowedServices?: unknown; voice?: string | null; voiceRate?: number | null; voiceAuto?: boolean | null }): AgentRecord | undefined {
  const agent = agents.find((a) => a.id === id);
  if (!agent) return undefined;
  const mode = typeof patch.mode === "string" ? getLoamMode(patch.mode).id : undefined;
  const workMode = typeof patch.workMode === "string" && patch.workMode.trim() ? normalizeWorkMode(patch.workMode) : undefined;
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
  if (patch.workMode === null) delete agent.workMode;
  else if (workMode) agent.workMode = workMode;
  if (patch.voice === null) delete agent.voice;
  else if (typeof patch.voice === "string" && patch.voice.trim()) agent.voice = patch.voice.trim().slice(0, 60);
  if (patch.voiceRate === null) delete agent.voiceRate;
  else if (Number.isFinite(Number(patch.voiceRate))) agent.voiceRate = Math.max(0.5, Math.min(2, Number(patch.voiceRate)));
  if (patch.voiceAuto === null) delete agent.voiceAuto;
  else if (typeof patch.voiceAuto === "boolean") agent.voiceAuto = patch.voiceAuto;
  if (patch.allowedServices !== undefined) {
    const s = sanitizeServices(patch.allowedServices);
    if (s.allowedServices) agent.allowedServices = s.allowedServices;
    else delete agent.allowedServices;
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