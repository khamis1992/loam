/**
 * Shared, scan-scoped threat model (Strix `tools/threat_model` parity).
 *
 * Every agent of one task reads and amends the same model: the attacker, the
 * trust boundaries and the critical assets are the frame the fleet tests
 * against, and an agent that disproves an assumption amends it instead of
 * re-deriving its own. One JSON document per task keeps the writes atomic and
 * the read cheap.
 */
import { database, transaction } from "./sqliteStore.js";

export const MAX_ITEMS = 40;
export const MAX_TEXT = 600;

export interface ThreatActor {
  name: string;
  description: string;
  /** What the actor can already do (authenticated? on-network? local?). */
  capability: string;
}

export interface ThreatAsset {
  name: string;
  /** Path, endpoint, package or service that holds the asset. */
  where: string;
  criticality: "critical" | "high" | "medium" | "low";
  notes?: string;
}

export interface TrustBoundary {
  from: string;
  to: string;
  notes?: string;
}

export interface ThreatModel {
  taskId: string;
  summary: string;
  actors: ThreatActor[];
  assets: ThreatAsset[];
  boundaries: TrustBoundary[];
  assumptions: string[];
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ThreatModelInput {
  summary?: unknown;
  actors?: unknown;
  assets?: unknown;
  boundaries?: unknown;
  assumptions?: unknown;
  notes?: unknown;
}

function ensureTable(): void {
  database().exec(`CREATE TABLE IF NOT EXISTS threat_models (
    task_id TEXT PRIMARY KEY,
    model_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
}

ensureTable();

function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function strings(value: unknown, max = MAX_ITEMS): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item)).filter((item) => item.length > 0).slice(0, max);
}

function actors(value: unknown): ThreatActor[] {
  if (!Array.isArray(value)) return [];
  const out: ThreatActor[] = [];
  for (const raw of value.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const name = text(item.name, 120);
    if (!name) continue;
    out.push({ name, description: text(item.description), capability: text(item.capability, 200) });
  }
  return out;
}

function assets(value: unknown): ThreatAsset[] {
  if (!Array.isArray(value)) return [];
  const levels = new Set(["critical", "high", "medium", "low"]);
  const out: ThreatAsset[] = [];
  for (const raw of value.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const name = text(item.name, 160);
    if (!name) continue;
    const criticality = text(item.criticality, 10).toLowerCase();
    out.push({
      name,
      where: text(item.where, 300),
      criticality: (levels.has(criticality) ? criticality : "medium") as ThreatAsset["criticality"],
      ...(text(item.notes) ? { notes: text(item.notes) } : {}),
    });
  }
  return out;
}

function boundaries(value: unknown): TrustBoundary[] {
  if (!Array.isArray(value)) return [];
  const out: TrustBoundary[] = [];
  for (const raw of value.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const from = text(item.from, 160);
    const to = text(item.to, 160);
    if (!from || !to) continue;
    out.push({ from, to, ...(text(item.notes) ? { notes: text(item.notes) } : {}) });
  }
  return out;
}

function merge<T>(current: T[], incoming: T[], key: (item: T) => string): T[] {
  const byKey = new Map(current.map((item) => [key(item), item] as const));
  for (const item of incoming) byKey.set(key(item), item);
  return [...byKey.values()].slice(0, MAX_ITEMS);
}

function rowToModel(row: Record<string, unknown>): ThreatModel {
  const parsed = JSON.parse(String(row.model_json)) as Partial<ThreatModel>;
  return {
    taskId: String(row.task_id),
    summary: parsed.summary ?? "",
    actors: parsed.actors ?? [],
    assets: parsed.assets ?? [],
    boundaries: parsed.boundaries ?? [],
    assumptions: parsed.assumptions ?? [],
    notes: parsed.notes ?? [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function emptyModel(taskId: string, now: string): ThreatModel {
  return { taskId, summary: "", actors: [], assets: [], boundaries: [], assumptions: [], notes: [], createdAt: now, updatedAt: now };
}

/** The task's model, or a fresh empty one (never persisted by a read). */
export function getThreatModel(taskId: string): ThreatModel {
  const row = database()
    .prepare("SELECT task_id, model_json, created_at, updated_at FROM threat_models WHERE task_id = ?")
    .get(taskId) as Record<string, unknown> | undefined;
  return row ? rowToModel(row) : emptyModel(taskId, new Date().toISOString());
}

/**
 * Save a model. `replace` overwrites the document; `amend` merges actors,
 * assets and boundaries by name (incoming wins) and appends assumptions/notes.
 */
export function saveThreatModel(taskId: string, input: ThreatModelInput, mode: "replace" | "amend"): ThreatModel {
  const now = new Date().toISOString();
  const existing = getThreatModel(taskId);
  const next: ThreatModel = mode === "replace"
    ? {
        ...emptyModel(taskId, existing.createdAt || now),
        summary: text(input.summary, 2000),
        actors: actors(input.actors),
        assets: assets(input.assets),
        boundaries: boundaries(input.boundaries),
        assumptions: strings(input.assumptions),
        notes: strings(input.notes),
        updatedAt: now,
      }
    : {
        ...existing,
        summary: text(input.summary, 2000) || existing.summary,
        actors: merge(existing.actors, actors(input.actors), (item) => item.name.toLowerCase()),
        assets: merge(existing.assets, assets(input.assets), (item) => item.name.toLowerCase()),
        boundaries: merge(existing.boundaries, boundaries(input.boundaries), (item) => `${item.from}->${item.to}`.toLowerCase()),
        assumptions: [...existing.assumptions, ...strings(input.assumptions)].slice(-MAX_ITEMS),
        notes: [...existing.notes, ...strings(input.notes)].slice(-MAX_ITEMS),
        updatedAt: now,
      };
  transaction(() => {
    const db = database();
    const createdAt = next.createdAt || now;
    db.prepare(
      `INSERT INTO threat_models (task_id, model_json, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET model_json = excluded.model_json, updated_at = excluded.updated_at`,
    ).run(taskId, JSON.stringify({ ...next, createdAt }), createdAt, now);
  });
  return { ...next, createdAt: next.createdAt || now };
}

/** Human-readable rendering for the tool result. */
export function formatThreatModel(model: ThreatModel): string {
  const lines: string[] = [`Threat model for ${model.taskId} (updated ${model.updatedAt})`];
  if (model.summary) lines.push("", model.summary);
  if (model.actors.length) {
    lines.push("", "Actors:");
    for (const a of model.actors) lines.push(`- ${a.name} [${a.capability || "capability unstated"}] ${a.description}`);
  }
  if (model.assets.length) {
    lines.push("", "Assets:");
    for (const a of model.assets) lines.push(`- ${a.name} (${a.criticality})${a.where ? ` at ${a.where}` : ""}${a.notes ? ` — ${a.notes}` : ""}`);
  }
  if (model.boundaries.length) {
    lines.push("", "Trust boundaries:");
    for (const b of model.boundaries) lines.push(`- ${b.from} -> ${b.to}${b.notes ? ` (${b.notes})` : ""}`);
  }
  if (model.assumptions.length) {
    lines.push("", "Assumptions:");
    for (const a of model.assumptions) lines.push(`- ${a}`);
  }
  if (model.notes.length) {
    lines.push("", "Notes:");
    for (const n of model.notes) lines.push(`- ${n}`);
  }
  if (!model.actors.length && !model.assets.length && !model.boundaries.length) lines.push("", "(empty model — save one before testing)");
  return lines.join("\n");
}

export function clearThreatModel(taskId: string): void {
  database().prepare("DELETE FROM threat_models WHERE task_id = ?").run(taskId);
}
