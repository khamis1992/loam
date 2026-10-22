/**
 * Loam UI Kit design registry.
 *
 * A registry of vetted, reusable UI blocks (hero, bento, pricing, dashboard
 * shell, auth, table, settings, empty states, RTL variants, ...). Each block
 * lives in `design-registry/blocks/<id>/manifest.json` and describes the
 * block's intent, tags, dependencies, tokens, source file and screenshot.
 *
 * Retrieval is deterministic and offline: BM25 over a weighted document built
 * from the manifest. An optional embedder can re-rank the BM25 shortlist with
 * cosine similarity so a semantic model can be plugged in later without
 * changing the registry format.
 */

import fs from "node:fs";
import path from "node:path";
import { DESIGN_REGISTRY_DIR } from "../config.js";

/** Block categories supported by the registry. */
export const DESIGN_BLOCK_TYPES = [
  "hero",
  "bento",
  "pricing",
  "dashboard",
  "auth",
  "table",
  "settings",
  "empty-state",
  "navigation",
  "cta",
  "testimonials",
  "faq",
  "stats",
  "onboarding",
  "footer",
  "gallery",
  "form",
] as const;

export type DesignBlockType = (typeof DESIGN_BLOCK_TYPES)[number];

/** One vetted UI block. Manifests are validated before they enter the registry. */
export interface DesignBlockManifest {
  /** Stable kebab-case identifier, unique across the registry. */
  id: string;
  name: string;
  description: string;
  type: string;
  /** Searchable keywords (English and Arabic). */
  tags: string[];
  /** Natural-language intents this block satisfies. */
  intents: string[];
  /** shadcn/ui or other component dependencies. */
  dependencies: string[];
  /** Design tokens the block consumes. */
  tokens: string[];
  /** Block source path, relative to the design-registry directory. */
  file: string;
  /** Optional screenshot path, relative to the design-registry directory. */
  screenshot?: string;
  /** True when the block ships an Arabic/RTL layout. */
  rtl?: boolean;
  accessibility?: string[];
  license?: string;
  source?: string;
  /** Short representative source snippet returned to the model. */
  code?: string;
}

/** A ranked search hit. */
export interface DesignBlockHit {
  id: string;
  name: string;
  type: string;
  description: string;
  tags: string[];
  intents: string[];
  dependencies: string[];
  tokens: string[];
  file: string;
  screenshot?: string;
  rtl: boolean;
  accessibility: string[];
  code?: string;
  score: number;
}

/** Minimal embedding surface; compatible with OllamaEmbedder.embedOne. */
export interface DesignEmbedder {
  embedOne(text: string): Promise<number[]>;
}

export interface SearchOptions {
  /** Number of hits to return (default 5, clamped to 1..20). */
  k?: number;
  /** Explicit registry directory; defaults to DESIGN_REGISTRY_DIR. */
  dir?: string;
  /** Restrict results to one block type. */
  type?: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_K = 5;
const MAX_K = 20;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Validate an unknown manifest; returns null when it is not a usable block. */
export function validateManifest(raw: unknown): DesignBlockManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["id"] !== "string" || !ID_PATTERN.test(o["id"])) return null;
  if (typeof o["name"] !== "string" || o["name"].trim().length === 0) return null;
  if (typeof o["description"] !== "string" || o["description"].trim().length === 0) return null;
  if (typeof o["type"] !== "string" || o["type"].trim().length === 0) return null;
  if (typeof o["file"] !== "string" || o["file"].trim().length === 0) return null;
  if (!isStringArray(o["tags"]) || !isStringArray(o["intents"])) return null;
  if (!isStringArray(o["dependencies"]) || !isStringArray(o["tokens"])) return null;
  const manifest: DesignBlockManifest = {
    id: o["id"],
    name: o["name"].trim(),
    description: o["description"].trim(),
    type: o["type"].trim(),
    tags: o["tags"],
    intents: o["intents"],
    dependencies: o["dependencies"],
    tokens: o["tokens"],
    file: o["file"].trim(),
    rtl: o["rtl"] === true,
    accessibility: isStringArray(o["accessibility"]) ? o["accessibility"] : [],
  };
  if (typeof o["screenshot"] === "string" && o["screenshot"].trim()) manifest.screenshot = o["screenshot"].trim();
  if (typeof o["license"] === "string" && o["license"].trim()) manifest.license = o["license"].trim();
  if (typeof o["source"] === "string" && o["source"].trim()) manifest.source = o["source"].trim();
  if (typeof o["code"] === "string" && o["code"].trim()) manifest.code = o["code"].trim();
  return manifest;
}

/**
 * Load every valid manifest under `<dir>/blocks/<id>/manifest.json`.
 * Invalid or duplicate manifests are skipped so one bad file cannot break the
 * whole registry. A missing directory yields an empty list.
 */
export function loadDesignRegistry(dir: string = DESIGN_REGISTRY_DIR): DesignBlockManifest[] {
  const blocksDir = path.join(dir, "blocks");
  if (!fs.existsSync(blocksDir)) return [];
  const out: DesignBlockManifest[] = [];
  const seen = new Set<string>();
  for (const entry of fs.readdirSync(blocksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(blocksDir, entry.name, "manifest.json");
    if (!fs.existsSync(file)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const manifest = validateManifest(raw);
    if (!manifest || seen.has(manifest.id)) continue;
    seen.add(manifest.id);
    out.push(manifest);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in",
  "is", "it", "its", "of", "on", "or", "that", "the", "this", "to", "with",
  "you", "your", "we", "our", "page", "section", "component", "block", "use",
  "from", "into", "over", "under", "show", "shows", "showing",
  "في", "من", "على", "إلى", "عن", "التي", "الذي", "هذا", "هذه", "ذلك", "مع", "أو", "لا", "ما",
]);

/** Tokenize into lowercase Unicode letters/numbers, dropping stopwords. */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return matches.filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** Weighted document: name/type/tags/intents carry more signal than prose. */
function documentText(block: DesignBlockManifest): string {
  const parts: string[] = [];
  const push = (value: string, times: number) => {
    for (let i = 0; i < times; i++) parts.push(value);
  };
  push(block.name, 4);
  push(block.type, 3);
  push(block.tags.join(" "), 3);
  push(block.intents.join(" "), 2);
  push(block.description, 1);
  push(block.tokens.join(" "), 1);
  return parts.join(" ");
}

function bm25Scores(query: string[], documents: string[]): number[] {
  const k1 = 1.2;
  const b = 0.75;
  const tokenized = documents.map(tokenize);
  const n = tokenized.length;
  const avgLen = tokenized.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, n);
  const documentFrequency = new Map<string, number>();
  for (const doc of tokenized) {
    for (const term of new Set(doc)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const queryTerms = [...new Set(query)];
  return tokenized.map((doc) => {
    const termFrequency = new Map<string, number>();
    for (const term of doc) termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const frequency = termFrequency.get(term) ?? 0;
      if (frequency === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const denominator = frequency + k1 * (1 - b + (b * doc.length) / Math.max(1, avgLen));
      score += (idf * frequency * (k1 + 1)) / denominator;
    }
    return score;
  });
}

function toHit(block: DesignBlockManifest, score: number): DesignBlockHit {
  return {
    id: block.id,
    name: block.name,
    type: block.type,
    description: block.description,
    tags: block.tags,
    intents: block.intents,
    dependencies: block.dependencies,
    tokens: block.tokens,
    file: block.file,
    ...(block.screenshot ? { screenshot: block.screenshot } : {}),
    rtl: block.rtl === true,
    accessibility: block.accessibility ?? [],
    ...(block.code ? { code: block.code } : {}),
    score,
  };
}

function clampK(k: number | undefined): number {
  if (!Number.isFinite(k)) return DEFAULT_K;
  return Math.max(1, Math.min(MAX_K, Math.round(k as number)));
}

/** BM25 search over the registry. Returns [] for an empty registry or query. */
export function searchDesignBlocks(query: string, options: SearchOptions = {}): DesignBlockHit[] {
  const dir = options.dir ?? DESIGN_REGISTRY_DIR;
  const blocks = loadDesignRegistry(dir);
  if (blocks.length === 0) return [];
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const scores = bm25Scores(terms, blocks.map(documentText));
  const indexes = blocks
    .map((_block, index) => index)
    .filter((index) => scores[index]! > 0)
    .filter((index) => !options.type || blocks[index]!.type === options.type)
    .sort((a, b) => scores[b]! - scores[a]!);
  return indexes.slice(0, clampK(options.k)).map((index) => toHit(blocks[index]!, scores[index]!));
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Re-rank a BM25 shortlist with an embedder. Scores are normalized and blended
 * so lexical and semantic signals contribute equally; without an embedder this
 * is a no-op. Blocks are re-sorted by the blended score.
 */
export async function rerankWithEmbeddings(
  hits: DesignBlockHit[],
  query: string,
  embedder: DesignEmbedder,
): Promise<DesignBlockHit[]> {
  if (hits.length === 0) return hits;
  const maxScore = Math.max(...hits.map((hit) => hit.score), 1);
  const queryVector = await embedder.embedOne(query);
  const scored = await Promise.all(
    hits.map(async (hit) => {
      const vector = await embedder.embedOne(documentText({
        id: hit.id,
        name: hit.name,
        description: hit.description,
        type: hit.type,
        tags: hit.tags,
        intents: hit.intents,
        dependencies: hit.dependencies,
        tokens: hit.tokens,
        file: hit.file,
        rtl: hit.rtl,
        accessibility: hit.accessibility,
      }));
      const semantic = Math.max(0, cosineSimilarity(queryVector, vector));
      const lexical = hit.score / maxScore;
      return { hit, score: 0.5 * lexical + 0.5 * semantic };
    }),
  );
  return scored
    .sort((a, b) => b.score - a.score)
    .map(({ hit, score }) => ({ ...hit, score }));
}
