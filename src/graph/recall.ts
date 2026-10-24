/**
 * Neo N16: cross-run recall ("bookshelf").
 *
 * Every node of every past run already lives in the run-graph store (N1), so
 * nothing is copied or re-modelled here. This module keeps a *derived index*
 * next to it: one JSON document per finished, human-usable node, carrying the
 * text that was embedded plus the metadata a later run needs to find it again
 * and to point back at where it came from.
 *
 * Three properties matter more than raw retrieval quality:
 *
 * 1. **It is derived, so it can be rebuilt.** The index is never the source of
 *    truth. `rebuild` re-reads the store from scratch, and `sync` is called
 *    after every graph write, so a stale or half-written index is repaired on
 *    the next write instead of being shipped to the user.
 * 2. **It degrades, it does not break.** Without an embedder the index answers
 *    lexically (the same BM25-ish scoring the Knowledge Garden falls back to),
 *    so a run still recalls its own past work when Ollama is down.
 * 3. **It is throwaway-safe.** A recall failure must never break a task, so
 *    every entry point returns an honest empty answer instead of throwing.
 *
 * Storage is the existing `entities` table (`recall_node`), one JSON row per
 * node, keyed by the deterministic node id, so it survives restarts and needs
 * no new file or migration.
 */
import { allEntities, onDatabaseReset, putEntity, removeEntity, transaction } from "../server/sqliteStore.js";
import { dot, fromBase64, normalize, toBase64, type OllamaEmbedder } from "../memory/embeddings.js";
import { assertNoSecret } from "../memory/redact.js";
import type { RunNode, RunNodeStatus, RunNodeType } from "./store.js";

/** Entity kind of one indexed node. */
export const RECALL_NODE_ENTITY = "recall_node";

/** What a recalled node ultimately is: the thing the user searches for. */
export type RecallMedium = "text" | "image" | "webpage" | "video" | "media";

/**
 * Node types worth shelving, with the medium each is *usually* about.
 *
 * `webpage`/`document`/`search` are text-bearing nodes, `complete`/`note` are the
 * run's own summary sentences, and `media` is the canvas type N1 uses for images
 * and videos alike: `recallMedium` splits a concrete node into `image`/`video`
 * from its own `kind`/`mime`, and only falls back to the entry recorded here.
 *
 * Recallability is derived from this map on purpose, so the list of shelved types
 * and the medium each one reports can never drift apart.
 */
export const RECALL_MEDIA: Record<string, RecallMedium> = {
  document: "text",
  webpage: "webpage",
  media: "media",
  search: "text",
  complete: "text",
  note: "text",
};

export function isRecallableType(type: RunNodeType): boolean {
  return type in RECALL_MEDIA;
}

/** One indexed node. */
export interface RecallNode {
  /** Row key. `entities` rows are keyed by `id`, so it mirrors `nodeId`. */
  id: string;
  /** The run-graph node id, so a hit links back to its origin. */
  nodeId: string;
  /** The run (Loam task id) the node belongs to. */
  runId: string;
  /** Canvas node type (`document`, `webpage`, `media`, ...). */
  type: RunNodeType;
  /** What the user is really searching for (`image`, `video`, ...). */
  medium: RecallMedium;
  /** The text that was embedded. Always present, even for media. */
  text: string;
  /** The node's own status, so a failed node is never recalled as a result. */
  status: RunNodeStatus;
  /** Node payload: title, path, url, mime, ... */
  data?: unknown;
  /** Artifact path when the node is a file the current run could reopen. */
  path?: string;
  /** Mime type of that file, when known. */
  mime?: string;
  /** Artifact kind, when the node carries one. */
  kind?: string;
  /** Normalized Float32 vector, base64. Absent when there is no embedder. */
  vector?: string;
  dim: number;
  /** Embedding model, or "" when the index is lexical. */
  model: string;
  created: number;
  updated: number;
}

/** A hit plus the score that ranked it. */
export interface RecallHit {
  node: RecallNode;
  score: number;
  /** Which channel produced the score. */
  channel: "vector" | "lexical";
}

export interface RecallQuery {
  query: string;
  limit?: number;
  /** Only nodes of this run. */
  runId?: string;
  /** Only nodes of these media (`image`, `video`, ...). */
  mediums?: RecallMedium[];
  /** Only nodes of these canvas types (`document`, `media`, ...). */
  types?: RunNodeType[];
  /** Drop hits below this score. */
  minScore?: number;
}

/** Where a recalled node came from, in the shape the canvas already uses. */
export interface RecallSource {
  /** Id of the original run-graph node (may be gone if that run was deleted). */
  nodeId: string;
  /** Id of the run that produced it. */
  runId: string;
  /** Canvas type of the original node. */
  type: RunNodeType;
}

/** A recall tool is handed a way to resolve a hit back to its origin. */
export type RecallResolver = (source: RecallSource) => RunNode | undefined;

/**
 * A recall tool is handed a way to file a hit into the current run.
 *
 * It may return `undefined` when the current run has no graph yet (the node
 * cannot be created), which the tool reports as an honest failure.
 */
export type RecallAttacher = (source: RecallSource, runId: string, query: string) => RunNode | undefined;

export interface RecallIndexOptions {
  embedder?: OllamaEmbedder | null;
  model?: string;
  /** Hard cap on indexed nodes (0 = unlimited). */
  maxNodes?: number;
}

export interface RecallIndexStats {
  nodes: number;
  vectorized: number;
  /** True when no embedder was available, so search is lexical only. */
  lexicalOnly: boolean;
  model: string;
}

/** How much of a node's text to embed and return. */
const MAX_TEXT_CHARS = 8000;

/** Longest artifact title/url/path kept as metadata. */
const MAX_META_CHARS = 400;

function oneLine(text: string, max = MAX_META_CHARS): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Read one field off a node payload without assuming its shape. */
function dataString(data: unknown, key: string): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? oneLine(value, MAX_TEXT_CHARS) : undefined;
}

/**
 * The text a node contributes to the index.
 *
 * Media nodes have no text of their own, so the description is built from the
 * metadata that *is* there (title, path, query, summary) rather than from the
 * binary. That is what makes "the image of the dashboard" findable later.
 */
export function recallText(node: RunNode): string {
  const parts: string[] = [];
  const push = (value: string | undefined): void => {
    if (value && value.trim() && !parts.includes(value.trim())) parts.push(value.trim());
  };
  push(dataString(node.data, "title"));
  push(dataString(node.data, "label"));
  push(dataString(node.data, "query"));
  push(dataString(node.data, "url"));
  push(dataString(node.data, "path"));
  push(dataString(node.data, "summary"));
  push(dataString(node.data, "text"));
  push(dataString(node.data, "reason"));
  push(dataString(node.data, "message"));
  push(dataString(node.data, "verdict"));
  push(dataString(node.data, "tool"));
  // A node with no description at all is still recallable by its shape.
  if (parts.length === 0) push(`${node.type} ${node.run_id}`);
  return oneLine(parts.join(" — "), MAX_TEXT_CHARS);
}

/** The medium a node is really about (`media` splits into image/video). */
export function recallMedium(node: RunNode): RecallMedium {
  if (node.type !== "media") return RECALL_MEDIA[node.type] ?? "text";
  const kind = dataString(node.data, "kind") ?? "";
  const mime = dataString(node.data, "mime") ?? "";
  if (/^video\//.test(mime) || kind === "video") return "video";
  if (/^image\//.test(mime) || kind === "image") return "image";
  return "media" as RecallMedium;
}

/** True when a node is a finished result worth keeping on the shelf. */
export function isRecallable(node: RunNode): boolean {
  if (node.status !== "finished") return false;
  if (!isRecallableType(node.type)) return false;
  return recallText(node).trim().length > 0;
}

/** Validate an unknown row; undefined when it cannot be used as a hit. */
function coerceNode(value: unknown): RecallNode | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.nodeId !== "string" || typeof raw.runId !== "string") return undefined;
  if (typeof raw.type !== "string" || !isRecallableType(raw.type as RunNodeType)) return undefined;
  if (typeof raw.text !== "string" || raw.text.length === 0) return undefined;
  const dim = typeof raw.dim === "number" && Number.isFinite(raw.dim) ? raw.dim : 0;
  return {
    id: typeof raw.id === "string" ? raw.id : raw.nodeId,
    nodeId: raw.nodeId,
    runId: raw.runId,
    type: raw.type as RunNodeType,
    medium: (typeof raw.medium === "string" ? raw.medium : RECALL_MEDIA[raw.type as RunNodeType] ?? "text") as RecallMedium,
    text: raw.text,
    status: (typeof raw.status === "string" ? raw.status : "finished") as RunNodeStatus,
    ...(raw.data !== undefined ? { data: raw.data } : {}),
    ...(typeof raw.path === "string" ? { path: raw.path } : {}),
    ...(typeof raw.mime === "string" ? { mime: raw.mime } : {}),
    ...(typeof raw.kind === "string" ? { kind: raw.kind } : {}),
    ...(typeof raw.vector === "string" && dim > 0 ? { vector: raw.vector } : {}),
    dim,
    model: typeof raw.model === "string" ? raw.model : "",
    created: typeof raw.created === "number" && Number.isFinite(raw.created) ? raw.created : 0,
    updated: typeof raw.updated === "number" && Number.isFinite(raw.updated) ? raw.updated : 0,
  };
}

/* ------------------------------- lexical fallback ------------------------------ */

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "was", "were",
  "this", "that", "these", "those", "it", "its", "as", "at", "by", "be", "from", "into", "not", "no",
]);

function terms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const term = raw.trim();
    if (term.length < 2 || STOP_WORDS.has(term)) continue;
    out.push(term.length > 32 ? term.slice(0, 32) : term);
  }
  return out;
}

/** Log-scaled term frequency, so one repeated word cannot dominate. */
function termWeights(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of terms(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  const out = new Map<string, number>();
  for (const [term, count] of counts) out.set(term, 1 + Math.log(count));
  return out;
}

/** BM25 over the in-memory index. Deterministic and dependency-free. */
function bm25Score(weights: Map<string, number>, doc: Map<string, number>, avgLen: number, idf: Map<string, number>): number {
  const k1 = 1.5;
  const b = 0.75;
  const len = [...doc.values()].reduce((sum, value) => sum + value, 0);
  let score = 0;
  for (const [term, qWeight] of weights) {
    const tf = doc.get(term);
    if (!tf) continue;
    const df = idf.get(term) ?? 0;
    const denominator = tf + k1 * (1 - b + (b * len) / Math.max(1, avgLen));
    score += qWeight * ((tf * (k1 + 1)) / denominator) * Math.log(1 + df);
  }
  return score;
}

/**
 * The derived index over finished run-graph nodes.
 *
 * One instance serves the process; `attachRecall` gives the live graph its own
 * handle so every write refreshes the shelf without a polling job.
 */
export class RecallIndex {
  private nodes = new Map<string, RecallNode>();
  private vectors = new Map<string, Float32Array>();
  private docWeights = new Map<string, Map<string, number>>();
  private idf = new Map<string, number>();
  private avgLen = 1;
  private loaded = false;
  private syncTimer: NodeJS.Timeout | null = null;
  private pendingSync = false;
  private readonly maxNodes: number;

  constructor(private readonly opts: RecallIndexOptions = {}) {
    this.maxNodes = opts.maxNodes ?? 0;
    onDatabaseReset(() => this.reset());
  }

  /** Drop the cached index; called when the database connection is reset. */
  reset(): void {
    this.nodes.clear();
    this.vectors.clear();
    this.docWeights.clear();
    this.idf.clear();
    this.avgLen = 1;
    this.loaded = false;
  }

  private get embedder(): OllamaEmbedder | null {
    return this.opts.embedder ?? null;
  }

  private get model(): string {
    return this.opts.model ?? "";
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    for (const row of allEntities<RecallNode>(RECALL_NODE_ENTITY)) {
      const node = coerceNode(row);
      if (node) this.accept(node);
    }
    this.loaded = true;
  }

  /** Add/replace one node in memory and recompute the lexical statistics. */
  private accept(node: RecallNode): void {
    this.nodes.set(node.nodeId, node);
    this.vectors.delete(node.nodeId);
    if (node.vector && node.dim > 0) {
      const vec = fromBase64(node.vector, node.dim);
      this.vectors.set(node.nodeId, vec);
    }
    this.rebuildLexical();
  }

  /** True when the shelf holds a node (cheap, before `search` loads vectors). */
  has(nodeId: string): boolean {
    this.ensureLoaded();
    return this.nodes.has(nodeId);
  }

  /** One indexed node by id, or undefined. */
  get(nodeId: string): RecallNode | undefined {
    this.ensureLoaded();
    return this.nodes.get(nodeId);
  }

  private remove(nodeId: string): void {
    if (!this.nodes.has(nodeId)) return;
    this.nodes.delete(nodeId);
    this.vectors.delete(nodeId);
    this.rebuildLexical();
  }

  /** Recompute document weights and idf from the nodes currently in memory. */
  private rebuildLexical(): void {
    this.docWeights.clear();
    this.idf.clear();
    let total = 0;
    for (const [id, node] of this.nodes) {
      const weights = termWeights(node.text);
      this.docWeights.set(id, weights);
      total += [...weights.values()].reduce((sum, value) => sum + value, 0);
      for (const term of weights.keys()) this.idf.set(term, (this.idf.get(term) ?? 0) + 1);
    }
    this.avgLen = this.nodes.size === 0 ? 1 : Math.max(1, total / this.nodes.size);
  }

  /* ------------------------------- indexing ------------------------------- */

  /** Index (or re-index) one node. Returns false when the node is not shelf-worthy. */
  async index(node: RunNode): Promise<boolean> {
    if (!isRecallable(node)) return false;
    const text = recallText(node);
    // An indexed node is later injected into a prompt: never keep a credential.
    if (!assertNoSecretSafe(text)) return false;
    const vector = this.embedder ? await this.safeEmbed(text) : undefined;
    const entry: RecallNode = {
      id: node.id,
      nodeId: node.id,
      runId: node.run_id,
      type: node.type,
      medium: recallMedium(node),
      text,
      status: node.status,
      ...(node.data !== undefined ? { data: node.data } : {}),
      ...(dataString(node.data, "path") ? { path: dataString(node.data, "path") } : {}),
      ...(dataString(node.data, "mime") ? { mime: dataString(node.data, "mime") } : {}),
      ...(dataString(node.data, "kind") ? { kind: dataString(node.data, "kind") } : {}),
      ...(vector ? { vector: toBase64(vector), dim: vector.length } : { dim: 0 }),
      model: this.model,
      created: node.created,
      updated: node.updated,
    };
    putEntity(RECALL_NODE_ENTITY, entry);
    this.accept(entry);
    return true;
  }

  /** Drop a node from the shelf (the node was deleted, or is no longer finished). */
  async forget(nodeId: string): Promise<void> {
    removeEntity(RECALL_NODE_ENTITY, nodeId);
    this.remove(nodeId);
  }

  /** Forget then re-index one node, so its text and metadata stay current. */
  async refresh(node: RunNode): Promise<void> {
    if (!isRecallable(node)) {
      await this.forget(node.id);
      return;
    }
    // Re-indexing is idempotent by id, so a repeated write is free.
    await this.index(node);
  }

  private async safeEmbed(text: string): Promise<Float32Array | undefined> {
    try {
      return normalize(await this.embedder!.embedOne(text));
    } catch {
      // No embedder reachable: the node stays on the shelf, just lexical.
      return undefined;
    }
  }

  /* -------------------------------- search -------------------------------- */

  /** Search the shelf. Never throws: an unavailable index answers empty. */
  async search(query: RecallQuery): Promise<RecallHit[]> {
    try {
      this.ensureLoaded();
      const wanted = Math.min(Math.max(query.limit ?? 5, 1), 50);
      const minScore = query.minScore ?? 0;
      const qText = query.query.trim();
      const scored: RecallHit[] = [];

      if (qText && this.embedder && this.vectors.size > 0) {
        const vector = await this.safeEmbed(qText);
        if (vector) {
          for (const [nodeId, node] of this.nodes) {
            if (!matchesFilters(node, query)) continue;
            const other = this.vectors.get(nodeId);
            if (!other || other.length !== vector.length) continue;
            const score = dot(vector, other);
            // A zero score means the query shared no signal with the node, which
            // is not a match: without this a filter-only query would return
            // every node of that medium.
            if (score > 0 && score >= minScore) scored.push({ node, score, channel: "vector" });
          }
          scored.sort((a, b) => b.score - a.score);
          if (scored.length > 0) return scored.slice(0, wanted);
          // A vector channel with no hit at all falls through to the lexical
          // one: a paraphrase the embedder missed is still worth finding.
        }
      }

      if (!qText) {
        const recent = [...this.nodes.values()]
          .filter((node) => matchesFilters(node, query))
          .sort((a, b) => b.updated - a.updated || b.created - a.created);
        return recent.slice(0, wanted).map((node) => ({ node, score: 0, channel: "lexical" as const }));
      }

      const weights = termWeights(qText);
      for (const [nodeId, node] of this.nodes) {
        if (!matchesFilters(node, query)) continue;
        const score = bm25Score(weights, this.docWeights.get(nodeId) ?? new Map(), this.avgLen, this.idf);
        // BM25 is 0 when no query term occurs in the node, so `>= 0` would
        // return unrelated nodes. A hit must share at least one term.
        if (score > 0 && score >= minScore) scored.push({ node, score, channel: "lexical" });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, wanted);
    } catch (err) {
      console.warn(`[recall] search failed: ${String(err)}`);
      return [];
    }
  }

  /** Every indexed node of one run, oldest first. */
  listForRun(runId: string): RecallNode[] {
    this.ensureLoaded();
    return [...this.nodes.values()]
      .filter((node) => node.runId === runId)
      .sort((a, b) => a.created - b.created);
  }

  stats(): RecallIndexStats {
    this.ensureLoaded();
    return {
      nodes: this.nodes.size,
      vectorized: this.vectors.size,
      lexicalOnly: this.embedder === null,
      model: this.model,
    };
  }

  /**
   * Rebuild the shelf from the run graph itself.
   *
   * The graph is the source of truth, so this repairs anything the incremental
   * sync missed: a node indexed before its text was edited, a node that became
   * failed, a row written by an older build.
   */
  async rebuild(store: { runs: () => Array<{ runId: string; nodes: RunNode[] }> }): Promise<number> {
    const keep = new Set<string>();
    let indexed = 0;
    for (const run of store.runs()) {
      for (const node of run.nodes) {
        if (!isRecallable(node)) continue;
        keep.add(node.id);
        const existing = this.nodes.get(node.id);
        // A row can outlive the node it describes (the node was re-inserted
        // with a new run, or a row was written before the node changed), so
        // compare identity *and* provenance, not just the text.
        if (
          existing &&
          existing.updated >= node.updated &&
          existing.text === recallText(node) &&
          existing.runId === node.run_id
        ) {
          continue;
        }
        if (await this.index(node)) indexed += 1;
      }
    }
    for (const nodeId of [...this.nodes.keys()]) {
      if (keep.has(nodeId)) continue;
      await this.forget(nodeId);
    }
    this.enforceCap();
    return indexed;
  }

  /** Drop the oldest nodes when the shelf grows past its cap. */
  private enforceCap(): void {
    if (this.maxNodes <= 0 || this.nodes.size <= this.maxNodes) return;
    const excess = this.nodes.size - this.maxNodes;
    const stale = [...this.nodes.values()].sort((a, b) => a.updated - b.updated).slice(0, excess);
    transaction(() => {
      for (const node of stale) {
        removeEntity(RECALL_NODE_ENTITY, node.nodeId);
        this.remove(node.nodeId);
      }
    });
  }

  /**
   * Schedule an incremental sync of one run after a graph write.
   *
   * Writes arrive one per event, and embedding is a network call, so a burst of
   * thirty tool results is coalesced into a single pass instead of thirty.
   */
  scheduleSync(runId: string, read: (id: string) => RunNode[]): void {
    if (this.syncTimer) return;
    this.pendingSync = true;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.runSync(runId, read);
    }, 200);
    // A pending recall sync must never keep the process alive on its own.
    this.syncTimer.unref?.();
  }

  /** Cancel a scheduled sync (used when the run ends or a test tears down). */
  cancelSync(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.pendingSync = false;
  }

  /** True when a coalesced sync is still waiting to run. */
  get syncPending(): boolean {
    return this.pendingSync;
  }

  /** Index the finished nodes of one run that the shelf does not know yet. */
  async runSync(runId: string, read: (id: string) => RunNode[]): Promise<number> {
    this.pendingSync = false;
    let indexed = 0;
    try {
      const known = new Set(this.listForRun(runId).map((node) => node.nodeId));
      for (const node of read(runId)) {
        if (!isRecallable(node)) {
          // A node that stopped being a result must leave the shelf.
          if (known.has(node.id)) {
            await this.forget(node.id);
            indexed += 1;
          }
          continue;
        }
        const current = known.has(node.id) ? this.nodes.get(node.id) : undefined;
        // The incremental path skips the embed call when nothing changed: a
        // burst of thirty tool results would otherwise cost thirty network calls.
        if (current && current.updated >= node.updated && current.text === recallText(node)) continue;
        if (await this.index(node)) indexed += 1;
      }
      this.enforceCap();
    } catch (err) {
      console.warn(`[recall] sync failed for ${runId}: ${String(err)}`);
    }
    return indexed;
  }
}

function matchesFilters(node: RecallNode, query: RecallQuery): boolean {
  if (query.runId && node.runId !== query.runId) return false;
  if (query.mediums && query.mediums.length > 0 && !query.mediums.includes(node.medium)) return false;
  if (query.types && query.types.length > 0 && !query.types.includes(node.type)) return false;
  return true;
}

/** `assertNoSecret` without the throw, so a secret-bearing node is skipped. */
function assertNoSecretSafe(text: string): boolean {
  try {
    assertNoSecret(text);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------ process singleton ----------------------------- */

let index: RecallIndex | undefined;

/** The process-wide shelf. One instance serves every run in this process. */
export function recallIndex(options: RecallIndexOptions = {}): RecallIndex {
  if (!index) index = new RecallIndex(options);
  return index;
}

/** Forget the process-wide shelf. A test that swaps the data dir must do this. */
export function resetRecallIndex(): void {
  index = undefined;
}
