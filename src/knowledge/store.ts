/**
 * Neo N3: Knowledge Garden persistence.
 *
 * The garden is stored in the existing `entities` table (one row per base,
 * payload = the whole base as JSON). This keeps the module dependency-free: no
 * new schema, no migration, no second database to back up. Bases hold up to a
 * few thousand seeds in practice, which is well within a single row's size, and
 * search already reads every base anyway, so per-seed rows would buy nothing but
 * write amplification.
 */
import crypto from "node:crypto";
import { allEntities, getEntity, putEntity, removeEntity, transaction } from "../server/sqliteStore.js";
import { normalizeTags } from "./text.js";
import type {
  KnowledgeBase,
  KnowledgeBaseSummary,
  KnowledgeSeed,
} from "./types.js";

const ENTITY_KIND = "knowledge_base";

export function newBaseId(name: string): string {
  const slug = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return `kb-${slug || "base"}-${crypto.randomBytes(3).toString("hex")}`;
}

export function newSeedId(): string {
  return `seed-${crypto.randomBytes(4).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Every base in creation order (newest first from the store, re-sorted here). */
export function allBases(): KnowledgeBase[] {
  return allEntities<KnowledgeBase>(ENTITY_KIND).sort((a, b) => a.name.localeCompare(b.name));
}

export function getBase(id: string): KnowledgeBase | undefined {
  return getEntity<KnowledgeBase>(ENTITY_KIND, id);
}

export function findBaseByName(name: string): KnowledgeBase | undefined {
  const wanted = name.trim().toLowerCase();
  return allBases().find((b) => b.name.toLowerCase() === wanted);
}

function toSummary(base: KnowledgeBase): KnowledgeBaseSummary {
  return {
    id: base.id,
    name: base.name,
    description: base.description,
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
    seeds: base.seeds.length,
  };
}

export function listBases(): KnowledgeBaseSummary[] {
  return allBases().map(toSummary);
}

export function createBase(name: string, description?: string, id?: string): KnowledgeBase {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("knowledge base name is required");
  if (findBaseByName(trimmed)) throw new Error(`knowledge base "${trimmed}" already exists`);
  const base: KnowledgeBase = {
    id: id ?? newBaseId(trimmed),
    name: trimmed,
    description: description?.trim() || undefined,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    seeds: [],
  };
  putEntity(ENTITY_KIND, base);
  return base;
}

/** Create the base if missing, else return the existing one. */
export function ensureBase(name: string, description?: string, id?: string): { base: KnowledgeBase; created: boolean } {
  const existing = id ? getBase(id) : undefined;
  if (existing) return { base: existing, created: false };
  const byName = findBaseByName(name);
  if (byName) return { base: byName, created: false };
  return { base: createBase(name, description, id), created: true };
}

/** Rename/re-description; never touches seeds. */
export function updateBase(id: string, patch: { name?: string; description?: string }): KnowledgeBase {
  const base = getBase(id);
  if (!base) throw new Error(`knowledge base ${id} not found`);
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new Error("knowledge base name is required");
    const clash = findBaseByName(trimmed);
    if (clash && clash.id !== id) throw new Error(`knowledge base "${trimmed}" already exists`);
    base.name = trimmed;
  }
  if (patch.description !== undefined) base.description = patch.description.trim() || undefined;
  base.updatedAt = nowIso();
  putEntity(ENTITY_KIND, base);
  return base;
}

/** Delete a base and every seed it holds. */
export function deleteBase(id: string): boolean {
  return removeEntity(ENTITY_KIND, id);
}

function requireBase(id: string): KnowledgeBase {
  const base = getBase(id);
  if (!base) throw new Error(`knowledge base ${id} not found`);
  return base;
}

/**
 * Insert or replace one seed (matched by id). Tags are normalized; the updatedAt
 * of the base moves whenever its contents change.
 */
export function upsertSeed(baseId: string, seed: KnowledgeSeed): KnowledgeSeed {
  return transaction(() => {
    const base = requireBase(baseId);
    const normalized: KnowledgeSeed = {
      ...seed,
      id: seed.id || newSeedId(),
      tags: normalizeTags(seed.tags),
      title: seed.title.trim() || "Untitled",
      body: seed.body,
      updatedAt: nowIso(),
    };
    const at = base.seeds.findIndex((s) => s.id === normalized.id);
    if (at >= 0) {
      const previous = base.seeds[at];
      if (previous) normalized.createdAt = previous.createdAt || normalized.createdAt;
      base.seeds[at] = normalized;
    } else {
      normalized.createdAt = normalized.createdAt || nowIso();
      base.seeds.push(normalized);
    }
    base.updatedAt = nowIso();
    putEntity(ENTITY_KIND, base);
    return normalized;
  });
}

export function upsertSeeds(baseId: string, seeds: KnowledgeSeed[]): KnowledgeSeed[] {
  return transaction(() => {
    const base = requireBase(baseId);
    const added: KnowledgeSeed[] = [];
    for (const seed of seeds) {
      const normalized: KnowledgeSeed = {
        ...seed,
        id: seed.id || newSeedId(),
        tags: normalizeTags(seed.tags),
        title: seed.title.trim() || "Untitled",
        updatedAt: nowIso(),
        createdAt: seed.createdAt || nowIso(),
      };
      const at = base.seeds.findIndex((s) => s.id === normalized.id);
      if (at >= 0) {
        const previous = base.seeds[at];
        base.seeds[at] = { ...normalized, createdAt: previous?.createdAt || normalized.createdAt };
      } else base.seeds.push(normalized);
      added.push(normalized);
    }
    base.updatedAt = nowIso();
    putEntity(ENTITY_KIND, base);
    return added;
  });
}

export function deleteSeed(baseId: string, seedId: string): boolean {
  return transaction(() => {
    const base = requireBase(baseId);
    const before = base.seeds.length;
    base.seeds = base.seeds.filter((s) => s.id !== seedId);
    if (base.seeds.length === before) return false;
    base.updatedAt = nowIso();
    putEntity(ENTITY_KIND, base);
    return true;
  });
}

/** Replace a seed's tags. */
export function retagSeed(baseId: string, seedId: string, tags: string[]): KnowledgeSeed {
  return transaction(() => {
    const base = requireBase(baseId);
    const seed = base.seeds.find((s) => s.id === seedId);
    if (!seed) throw new Error(`seed ${seedId} not found in base ${baseId}`);
    seed.tags = normalizeTags(tags);
    seed.updatedAt = nowIso();
    base.updatedAt = nowIso();
    putEntity(ENTITY_KIND, base);
    return seed;
  });
}

/** Replace the embedding on a seed (used by the ingestion pipeline). */
export function setSeedVector(
  baseId: string,
  seedId: string,
  vector: string | undefined,
  dim?: number,
  model?: string,
): void {
  transaction(() => {
    const base = requireBase(baseId);
    const seed = base.seeds.find((s) => s.id === seedId);
    if (!seed) return;
    seed.vector = vector;
    seed.dim = dim;
    seed.model = model;
    seed.updatedAt = nowIso();
    base.updatedAt = nowIso();
    putEntity(ENTITY_KIND, base);
  });
}

export function summary(id: string): KnowledgeBaseSummary | undefined {
  const base = getBase(id);
  return base ? toSummary(base) : undefined;
}
