import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import { type OllamaEmbedder, dot, fromBase64, normalize, toBase64 } from "./embeddings.js";
import { assertNoSecret } from "./redact.js";
import { rerank, type RankWeights } from "../orchestration/memory/rank.js";
import { Bm25Index, hybridRank } from "./hybrid.js";

/** Where a memory came from: an explicit user statement or an agent inference. */
export type MemorySource = "user" | "agent" | "system";

export interface MemoryEntry {
  id: string;
  text: string;
  kind: string;
  tags: string[];
  /** First time this memory was added (preserved across merges). */
  createdAt: string;
  dim: number;
  /** base64-encoded normalized Float32 vector */
  vector: string;
  /** Provenance: the session/task that first contributed this memory. */
  sessionId?: string;
  /** Provenance: explicit user statement vs agent inference. */
  source?: MemorySource;
  /** Every session that contributed (union preserved across merges). */
  sourceSessionIds?: string[];
  /** Last time this memory was recalled/used (staleness signal). */
  lastUsedAt?: string;
  /** How many times this memory has been recalled/used. */
  useCount?: number;
  /** Citation (loci graft, ALL_SERVICES §16): a recalled item can name its origin. */
  citation?: { source: string; blobId?: string };
  /** C9 (default off): stored importance 0..1; unset entries get the kind/source default. */
  importance?: number;
}

export interface MemoryHit {
  entry: MemoryEntry;
  score: number;
}

export interface AddMemoryOptions {
  kind?: string;
  tags?: string[];
  /** Session/task id that produced this memory (provenance). */
  sessionId?: string;
  /** Provenance of the statement; defaults to "user" for preferences. */
  source?: MemorySource;
}

export interface DreamOptions {
  /** Clock override for deterministic tests. */
  now?: Date;
  /** Entries unused for longer than this are stale (default 30 days). */
  staleAfterMs?: number;
  /** Hard cap on total entries after consolidation (0 = unlimited). */
  maxEntries?: number;
  /** Merge duplicates at/above this cosine similarity. */
  similarityThreshold?: number;
}

export interface DreamReport {
  at: string;
  startedWith: number;
  kept: number;
  /** Entries folded into a surviving duplicate. */
  merged: number;
  /** Stale entries removed (stale + over-cap). */
  pruned: number;
  /** True when nothing changed. */
  idempotent: boolean;
  changes: string[];
}

export interface MemoryDreamJobOptions {
  /** Default: 24h. */
  intervalMs?: number;
  staleAfterMs?: number;
  maxEntries?: number;
  onError?: (err: unknown) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 30 * DAY_MS;

function inferSource(kind?: string): MemorySource {
  return kind === "preference" ? "user" : "agent";
}

function maxIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/** Fold `source` provenance into `target`, preserving both histories. */
function mergeEntry(target: MemoryEntry, source: MemoryEntry): void {
  const sessions = new Set(target.sourceSessionIds ?? []);
  if (target.sessionId) sessions.add(target.sessionId);
  if (source.sessionId) sessions.add(source.sessionId);
  for (const s of source.sourceSessionIds ?? []) sessions.add(s);
  target.sourceSessionIds = [...sessions].sort();
  if (!target.sessionId) target.sessionId = source.sessionId;
  // An explicit user statement outranks an inferred one.
  if (!target.source) target.source = source.source;
  if (source.source === "user") target.source = "user";
  target.tags = [...new Set([...target.tags, ...source.tags])];
  target.useCount = (target.useCount ?? 0) + (source.useCount ?? 0);
  target.lastUsedAt = maxIso(target.lastUsedAt, source.lastUsedAt);
}

interface MemoryFile {
  version: 1;
  model: string;
  entries: MemoryEntry[];
}

function newId(): string {
  return `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Tiny local vector store (JSON on disk, brute-force cosine over normalized vectors).
 *  Good for thousands of entries — no external service, no native deps. */
export class MemoryStore {
  private entries: MemoryEntry[] = [];
  private vectors: Float32Array[] = [];
  private model = "";
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly dedupeThreshold: number;

  private ranking: { weights: RankWeights; candidateMultiplier: number } | null = null;
  /** E1 hybrid retrieval (default on): BM25+RRF fusion replaces plain cosine ordering. */
  private hybridEnabled = true;

  constructor(
    private readonly file: string,
    private readonly embedder: OllamaEmbedder,
    model: string,
    dedupeThreshold = 0.97,
    ranking?: { weights: RankWeights; candidateMultiplier: number },
    hybridEnabled = true,
  ) {
    if (ranking) this.ranking = ranking;
    this.hybridEnabled = hybridEnabled;
    this.model = model;
    this.dedupeThreshold = dedupeThreshold;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<MemoryFile>;
      this.entries = parsed.entries ?? [];
      this.model = parsed.model ?? this.model;
      this.vectors = this.entries.map((e) => fromBase64(e.vector, e.dim));
      log.info(`memory: loaded ${this.entries.length} entries (${this.model})`);
    } catch (err) {
      log.warn(`memory: failed to load ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
      this.entries = [];
      this.vectors = [];
    }
  }

  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        const payload: MemoryFile = { version: 1, model: this.model, entries: this.entries };
        fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
        fs.renameSync(tmp, this.file);
      } catch (err) {
        log.warn(`memory: save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 250);
  }

  get count(): number {
    return this.entries.length;
  }

  get embeddingModel(): string {
    return this.model;
  }

  async add(text: string, opts: AddMemoryOptions = {}): Promise<MemoryEntry> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("memory text is empty");
    // Memory is persisted and injected into prompts: never keep credentials.
    assertNoSecret(trimmed);
    const source: MemorySource = opts.source ?? inferSource(opts.kind);
    // C9: no model call — importance defaults come from the kind/source.
    const importance = opts.kind === "preference" ? 0.7 : source === "user" ? 0.6 : undefined;
    const now = new Date().toISOString();
    const provenance = { sessionId: opts.sessionId, source, tags: opts.tags };
    const existing = this.entries.find((e) => e.text === trimmed);
    if (existing) {
      mergeEntry(existing, {
        id: "",
        text: trimmed,
        kind: opts.kind ?? existing.kind,
        tags: opts.tags ?? [],
        createdAt: now,
        dim: existing.dim,
        vector: existing.vector,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        source,
        sourceSessionIds: opts.sessionId ? [opts.sessionId] : [],
        lastUsedAt: now,
        useCount: 0,
      });
      this.save();
      return existing;
    }
    const vec = normalize(await this.embedder.embedOne(trimmed));
    const near = this.nearest(vec);
    if (near && near.score >= this.dedupeThreshold) {
      const existing = this.entries[near.index]!;
      mergeEntry(existing, {
        id: "",
        text: trimmed,
        kind: opts.kind ?? existing.kind,
        tags: opts.tags ?? [],
        createdAt: now,
        dim: existing.dim,
        vector: existing.vector,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        source,
        sourceSessionIds: opts.sessionId ? [opts.sessionId] : [],
        lastUsedAt: now,
        useCount: 0,
      });
      this.save();
      log.info(`memory: merged near-duplicate into ${existing.id} (score ${near.score.toFixed(3)})`);
      return existing;
    }
    const entry: MemoryEntry = {
      id: newId(),
      text: trimmed,
      kind: opts.kind ?? "note",
      tags: opts.tags ?? [],
      createdAt: now,
      dim: vec.length,
      vector: toBase64(vec),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      source,
      ...(opts.sessionId ? { sourceSessionIds: [opts.sessionId] } : {}),
      ...(importance !== undefined ? { importance } : {}),
      lastUsedAt: now,
      useCount: 0,
    };
    this.entries.push(entry);
    this.vectors.push(vec);
    this.save();
    return entry;
  }

  async search(query: string, limit = 5, minScore = 0.0): Promise<MemoryHit[]> {
    if (this.entries.length === 0) return [];
    const q = normalize(await this.embedder.embedOne(query));
    const scored = this.entries.map((entry, i) => {
      const v = this.vectors[i];
      return { entry, score: v ? dot(q, v) : -1 };
    });
    const pool = scored
      .filter((h) => h.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, this.ranking ? limit * this.ranking.candidateMultiplier : limit));
    // E1 hybrid retrieval (default on): BM25 + cosine fused with weighted RRF,
    // retention-decayed and diversified per session. The embedder being down
    // degrades to BM25-only instead of failing the search.
    if (this.hybridEnabled) {
      const index = new Bm25Index();
      index.build(this.entries);
      const idToEntry = new Map(this.entries.map((e) => [e.id, e]));
      const ranked = hybridRank(this.entries, index, query, { limit, vectorHits: pool.map((h) => ({ id: h.entry.id, score: h.score })) });
      const now = new Date().toISOString();
      const hits: MemoryHit[] = ranked.flatMap((r) => {
        const entry = idToEntry.get(r.id);
        return entry ? [{ entry, score: r.final }] : [];
      });
      for (const h of hits) { h.entry.lastUsedAt = now; h.entry.useCount = (h.entry.useCount ?? 0) + 1; }
      if (hits.length > 0) this.save();
      return hits;
    }
    // C9 (default off): recency + importance re-ranking over a wider cosine pool.
    const hits = this.ranking
      ? rerank(pool.map((h) => ({ ...h, entry: { ...h.entry } })), limit, this.ranking.weights).map((r) => ({ entry: r.entry, score: r.composite }))
      : pool;
    // Track last_used: a recall is the signal that keeps an entry alive.
    const now = new Date().toISOString();
    for (const h of hits) {
      h.entry.lastUsedAt = now;
      h.entry.useCount = (h.entry.useCount ?? 0) + 1;
    }
    if (hits.length > 0) this.save();
    return hits;
  }

  /** Mark a memory as recalled/used at `at` (default: now). */
  markUsed(id: string, at = new Date().toISOString()): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return false;
    entry.lastUsedAt = at;
    entry.useCount = (entry.useCount ?? 0) + 1;
    this.save();
    return true;
  }

  list(limit = 50): MemoryEntry[] {
    return [...this.entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, limit));
  }

  private nearest(vec: Float32Array): { index: number; score: number } | null {
    let best = -1;
    let bestIdx = -1;
    for (let i = 0; i < this.vectors.length; i++) {
      const v = this.vectors[i];
      if (!v) continue;
      const s = dot(vec, v);
      if (s > best) {
        best = s;
        bestIdx = i;
      }
    }
    return bestIdx < 0 ? null : { index: bestIdx, score: best };
  }

  /** Curate: keep at most `maxEntries`, dropping the oldest entries whose kind is in
   *  `dropKinds` first (default: task/auto noise), then the oldest overall. */
  prune(opts: { maxEntries?: number; dropKinds?: string[] } = {}): number {
    const max = opts.maxEntries ?? 0;
    if (max <= 0 || this.entries.length <= max) return 0;
    let toDrop = this.entries.length - max;
    const dropKinds = new Set(opts.dropKinds ?? []);
    const byAge = this.entries
      .map((e, i) => ({ i, e }))
      .sort((a, b) => a.e.createdAt.localeCompare(b.e.createdAt));
    const doomed = new Set<number>();
    for (const { i, e } of byAge) {
      if (toDrop <= 0) break;
      if (dropKinds.has(e.kind) || e.tags.includes("auto")) {
        doomed.add(i);
        toDrop -= 1;
      }
    }
    for (const { i } of byAge) {
      if (toDrop <= 0) break;
      if (!doomed.has(i)) {
        doomed.add(i);
        toDrop -= 1;
      }
    }
    const keepE: MemoryEntry[] = [];
    const keepV: Float32Array[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      if (doomed.has(i)) continue;
      keepE.push(this.entries[i]!);
      const v = this.vectors[i];
      if (v) keepV.push(v);
    }
    const removed = doomed.size;
    this.entries = keepE;
    this.vectors = keepV;
    this.save();
    log.info(`memory: pruned ${removed} entries (now ${this.entries.length}/${max})`);
    return removed;
  }

  remove(id: string): boolean {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    this.vectors.splice(idx, 1);
    this.save();
    return true;
  }

  /* ---------------- "dreaming": background consolidation ---------------- */

  /** Fold near-duplicates together, keeping the earliest/richest entry and
   *  merging provenance. Deterministic so the job is safe to run repeatedly. */
  private consolidateDuplicates(threshold: number, changes: string[]): number {
    if (this.entries.length < 2) return 0;
    const order = this.entries
      .map((e, i) => ({ e, v: this.vectors[i] }))
      .sort(
        (a, b) =>
          a.e.createdAt.localeCompare(b.e.createdAt) ||
          (b.e.useCount ?? 0) - (a.e.useCount ?? 0) ||
          a.e.id.localeCompare(b.e.id),
      );
    const keepE: MemoryEntry[] = [];
    const keepV: Float32Array[] = [];
    let merged = 0;
    for (const { e, v } of order) {
      let target = -1;
      for (let j = 0; j < keepE.length; j++) {
        const kv = keepV[j];
        if (!kv || !v) continue;
        if (dot(v, kv) >= threshold) {
          target = j;
          break;
        }
      }
      if (target >= 0) {
        mergeEntry(keepE[target]!, e);
        changes.push(`merged ${e.id} -> ${keepE[target]!.id}`);
        merged += 1;
      } else if (v) {
        keepE.push(e);
        keepV.push(v);
      }
    }
    if (merged === 0) return 0;
    this.entries = keepE;
    this.vectors = keepV;
    return merged;
  }

  /** Drop entries that have not been used for `staleAfterMs`. Explicit user
   *  preferences are always kept. */
  private pruneStale(now: Date, staleAfterMs: number, changes: string[]): number {
    const cutoff = now.getTime() - staleAfterMs;
    const keepE: MemoryEntry[] = [];
    const keepV: Float32Array[] = [];
    let removed = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      const isPreference = e.kind === "preference" || e.source === "user";
      const last = e.lastUsedAt ?? e.createdAt;
      const stale = Number.isFinite(Date.parse(last)) && Date.parse(last) < cutoff;
      if (stale && !isPreference) {
        changes.push(`pruned stale ${e.id}`);
        removed += 1;
        continue;
      }
      keepE.push(e);
      const v = this.vectors[i];
      if (v) keepV.push(v);
    }
    if (removed > 0) {
      this.entries = keepE;
      this.vectors = keepV;
    }
    return removed;
  }

  /** Enforce a hard cap, dropping the oldest non-preferences first. */
  private pruneToMax(max: number, changes: string[]): number {
    let toDrop = this.entries.length - max;
    if (toDrop <= 0) return 0;
    const order = this.entries
      .map((e, i) => ({ e, i }))
      .sort(
        (a, b) =>
          (a.e.kind === "preference" || a.e.source === "user" ? 1 : 0) -
            (b.e.kind === "preference" || b.e.source === "user" ? 1 : 0) ||
          a.e.createdAt.localeCompare(b.e.createdAt) ||
          (a.e.useCount ?? 0) - (b.e.useCount ?? 0),
      );
    const doomed = new Set<number>();
    for (const { i } of order) {
      if (toDrop <= 0) break;
      doomed.add(i);
      toDrop -= 1;
    }
    for (const i of doomed) changes.push(`pruned over-cap ${this.entries[i]?.id ?? i}`);
    const keepE: MemoryEntry[] = [];
    const keepV: Float32Array[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      if (doomed.has(i)) continue;
      keepE.push(this.entries[i]!);
      const v = this.vectors[i];
      if (v) keepV.push(v);
    }
    this.entries = keepE;
    this.vectors = keepV;
    return doomed.size;
  }

  /** Nightly/background consolidation: merge duplicates, drop stale unused
   *  entries (never user preferences), then enforce the cap. Idempotent. */
  async dream(opts: DreamOptions = {}): Promise<DreamReport> {
    const now = opts.now ?? new Date();
    const threshold = opts.similarityThreshold ?? this.dedupeThreshold;
    const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const maxEntries = opts.maxEntries ?? 0;
    const startedWith = this.entries.length;
    const changes: string[] = [];

    const merged = this.consolidateDuplicates(threshold, changes);
    const stale = this.pruneStale(now, staleAfterMs, changes);
    const capped = maxEntries > 0 ? this.pruneToMax(maxEntries, changes) : 0;
    const pruned = stale + capped;
    const changed = merged > 0 || pruned > 0;

    if (changed) {
      this.save();
      log.info(
        `memory dream: merged ${merged}, pruned ${pruned} (${startedWith} -> ${this.entries.length})`,
      );
    }
    return {
      at: now.toISOString(),
      startedWith,
      kept: this.entries.length,
      merged,
      pruned,
      idempotent: !changed,
      changes,
    };
  }

  /** Compact index summary for prompt context (bounded, no secrets). */
  indexSummary(limit = 8): string {
    if (this.entries.length === 0) return "";
    const byKind = new Map<string, number>();
    const byTag = new Map<string, number>();
    for (const e of this.entries) {
      byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
      for (const t of e.tags) byTag.set(t, (byTag.get(t) ?? 0) + 1);
    }
    const kinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(", ");
    const topTags = [...byTag.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => `#${t}`).join(" ");
    const recent = this.list(limit).map((e) => `- [${e.kind}] ${e.text.slice(0, 80)}`).join("\n");
    return [
      `MEMORY index (${this.entries.length} entries): ${kinds}`,
      topTags ? `tags: ${topTags}` : "",
      `recent:\n${recent}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
}

/** Start the background "dream" consolidation. Returns a stop function. */
export function startMemoryDreamJob(store: MemoryStore, opts: MemoryDreamJobOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? DAY_MS;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await store.dream({ staleAfterMs, maxEntries: opts.maxEntries });
    } catch (err) {
      if (opts.onError) opts.onError(err);
      else log.warn(`memory dream failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
