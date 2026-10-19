/**
 * Companion personal memory (frontier stage 4a).
 *
 * A manageable, per-companion memory store — separate from task memory and from
 * other companions. Every entry records its source (user said it vs the
 * companion inferred it), timestamp and confidence; entries can be reviewed,
 * edited, superseded (contradiction handling), expired, exported and imported.
 * Nothing crosses between companions: the store is keyed by agentId and tools
 * are bound per-run to that agent only.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../config.js";
import { log } from "../log.js";

export type MemoryKind = "preference" | "fact" | "instruction" | "inference";
export type MemorySource = "user" | "companion";

export interface MemoryEntry {
  id: string;
  text: string;
  kind: MemoryKind;
  source: MemorySource;
  taskId?: string;
  at: string;
  updatedAt?: string;
  /** 0..1 — how confident the companion is in this entry. */
  confidence: number;
  expiresAt?: string;
  /** Set when a newer entry contradicted and replaced this one. */
  supersededBy?: string;
  editHistory?: Array<{ at: string; text: string }>;
  /** Lazy semantic vector (present only while an embedder is wired). */
  embedding?: number[];
  /** Team-store entries record which companion wrote them. */
  ownerAgentId?: string;
}

const ROOT = path.join(DATA_DIR, "companion-memory");
const VALID_KINDS: MemoryKind[] = ["preference", "fact", "instruction", "inference"];
/** Shared team scope: readable by every companion, writes record their owner. */
const TEAM_SCOPE = "team";

function fileFor(agentId: string): string {
  return path.join(ROOT, `${agentId.replace(/[^\w-]/g, "_")}.json`);
}

/* ---------------- semantic search (embeddings, optional) ---------------- */

export interface MemoryEmbedder {
  embed(texts: string[]): Promise<number[][]>;
}

let embedder: MemoryEmbedder | undefined;

/** Wire the app embedder at boot (runtime.ts/index.ts). Absent → text-only search. */
export function setMemoryEmbedder(instance?: MemoryEmbedder): void {
  embedder = instance;
}

export function memoryEmbedderActive(): boolean {
  return embedder !== undefined;
}

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

async function embedSafe(texts: string[]): Promise<number[][]> {
  if (!embedder) return [];
  try {
    return await embedder.embed(texts);
  } catch {
    return [];
  }
}

async function ensureEmbeddings(entries: MemoryEntry[]): Promise<void> {
  if (!embedder) return;
  const missing = entries.filter((e) => !e.embedding);
  if (missing.length === 0) return;
  const vectors = await embedSafe(missing.map((e) => e.text));
  if (vectors.length !== missing.length) return;
  missing.forEach((e, i) => {
    if (vectors[i]?.length) e.embedding = vectors[i];
  });
}

export interface MemorySearchHit {
  entry: MemoryEntry;
  score?: number;
  /** Where the hit came from: the companion's own store or the shared team store. */
  scope: "own" | "team";
}

/** Unified search: exact/substring matches first, then semantic neighbors when
 *  embeddings are active. Falls back honestly to text-only otherwise. */
export async function searchMemory(agentId: string, query: MemoryQuery & { semantic?: boolean } = {}): Promise<{ mode: "semantic" | "text"; hits: MemorySearchHit[] }> {
  // The candidate pool ignores q (semantic ranking must see entries a substring
  // search would miss); text mode filters the same pool by substring.
  const pool: MemoryQuery = { kind: query.kind, includeInactive: query.includeInactive };
  const ownHits: MemorySearchHit[] = listMemory(agentId, pool).map((entry) => ({ entry, scope: "own" as const }));
  const team: MemorySearchHit[] = query.includeTeam === false ? [] : listMemory(TEAM_SCOPE, pool).map((entry) => ({ entry, scope: "team" as const }));
  const all = [...ownHits, ...team];
  const q = (query.q ?? "").trim();
  const textualHits = (): MemorySearchHit[] => (q ? all.filter((h) => h.entry.text.toLowerCase().includes(q.toLowerCase())) : all);
  if (!embedder || !query.semantic || !q) {
    return { mode: "text", hits: textualHits() };
  }
  const candidates = all.filter((h) => !h.entry.supersededBy && !isExpired(h.entry));
  // Embeddings are computed per-search (not persisted) so switching embed models
  // never leaves stale vectors behind.
  await ensureEmbeddings(candidates.map((h) => h.entry));
  const [qv] = await embedSafe([q]);
  if (!qv?.length || candidates.every((h) => !h.entry.embedding?.length)) {
    return { mode: "text", hits: textualHits() };
  }
  const scored = candidates
    .filter((h) => h.entry.embedding?.length)
    .map((h) => ({ hit: h, score: cosine(qv, h.entry.embedding!) }))
    .filter((x) => x.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .map((x) => ({ ...x.hit, score: x.score }));
  const textual = textualHits().filter((h) => !scored.some((s) => s.entry.id === h.entry.id));
  return { mode: "semantic", hits: [...textual, ...scored] };
}

function readAll(agentId: string): MemoryEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(agentId), "utf8")) as { entries?: MemoryEntry[] };
    return (raw.entries ?? []).filter((e) => e && typeof e.id === "string" && typeof e.text === "string");
  } catch {
    return [];
  }
}

function saveAll(agentId: string, entries: MemoryEntry[]): void {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    const tmp = `${fileFor(agentId)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ agentId, entries }, null, 1), "utf8");
    fs.renameSync(tmp, fileFor(agentId));
  } catch (err) {
    log.warn(`companion-memory: save failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const isExpired = (e: MemoryEntry): boolean => Boolean(e.expiresAt && Date.parse(e.expiresAt) < Date.now());

export function remember(agentId: string, input: { text: string; kind?: string; source?: string; taskId?: string; confidence?: number; ttlDays?: number; expiresAt?: string; supersededBy?: string }): MemoryEntry | { error: string } {
  const text = (input.text ?? "").trim().slice(0, 2000);
  if (!text) return { error: "نص الذكرى مطلوب" };
  const kind = (VALID_KINDS as string[]).includes(input.kind ?? "") ? (input.kind as MemoryKind) : "fact";
  const source = input.source === "user" || input.source === "companion" ? input.source : "companion";
  const confidence = Math.max(0, Math.min(1, Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0.8));
  const ttl = Number(input.ttlDays);
  const entry: MemoryEntry = {
    id: `mem_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
    text,
    kind,
    source,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    at: new Date().toISOString(),
    confidence,
    ...(Number.isFinite(ttl) && ttl > 0 ? { expiresAt: new Date(Date.now() + ttl * 86_400_000).toISOString() } : {}),
    // Identity import restores lifecycle fields as they were exported, not recomputed.
    ...(typeof input.expiresAt === "string" && input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(typeof input.supersededBy === "string" && input.supersededBy ? { supersededBy: input.supersededBy } : {}),
  };
  const entries = readAll(agentId);
  if (entries.length >= 500) return { error: "ذاكرة هذا المساعد ممتلئة (500 ذكرى) — راجعها واحذف القديم أولًا" };
  entries.push(entry);
  saveAll(agentId, entries);
  return entry;
}

export interface MemoryQuery {
  q?: string;
  kind?: string;
  /** Include superseded and expired entries (review mode). */
  includeInactive?: boolean;
  /** Team-store hits are included unless explicitly disabled. */
  includeTeam?: boolean;
}

export function listMemory(agentId: string, query: MemoryQuery = {}): MemoryEntry[] {
  const q = (query.q ?? "").trim().toLowerCase();
  return readAll(agentId)
    .filter((e) => (query.includeInactive ? true : !e.supersededBy && !isExpired(e)))
    .filter((e) => (query.kind && (VALID_KINDS as string[]).includes(query.kind) ? e.kind === query.kind : true))
    .filter((e) => (q ? e.text.toLowerCase().includes(q) : true))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Shared team memory: every companion can read it; writes record their owner. */
export function rememberShared(ownerAgentId: string, input: { text: string; kind?: string; confidence?: number; taskId?: string }): MemoryEntry | { error: string } {
  const created = remember(TEAM_SCOPE, { ...input, source: "companion" });
  if ("error" in created) return created;
  const entries = readAll(TEAM_SCOPE);
  const entry = entries.find((e) => e.id === created.id);
  if (entry) {
    entry.ownerAgentId = ownerAgentId;
    saveAll(TEAM_SCOPE, entries);
  }
  return { ...created, ownerAgentId: ownerAgentId };
}

export function listTeamMemory(query: MemoryQuery = {}): Array<MemoryEntry & { ownerAgentId?: string }> {
  return listMemory(TEAM_SCOPE, query);
}

/** Preferences + instructions to inject as run context (bounded). */export function memoryContext(agentId: string, limit = 6): MemoryEntry[] {
  return listMemory(agentId)
    .filter((e) => e.kind === "preference" || e.kind === "instruction")
    .filter((e) => e.source === "user" || e.confidence >= 0.7)
    .slice(0, limit);
}

export function editMemory(agentId: string, id: string, patch: { text?: string; confidence?: number; kind?: string }): MemoryEntry | { error: string } {
  const entries = readAll(agentId);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return { error: "الذكرى غير موجودة" };
  entry.editHistory = [...(entry.editHistory ?? []), { at: entry.updatedAt ?? entry.at, text: entry.text }];
  if (typeof patch.text === "string" && patch.text.trim()) entry.text = patch.text.trim().slice(0, 2000);
  if (Number.isFinite(Number(patch.confidence))) entry.confidence = Math.max(0, Math.min(1, Number(patch.confidence)));
  if ((VALID_KINDS as string[]).includes(patch.kind ?? "")) entry.kind = patch.kind as MemoryKind;
  entry.updatedAt = new Date().toISOString();
  saveAll(agentId, entries);
  return entry;
}

/** Contradiction handling: mark the old entry superseded and record the replacement. */
export function supersedeMemory(agentId: string, id: string, newText: string, opts: { source?: string; confidence?: number } = {}): { old: MemoryEntry; next: MemoryEntry } | { error: string } {
  const entries = readAll(agentId);
  const old = entries.find((e) => e.id === id);
  if (!old) return { error: "الذكرى غير موجودة" };
  const created = remember(agentId, { text: newText, kind: old.kind, source: opts.source ?? "user", confidence: opts.confidence ?? 0.9 });
  if ("error" in created) return created;
  const fresh = readAll(agentId);
  const oldNow = fresh.find((e) => e.id === id)!;
  const nextNow = fresh.find((e) => e.id === created.id)!;
  oldNow.supersededBy = created.id;
  oldNow.updatedAt = new Date().toISOString();
  saveAll(agentId, fresh);
  return { old: oldNow, next: nextNow };
}

export function forget(agentId: string, id: string): boolean {
  const entries = readAll(agentId);
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  saveAll(agentId, next);
  return true;
}

export function exportMemory(agentId: string): string {
  return JSON.stringify({ agentId, exportedAt: new Date().toISOString(), entries: readAll(agentId) }, null, 1);
}

export function importMemory(agentId: string, raw: string): { imported: number; skipped: number } | { error: string } {
    // Phase 1: parse and validate; Phase 2: import with ID remapping so
    // supersession links (supersededBy) survive across agents/installs.
  let parsed: { entries?: unknown };
  try {
    parsed = JSON.parse(raw) as { entries?: unknown };
  } catch {
    return { error: "ملف الاستيراد ليس JSON سليمًا" };
  }
  if (!Array.isArray(parsed.entries)) return { error: "الملف لا يحتوي قائمة entries" };
  const existing = new Set(readAll(agentId).map((e) => e.id));
  const additions: MemoryEntry[] = [];
  let skipped = 0;
  for (const item of parsed.entries) {
    const e = item as MemoryEntry;
    if (!e || typeof e.id !== "string" || typeof e.text !== "string" || existing.has(e.id) || additions.some((a) => a.id === e.id)) {
      skipped += 1;
      continue;
    }
    existing.add(e.id);
    additions.push({
      id: e.id,
      text: String(e.text).slice(0, 2000),
      kind: (VALID_KINDS as string[]).includes(e.kind) ? e.kind : "fact",
      source: e.source === "user" ? "user" : "companion",
      ...(e.taskId ? { taskId: String(e.taskId).slice(0, 60) } : {}),
      at: typeof e.at === "string" ? e.at : new Date().toISOString(),
      ...(e.updatedAt ? { updatedAt: e.updatedAt } : {}),
      confidence: Math.max(0, Math.min(1, Number.isFinite(Number(e.confidence)) ? Number(e.confidence) : 0.5)),
      ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}),
      ...(e.supersededBy ? { supersededBy: e.supersededBy } : {}),
    });
  }
  if (additions.length > 0) {
    // Remap old entry IDs to new ones so supersededBy links survive import.
    const idMap = new Map<string, string>();
    const remapped = additions.map((e) => {
      const newId = e.id.startsWith("mem_") ? e.id : `mem_imp_${crypto.randomBytes(4).toString("hex")}_${e.id}`;
      idMap.set(e.id, newId);
      return { ...e, id: newId };
    });
    for (const e of remapped) {
      if (e.supersededBy && idMap.has(e.supersededBy)) e.supersededBy = idMap.get(e.supersededBy)!;
    }
    saveAll(agentId, [...readAll(agentId), ...remapped]);
  }
  return { imported: additions.length, skipped };
}
