import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import { type OllamaEmbedder, dot, fromBase64, normalize, toBase64 } from "./embeddings.js";

export interface MemoryEntry {
  id: string;
  text: string;
  kind: string;
  tags: string[];
  createdAt: string;
  dim: number;
  /** base64-encoded normalized Float32 vector */
  vector: string;
}

export interface MemoryHit {
  entry: MemoryEntry;
  score: number;
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

  constructor(
    private readonly file: string,
    private readonly embedder: OllamaEmbedder,
    model: string,
    dedupeThreshold = 0.97,
  ) {
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

  async add(text: string, opts: { kind?: string; tags?: string[] } = {}): Promise<MemoryEntry> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("memory text is empty");
    const existing = this.entries.find((e) => e.text === trimmed);
    if (existing) {
      existing.createdAt = new Date().toISOString();
      if (opts.tags?.length) existing.tags = [...new Set([...existing.tags, ...opts.tags])];
      this.save();
      return existing;
    }
    const vec = normalize(await this.embedder.embedOne(trimmed));
    const near = this.nearest(vec);
    if (near && near.score >= this.dedupeThreshold) {
      const existing = this.entries[near.index]!;
      existing.createdAt = new Date().toISOString();
      if (opts.tags?.length) existing.tags = [...new Set([...existing.tags, ...opts.tags])];
      this.save();
      log.info(`memory: merged near-duplicate into ${existing.id} (score ${near.score.toFixed(3)})`);
      return existing;
    }
    const entry: MemoryEntry = {
      id: newId(),
      text: trimmed,
      kind: opts.kind ?? "note",
      tags: opts.tags ?? [],
      createdAt: new Date().toISOString(),
      dim: vec.length,
      vector: toBase64(vec),
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
    return scored
      .filter((h) => h.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));
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
}
