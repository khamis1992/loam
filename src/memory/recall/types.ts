/** Loam Recall contracts. Built from the Loam Recall spec; no upstream source. */

export type MemoryKind = "fact" | "preference" | "event" | "relationship" | "insight" | "project" | "procedure";
export type MemoryOrigin = "user" | "assistant" | "tool" | "fusion" | "reflection" | "mcp";
export type MemoryState = "active" | "dormant" | "archived" | "superseded" | "trashed";
export type RelationType = "UPDATES" | "EXTENDS" | "DERIVES" | "RELATES";
export type RelationOrigin = "ingest" | "nrem" | "rem" | "manual";

export interface MemoryRecord {
  id: string;
  scope: string;
  content: string;
  lang: "ar" | "en" | "mixed";
  kind: MemoryKind;
  origin: MemoryOrigin;
  importance: number;
  confidence: number;
  prominence: number;
  state: MemoryState;
  isLatest: boolean;
  pinned: boolean;
  confirmations: number;
  accessCount: number;
  eventAt?: number;
  documentAt: number;
  lastAccessAt?: number;
  trashedAt?: number;
  sourceRef?: { sessionId: string; messageId?: string; file?: string };
  tags: string[];
  embeddingModel?: string;
  embedding?: Float32Array;
  contentHash: string;
  /** Daily decay override. Superseded memories use 0.9. */
  decayRate?: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryRelation {
  id: string;
  fromId: string;
  toId: string;
  type: RelationType;
  confidence: number;
  origin: RelationOrigin;
  createdAt: number;
}

export interface SearchQuery {
  text: string;
  scope?: string[];
  limit?: number;
  since?: number;
  until?: number;
  kinds?: MemoryKind[];
  rerank?: boolean | { deadlineMs: number };
  activation?: boolean;
  /** Hide the legal scope unless the caller is the legal mode. */
  allowLegal?: boolean;
}

export interface SearchHit {
  memory: MemoryRecord;
  score: number;
  parts: { bm25Rank?: number; cosine?: number; recency: number; llm?: number; activation?: number };
  match: "keyword" | "semantic" | "hybrid" | "graph";
}

export interface RecallConfig {
  weights: { keyword: number; semantic: number; recencyMax: number; recencyHalfLifeH: number };
  rerank: { enabled: boolean; deadlineMs: number; blendOriginal: number; minLlm: number; maxCandidates: number };
  mmrLambda: number;
  dedupe: { jaccard: number; cosineWithJaccard: number; cosineAlone: number };
  link: { updateCos: number; extendCos: number; topK: number };
  lsh: { tables: number; bits: number; componentsPerBit: number; seed: number; bruteForceBelow: number };
  decay: {
    kindDailyRate: Record<MemoryKind, number>;
    weights: { age: number; confFreq: number; confRecency: number; importance: number; confidence: number };
    floor: number;
    floorKinds: MemoryKind[];
  };
  forget: { utilityThreshold: number; minAgeDays: number; hardDeleteBelow: number; trashDays: number };
  gardener: {
    lightEveryMin: number;
    deepEveryMin: number;
    sleepEveryH: number;
    quietHours: [number, number];
    onlyWhenIdle: boolean;
    timeZone: string;
  };
  models: { generator: string; embedder: string; reranker?: string };
  injection: { maxTokens: number; maxItems: number; skipTrivial: boolean };
  coreLimits: { user: number; environment: number };
}

export interface CoreBlocks {
  user: string[];
  environment: string[];
  limits: { user: number; environment: number };
}

export type CoreEdit = { scope: string; block: "user" | "environment" } & (
  | { op: "add"; text: string }
  | { op: "replace"; match: string; text: string }
  | { op: "remove"; match: string }
);

export type CoreEditResult = { ok: true } | { ok: false; reason: "overflow" | "no_match"; current: string[] };

export interface GardenerStep {
  name: string;
  ok: boolean;
  ms: number;
  detail?: unknown;
  error?: string;
}

export interface GardenerReport {
  tick: "light" | "deep" | "sleep";
  catchUp: boolean;
  steps: GardenerStep[];
}

export interface RecallStats {
  total: number;
  byState: Record<MemoryState, number>;
  byScope: Record<string, number>;
  dbBytes: number;
  lastSleepAt?: number;
  rerankP50Ms?: number;
  fts: boolean;
  reembed?: { total: number; done: number; error?: string };
}

export interface RememberInput {
  content: string;
  scope: string;
  kind?: MemoryKind;
  importance?: number;
  tags?: string[];
  origin: MemoryOrigin;
  confidence?: number;
  eventAt?: number;
  sourceRef?: MemoryRecord["sourceRef"];
  embedding?: Float32Array;
  pinned?: boolean;
}

export interface RememberResult {
  id: string;
  action: "inserted" | "confirmed" | "updated" | "extended";
}

export interface TextModel {
  complete(
    system: string,
    user: string,
    opts: { temperature: number; timeoutMs: number; format?: Record<string, unknown>; numCtx?: number },
  ): Promise<{ text: string; promptTokens: number; completionTokens: number }>;
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export const LEGAL_SCOPE = "legal-alarraf";
export const KINDS: readonly MemoryKind[] = ["fact", "preference", "event", "relationship", "insight", "project", "procedure"];
