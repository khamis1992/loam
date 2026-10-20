import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import { log } from "../log.js";
import { detectModeFromText } from "../modes/detect.js";
import { createAgent, getAgent, listAgents, type AgentRecord } from "./agents.js";
import { remember } from "./companionMemory.js";
import { addSchedule } from "./db.js";
import { database } from "./sqliteStore.js";

export type MarketplaceSource = "xai" | "botdirectory";

export interface MarketplaceSkill {
  name: string;
  description: string;
  content: string;
}

export interface MarketplaceRoutine {
  name: string;
  summary: string;
}

export interface MarketplaceAuthor {
  name?: string;
  handle?: string;
  url?: string;
  scoutedBy?: string;
}

export interface MarketplaceCatalogEntry {
  id: string;
  source: MarketplaceSource[];
  name: string;
  description: string;
  category: string;
  tags: string[];
  icon: string;
  iconStyle: { color?: string; shape?: string; monogram?: string; categoryColor?: string };
  instructions: string;
  tools: string[];
  toolUrls?: Record<string, string>;
  skills: MarketplaceSkill[];
  memories: string[];
  routines: MarketplaceRoutine[];
  author: MarketplaceAuthor;
  installCount?: number;
  addedAt?: string;
  updatedAt?: string;
  addHref?: string;
  grokShareUrl?: string;
  homepage?: string;
  sourceUrl: string;
  alsoAt?: string[];
  license: string;
}

export interface MarketplaceInstall {
  catalogId: string;
  agentId: string;
  addedAt: string;
  catalogVersion: string;
}

const CATALOG_CANDIDATES = [
  path.join(ROOT, "packages", "web", "public", "marketplace", "catalog.json"),
  path.join(ROOT, "ui", "marketplace", "catalog.json"),
  path.join(ROOT, "public", "marketplace", "catalog.json"),
  path.join(process.cwd(), "packages", "web", "public", "marketplace", "catalog.json"),
];

let catalogCache: { entries: MarketplaceCatalogEntry[]; version: string; at: number } | undefined;

function catalogPath(): string | undefined {
  for (const candidate of CATALOG_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function ensureInstallsTable(): void {
  database().exec(`CREATE TABLE IF NOT EXISTS marketplace_installs (
    catalog_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    added_at TEXT NOT NULL,
    catalog_version TEXT NOT NULL
  );`);
}

ensureInstallsTable();

/** Load and validate the bundled catalog. Results are cached for the process. */
export function loadMarketplaceCatalog(): { entries: MarketplaceCatalogEntry[]; version: string } {
  if (catalogCache && Date.now() - catalogCache.at < 5 * 60_000) {
    return { entries: catalogCache.entries, version: catalogCache.version };
  }
  const file = catalogPath();
  if (!file) {
    log.warn("marketplace: catalog.json not found");
    return { entries: [], version: "missing" };
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("catalog root must be an array");
    const entries = parsed.filter(isCatalogEntry);
    const version = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
    catalogCache = { entries, version, at: Date.now() };
    return { entries, version };
  } catch (err) {
    log.warn(`marketplace: failed to load catalog: ${err instanceof Error ? err.message : String(err)}`);
    return { entries: [], version: "error" };
  }
}

function isCatalogEntry(value: unknown): value is MarketplaceCatalogEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.name === "string" && Array.isArray(v.source);
}

export function getMarketplaceEntry(catalogId: string): MarketplaceCatalogEntry | undefined {
  return loadMarketplaceCatalog().entries.find((entry) => entry.id === catalogId);
}

function rowToInstall(row: { catalog_id: string; agent_id: string; added_at: string; catalog_version: string }): MarketplaceInstall {
  return {
    catalogId: row.catalog_id,
    agentId: row.agent_id,
    addedAt: row.added_at,
    catalogVersion: row.catalog_version,
  };
}

export function getInstall(catalogId: string): MarketplaceInstall | undefined {
  const row = database()
    .prepare("SELECT catalog_id, agent_id, added_at, catalog_version FROM marketplace_installs WHERE catalog_id = ?")
    .get(catalogId) as { catalog_id: string; agent_id: string; added_at: string; catalog_version: string } | undefined;
  return row ? rowToInstall(row) : undefined;
}

/** Installs whose agent still exists and is not archived. Stale rows are pruned. */
export function listActiveInstalls(): MarketplaceInstall[] {
  const rows = database()
    .prepare("SELECT catalog_id, agent_id, added_at, catalog_version FROM marketplace_installs ORDER BY added_at DESC")
    .all() as Array<{ catalog_id: string; agent_id: string; added_at: string; catalog_version: string }>;
  const active: MarketplaceInstall[] = [];
  for (const row of rows) {
    const agent = getAgent(row.agent_id);
    if (!agent || agent.archivedAt) {
      database().prepare("DELETE FROM marketplace_installs WHERE catalog_id = ?").run(row.catalog_id);
      continue;
    }
    active.push(rowToInstall(row));
  }
  return active;
}

function recordInstall(catalogId: string, agentId: string, catalogVersion: string): MarketplaceInstall {
  const addedAt = new Date().toISOString();
  database()
    .prepare(
      "INSERT INTO marketplace_installs (catalog_id, agent_id, added_at, catalog_version) VALUES (?, ?, ?, ?) ON CONFLICT(catalog_id) DO UPDATE SET agent_id = excluded.agent_id, added_at = excluded.added_at, catalog_version = excluded.catalog_version",
    )
    .run(catalogId, agentId, addedAt, catalogVersion);
  return { catalogId, agentId, addedAt, catalogVersion };
}

function clearInstall(catalogId: string): void {
  database().prepare("DELETE FROM marketplace_installs WHERE catalog_id = ?").run(catalogId);
}

/** Append " 2", " 3", ... until the name is free among active agents. */
export function uniqueAgentName(base: string, existing: string[] = listAgents(true).map((a) => a.name)): string {
  const clean = base.trim().slice(0, 80) || "Marketplace bot";
  const taken = new Set(existing.map((name) => name.trim().toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  let suffix = 2;
  while (suffix < 1000) {
    const candidate = `${clean} ${suffix}`.slice(0, 80);
    if (!taken.has(candidate.toLowerCase())) return candidate;
    suffix += 1;
  }
  return `${clean} ${Date.now().toString(36)}`.slice(0, 80);
}

const CATEGORY_EMOJI: Record<string, string> = {
  Productivity: "🗂️",
  Sales: "📈",
  Marketing: "📣",
  Operations: "⚙️",
  Ops: "⚙️",
  "Customer Success": "🤝",
  Success: "🤝",
  Personal: "🌱",
  Design: "🎨",
  Engineering: "🛠️",
  Product: "🧭",
  "Recruiting & People": "🧑‍💼",
  "From Grok Bot Team": "🤖",
};

export function entryEmoji(entry: MarketplaceCatalogEntry): string {
  return CATEGORY_EMOJI[entry.category] ?? "🤖";
}

/** bd entries carry the prompt body; x.ai entries are composed from public fields. */
export function composeInstructions(entry: MarketplaceCatalogEntry): string {
  const direct = (entry.instructions ?? "").trim();
  if (direct) return direct.slice(0, 8000);
  const parts: string[] = [];
  const description = (entry.description ?? "").trim();
  if (description) parts.push(description);
  if (entry.skills.length > 0) {
    parts.push("## Skills");
    for (const skill of entry.skills) {
      const name = (skill.name ?? "").trim();
      const desc = (skill.description ?? "").trim();
      const content = (skill.content ?? "").trim();
      const lines = [name ? `### ${name}` : "", desc, content && content !== desc ? content : ""].filter(Boolean);
      if (lines.length > 0) parts.push(lines.join("\n\n"));
    }
  }
  if (entry.memories.length > 0) {
    parts.push("## Memory");
    parts.push(entry.memories.map((m) => `- ${m.trim()}`).join("\n"));
  }
  return parts.join("\n\n").trim().slice(0, 8000);
}

/** Map a marketplace category/toolset onto an existing Loam mode. */
export function resolveMarketplaceMode(entry: MarketplaceCatalogEntry): string {
  const category = (entry.category ?? "").toLowerCase();
  if (category === "engineering") return "build";
  if (category === "design") return "media";
  const tools = entry.tools.join(" ").toLowerCase();
  if (/\b(excel|spreadsheet|sheets|dataset|csv)\b/.test(tools)) return "data";
  if (/\b(word|docs|slides|presentation|powerpoint|deck)\b/.test(tools)) return "write";
  return detectModeFromText(`${entry.category} ${entry.description} ${entry.tools.join(" ")}`);
}

function seedMemory(agentId: string, entry: MarketplaceCatalogEntry): void {
  const memories = entry.memories
    .map((text) => (text ?? "").trim())
    .filter(Boolean)
    .slice(0, 5);
  for (const text of memories) {
    try {
      remember(agentId, { text, kind: "fact", source: "companion", confidence: 0.7 });
    } catch (err) {
      log.warn(`marketplace: memory seed failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function seedRoutines(agentId: string, entry: MarketplaceCatalogEntry): void {
  for (const routine of entry.routines.slice(0, 8)) {
    const name = (routine.name ?? "").trim();
    const summary = (routine.summary ?? "").trim();
    const prompt = [name, summary && summary !== name ? `- ${summary}` : ""].filter(Boolean).join("\n");
    if (!prompt) continue;
    try {
      addSchedule(prompt.slice(0, 4000), 86_400, agentId, undefined, undefined, undefined, false);
    } catch (err) {
      log.warn(`marketplace: routine seed failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export interface InstallResult {
  agent: AgentRecord;
  already: boolean;
  install: MarketplaceInstall;
}

/**
 * One-click install. Idempotent by catalog id: an existing active install
 * returns its agent. Archived agents are treated as removed, so a later Add
 * creates a fresh agent instead of resurrecting the archived one.
 */
export function installFromCatalog(catalogId: string): InstallResult | { error: string; status: number } {
  const entry = getMarketplaceEntry(catalogId);
  if (!entry) return { error: "catalog entry not found", status: 404 };

  const existing = getInstall(catalogId);
  if (existing) {
    const agent = getAgent(existing.agentId);
    if (agent && !agent.archivedAt) return { agent, already: true, install: existing };
    clearInstall(catalogId);
  }

  const { version } = loadMarketplaceCatalog();
  const agent = createAgent({
    name: uniqueAgentName(entry.name),
    emoji: entryEmoji(entry),
    description: entry.description,
    instructions: composeInstructions(entry),
    mode: resolveMarketplaceMode(entry),
  });

  seedMemory(agent.id, entry);
  seedRoutines(agent.id, entry);
  const install = recordInstall(catalogId, agent.id, version);
  log.info(`marketplace: installed ${entry.name} as ${agent.name} (${agent.id})`);
  return { agent, already: false, install };
}

/** Test helper: drop cached catalog so fixtures are re-read. */
export function resetMarketplaceCache(): void {
  catalogCache = undefined;
}
