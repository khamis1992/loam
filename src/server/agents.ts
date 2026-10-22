import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../config.js";
import { log } from "../log.js";
import { getLoamMode } from "../modes/catalog.js";
import { normalizeWorkMode, validateServiceIds } from "./companionGateway.js";
import { getThread } from "./agentThreads.js";
import { getTask, type TaskMessage } from "./db.js";

export interface AgentRecord {
  id: string;
  name: string;
  emoji: string;
  description: string;
  /** System-level instructions injected for every run of this agent. */
  instructions: string;
  /** Optional short role/subtitle shown under the agent name in the info pane. */
  title?: string;
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
  /** Provenance of the agent: undefined = native Loam, e.g. "grokbot" = imported from a Grok Bot bundle. */
  source?: string;
  /** Grok Bot-style avatar shape token (one of AVATAR_SHAPES). */
  avatarShape?: string;
  /** Grok Bot-style avatar color token (one of AVATAR_COLORS). */
  avatarColor?: string;
  /** Custom avatar image as a data URL or /api asset path, capped at ~256KB. */
  avatarImage?: string;
  /** Soft-archive timestamp: archived companions keep all data but leave the active list. */
  archivedAt?: string;
  /** Per-agent notifications toggle (default true when undefined). */
  notifications?: boolean;
  /** Soft-hide timestamp: hidden companions stay in the UI's collapsible "Hidden" section. */
  hiddenAt?: string;
  /** Pin timestamp (epoch ms): pinned agents show in a "Pinned" section at the top. */
  pinnedAt?: number;
  /** User-defined position among pinned agents (smaller = higher). */
  sortOrder?: number;
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

function pinOrder(a: AgentRecord, b: AgentRecord): number {
  const sa = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const sb = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  const pa = a.pinnedAt ?? Number.MAX_SAFE_INTEGER;
  const pb = b.pinnedAt ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  return a.createdAt.localeCompare(b.createdAt);
}

function isPinned(agent: AgentRecord): boolean {
  return typeof agent.pinnedAt === "number";
}

export function listAgents(includeArchived = false): AgentRecord[] {
  const all = [...agents].filter((a) => (includeArchived ? true : !a.archivedAt));
  return all.sort((first, second) => {
    const firstPinned = isPinned(first) ? 0 : 1;
    const secondPinned = isPinned(second) ? 0 : 1;
    if (firstPinned !== secondPinned) return firstPinned - secondPinned;
    if (firstPinned === 0) return pinOrder(first, second);
    return first.createdAt.localeCompare(second.createdAt);
  });
}

/**
 * Additive per-agent chat metadata served with the agents list so the sidebar
 * rows can show a Grok Bot-style last-message snippet, a waiting/unread dot and
 * a "last activity" sort key without an extra request per agent.
 */
export interface AgentChatMeta {
  /** One-line preview of the thread's latest user/assistant message. */
  lastMessage?: string;
  /** True when the thread's latest message is the assistant's (the user's turn is next). */
  waitingForYou?: boolean;
  /** Unread user/assistant message count (0 when seen or when there is no thread). */
  unreadCount?: number;
  /** Epoch ms of the latest thread message; drives the "last activity" row sort. */
  lastActivityAt?: number;
}

/** Agent record plus the additive chat metadata (agents list endpoint shape). */
export type AgentWithChatMeta = AgentRecord & AgentChatMeta;

/** Character cap for the one-line preview snippet (CSS truncates the rest). */
const LAST_MESSAGE_MAX_CHARS = 140;

function previewSnippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > LAST_MESSAGE_MAX_CHARS ? `${flat.slice(0, LAST_MESSAGE_MAX_CHARS)}…` : flat;
}

function isChatMessage(message: TaskMessage): boolean {
  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" &&
    message.content.trim().length > 0
  );
}

/** Latest user/assistant message of a thread's task, if any. */
function latestThreadMessage(threadUid: string): TaskMessage | undefined {
  const messages = getTask(threadUid)?.messages;
  if (!messages || messages.length === 0) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && isChatMessage(message)) return message;
  }
  return undefined;
}

/** Count chat messages newer than lastSeenAt (all of them when never seen). */
function unreadMessageCount(threadUid: string, lastSeenAt?: string): number {
  const messages = getTask(threadUid)?.messages;
  if (!messages || messages.length === 0) return 0;
  let count = 0;
  for (const message of messages) {
    if (!message || !isChatMessage(message)) continue;
    if (!lastSeenAt || (typeof message.at === "string" && message.at > lastSeenAt)) count++;
  }
  return count;
}

/** Additive chat metadata for one agent's thread (empty object when it has none). */
export function agentChatMeta(agentId: string): AgentChatMeta {
  const thread = getThread(agentId);
  if (!thread) return {};
  const meta: AgentChatMeta = {};
  const last = latestThreadMessage(thread.threadUid);
  if (last) {
    meta.lastMessage = previewSnippet(last.content);
    meta.waitingForYou = last.role === "assistant";
    const at = last.at ? Date.parse(last.at) : Number.NaN;
    if (Number.isFinite(at)) meta.lastActivityAt = at;
  }
  if (thread.unread) meta.unreadCount = Math.max(1, unreadMessageCount(thread.threadUid, thread.lastSeenAt));
  return meta;
}

/**
 * Agents list with additive chat metadata. Every AgentRecord field is
 * unchanged; the chat fields are additive and safe for existing consumers to
 * ignore.
 */
export function listAgentsWithChatMeta(includeArchived = false): AgentWithChatMeta[] {
  return listAgents(includeArchived).map((agent) => ({ ...agent, ...agentChatMeta(agent.id) }));
}

/** Pin or unpin an agent. Pinning appends it to the end of the pinned order; idempotent. */
export function setAgentPinned(id: string, pinned: boolean): AgentRecord | undefined {
  const agent = agents.find((a) => a.id === id);
  if (!agent) return undefined;
  if (pinned === isPinned(agent)) return agent;
  if (pinned) {
    agent.pinnedAt = Date.now();
    agent.sortOrder = nextPinSortOrder();
  } else {
    delete agent.pinnedAt;
    delete agent.sortOrder;
  }
  agent.updatedAt = new Date().toISOString();
  save();
  log.info(`agent ${pinned ? "pinned" : "unpinned"}: ${agent.name} (${agent.id})`);
  return agent;
}

function nextPinSortOrder(): number {
  let max = -1;
  for (const a of agents) {
    if (isPinned(a) && typeof a.sortOrder === "number" && a.sortOrder > max) max = a.sortOrder;
  }
  return max + 1;
}

/**
 * Reorder pinned agents by the given id sequence. Ids that are unknown or not
 * pinned are ignored; pinned agents missing from the list keep their relative
 * order after the listed ones. Assigns dense sortOrder 0..n-1, so repeated
 * calls with the same sequence are a no-op (idempotent).
 */
export function reorderAgents(desiredIds: string[]): AgentRecord[] {
  const pinned = agents.filter((a) => isPinned(a) && !a.archivedAt);
  const pinnedById = new Map(pinned.map((a) => [a.id, a]));
  const head: AgentRecord[] = [];
  for (const id of desiredIds) {
    const agent = pinnedById.get(id);
    if (agent && !head.includes(agent)) head.push(agent);
  }
  const rest = pinned.filter((a) => !head.includes(a)).sort(pinOrder);
  const ordered = [...head, ...rest];
  let changed = false;
  ordered.forEach((agent, index) => {
    if (isPinned(agent) && agent.sortOrder !== index) changed = true;
    agent.sortOrder = index;
  });
  if (changed) save();
  return listAgents().filter(isPinned);
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

/**
 * Hide/unhide keeps the companion listed in the sidebar's collapsible "Hidden"
 * section (Loam-local, [INF] beyond Grok Bot, which only has permanent delete).
 * Idempotent: hiding an already-hidden companion keeps its original hiddenAt.
 */
export function setAgentHidden(id: string, hidden: boolean): AgentRecord | undefined {
  const agent = agents.find((a) => a.id === id);
  if (!agent) return undefined;
  if (hidden) {
    if (!agent.hiddenAt) agent.hiddenAt = new Date().toISOString();
  } else {
    delete agent.hiddenAt;
  }
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

/** Grok Bot-style avatar shapes (all agents render one of these). */
export const AVATAR_SHAPES: readonly string[] = ["squircle", "teardrop", "pebble", "hex", "blob", "cloud", "wedge", "tablet"];

/** Grok Bot-style avatar color tokens (concrete hex values live in the web palette). */
export const AVATAR_COLORS: readonly string[] = ["red", "orange", "yellow", "green", "teal", "cyan", "blue", "indigo", "violet", "purple", "magenta", "pink", "brown", "olive", "gray", "slate"];

/** Alternate spellings accepted on input and mapped onto a canonical token. */
const AVATAR_COLOR_ALIASES: Record<string, string> = { grey: "gray" };

/** Cap for embedded avatar images (data URLs), roughly 256KB. */
const AVATAR_IMAGE_MAX_BYTES = 256 * 1024;

function sanitizeAvatarShape(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return AVATAR_SHAPES.includes(v) ? v : undefined;
}

function sanitizeAvatarColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  const normalized = AVATAR_COLOR_ALIASES[v] ?? v;
  return AVATAR_COLORS.includes(normalized) ? normalized : undefined;
}

function sanitizeAvatarImage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v) return undefined;
  if (!v.startsWith("data:image/") && !v.startsWith("/api/")) return undefined;
  if (Buffer.byteLength(v, "utf8") > AVATAR_IMAGE_MAX_BYTES) return undefined;
  return v;
}

/** Restrict avatar inputs to the known shape/color tokens and the supported image forms. */
export function sanitizeAvatarFields(input: { avatarShape?: unknown; avatarColor?: unknown; avatarImage?: unknown }): { avatarShape?: string; avatarColor?: string; avatarImage?: string } {
  const out: { avatarShape?: string; avatarColor?: string; avatarImage?: string } = {};
  const shape = sanitizeAvatarShape(input.avatarShape);
  const color = sanitizeAvatarColor(input.avatarColor);
  const image = sanitizeAvatarImage(input.avatarImage);
  if (shape) out.avatarShape = shape;
  if (color) out.avatarColor = color;
  if (image) out.avatarImage = image;
  return out;
}

export function createAgent(input: { name: string; emoji?: string; description?: string; instructions?: string; model?: string; mode?: string; effort?: string; disabledTools?: unknown; workMode?: string; allowedServices?: unknown; voice?: string; voiceRate?: number; voiceAuto?: boolean; source?: string; avatarShape?: string; avatarColor?: string; avatarImage?: string; pinned?: boolean; pinnedAt?: number; sortOrder?: number; title?: string; notifications?: boolean }): AgentRecord {
  const mode = input.mode ? getLoamMode(input.mode).id : undefined;
  const workMode = input.workMode ? normalizeWorkMode(input.workMode) : undefined;
  const wantsPin = (input.pinned === true) || typeof input.pinnedAt === "number";
  const pinSortOrder = typeof input.sortOrder === "number" && Number.isFinite(input.sortOrder)
    ? input.sortOrder
    : wantsPin
      ? nextPinSortOrder()
      : undefined;
  const now = new Date().toISOString();
  const agent: AgentRecord = {
    id: `agent_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
    name: input.name.trim().slice(0, 80),
    emoji: (input.emoji ?? "🤖").trim().slice(0, 8) || "🤖",
    description: (input.description ?? "").trim().slice(0, 300),
    ...(input.title && input.title.trim() ? { title: input.title.trim().slice(0, 80) } : {}),
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
    ...(typeof input.notifications === "boolean" ? { notifications: input.notifications } : {}),
    ...(input.source && input.source.trim() ? { source: input.source.trim().slice(0, 32) } : {}),
    ...sanitizeAvatarFields(input),
    ...(wantsPin ? { pinnedAt: typeof input.pinnedAt === "number" && Number.isFinite(input.pinnedAt) ? input.pinnedAt : Date.now() } : {}),
    ...(pinSortOrder !== undefined ? { sortOrder: pinSortOrder } : {}),
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

export function updateAgent(id: string, patch: { name?: string; emoji?: string; description?: string; title?: string | null; instructions?: string; model?: string | null; mode?: string | null; effort?: string | null; disabledTools?: unknown; workMode?: string | null; allowedServices?: unknown; voice?: string | null; voiceRate?: number | null; voiceAuto?: boolean | null; notifications?: boolean | null; avatarShape?: string | null; avatarColor?: string | null; avatarImage?: string | null; pinned?: boolean | null; pinnedAt?: number | null; sortOrder?: number | null }): AgentRecord | undefined {
  const agent = agents.find((a) => a.id === id);
  if (!agent) return undefined;
  const mode = typeof patch.mode === "string" ? getLoamMode(patch.mode).id : undefined;
  const workMode = typeof patch.workMode === "string" && patch.workMode.trim() ? normalizeWorkMode(patch.workMode) : undefined;
  if (typeof patch.name === "string" && patch.name.trim()) agent.name = patch.name.trim().slice(0, 80);
  if (typeof patch.emoji === "string" && patch.emoji.trim()) agent.emoji = patch.emoji.trim().slice(0, 8);
  if (typeof patch.description === "string") agent.description = patch.description.trim().slice(0, 300);
  if (patch.title === null) delete agent.title;
  else if (typeof patch.title === "string") {
    const title = patch.title.trim().slice(0, 80);
    if (title) agent.title = title;
    else delete agent.title;
  }
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
  if (patch.notifications !== undefined) {
    if (patch.notifications === null) delete agent.notifications;
    else if (typeof patch.notifications === "boolean") agent.notifications = patch.notifications;
  }
  if (patch.allowedServices !== undefined) {
    const s = sanitizeServices(patch.allowedServices);
    if (s.allowedServices) agent.allowedServices = s.allowedServices;
    else delete agent.allowedServices;
  }
  for (const field of ["avatarShape", "avatarColor", "avatarImage"] as const) {
    if (patch[field] === null) delete agent[field];
  }
  {
    const s = sanitizeAvatarFields(patch);
    if (s.avatarShape) agent.avatarShape = s.avatarShape;
    if (s.avatarColor) agent.avatarColor = s.avatarColor;
    if (s.avatarImage) agent.avatarImage = s.avatarImage;
  }
  if (patch.pinned === true && !isPinned(agent)) {
    agent.pinnedAt = Date.now();
    agent.sortOrder = nextPinSortOrder();
  }
  if (patch.pinnedAt !== undefined) {
    if (patch.pinnedAt === null) delete agent.pinnedAt;
    else if (Number.isFinite(Number(patch.pinnedAt))) agent.pinnedAt = Number(patch.pinnedAt);
  }
  if (patch.sortOrder !== undefined) {
    if (patch.sortOrder === null) delete agent.sortOrder;
    else if (Number.isFinite(Number(patch.sortOrder))) agent.sortOrder = Number(patch.sortOrder);
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