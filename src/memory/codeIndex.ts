/**
 * Incremental code index for a project.
 *
 * Chunks source files (respecting `.gitignore` and skipping `node_modules`,
 * `dist`, ...), embeds each chunk with the shared `OllamaEmbedder`, and stores
 * the vectors in SQLite (`node:sqlite`, no new dependency). Re-indexing walks
 * the tree and only re-embeds files whose content hash changed; deleted files
 * are pruned. When no embedding backend is available the index falls back to a
 * pure-TS BM25 scorer over the chunk text, so `semantic_search` still works
 * offline.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { log } from "../log.js";
import { dot, fromBase64, normalize, toBase64 } from "./embeddings.js";

/** File extensions we index. Text formats only; binaries are never read. */
const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".kt", ".rb", ".php", ".cs", ".c", ".cc", ".cpp", ".h", ".hpp", ".swift",
  ".sh", ".bash", ".sql", ".json", ".yaml", ".yml", ".toml", ".md", ".vue",
  ".svelte",
]);
/** Directories that are always skipped, whatever `.gitignore` says. */
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "release", ".git", ".next", ".venv",
  "__pycache__", "target", "vendor", "coverage", ".screenshots", ".manus",
]);
/** Hard caps so one pathological tree cannot stall an agent step. */
const MAX_FILE_BYTES = 400_000;
const MAX_FILES = 20_000;
const MAX_CHUNK_CHARS = 4_000;
const MAX_CHUNKS_PER_FILE = 60;
const EMBED_BATCH = 16;

export interface CodeChunk {
  /** Primary key: `${file}::${startLine}-${endLine}` */
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  /** base64 normalized Float32 vector, or null when embedded without a backend */
  vector: string | null;
}

export interface SearchHit {
  file: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  /** Which scorer produced the score ("vector" or "bm25"). */
  via: "vector" | "bm25";
}

export interface IndexStats {
  files: number;
  chunks: number;
  indexedAt: string;
  mode: "vector" | "bm25";
}

/** Minimal dependency-free `.gitignore` matcher (globs, negation, dirs). */
export class IgnoreMatcher {
  private readonly rules: Array<{ negated: boolean; regex: RegExp; dirOnly: boolean; anchored: boolean }> = [];

  constructor(rules: string[]) {
    for (const raw of rules) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      let body = line;
      let negated = false;
      if (body.startsWith("!")) {
        negated = true;
        body = body.slice(1);
      }
      let dirOnly = false;
      if (body.endsWith("/")) {
        dirOnly = true;
        body = body.slice(0, -1);
      }
      const anchored = body.startsWith("/") || body.includes("/");
      if (body.startsWith("/")) body = body.slice(1);
      const pattern = body
        .split("/")
        .map((seg) => (seg === "**" ? "**" : seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")))
        .join("/");
      const regex = new RegExp(anchored ? `^${pattern}(?:/.*)?$` : `^(?:.*/)?${pattern}(?:/.*)?$`);
      this.rules.push({ negated, regex, dirOnly, anchored });
    }
  }

  /** True when the relative path (POSIX separators) is ignored. A directory
   *  rule (`build/`) also covers every path beneath it, via the `(?:/.*)?`
   *  suffix in the compiled pattern. */
  isIgnored(relPath: string, _isDir: boolean): boolean {
    const normalized = relPath.split(path.sep).join("/");
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.regex.test(normalized)) ignored = !rule.negated;
    }
    return ignored;
  }
}

/** Load every `.gitignore` in the tree and fold them into one matcher. */
function loadIgnoreMatchers(root: string): IgnoreMatcher {
  const patterns: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".gitignore") {
        try {
          patterns.push(fs.readFileSync(path.join(dir, entry.name), "utf8"));
        } catch {
          /* ignore */
        }
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(path.join(dir, entry.name));
    }
  };
  walk(root);
  return new IgnoreMatcher(patterns.join("\n").split(/\r?\n/));
}

export function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

/** Split a file into overlapping, line-aligned chunks of at most `maxChars`. */
export function chunkSource(content: string, maxChars = MAX_CHUNK_CHARS, maxChunks = MAX_CHUNKS_PER_FILE): Array<{ startLine: number; endLine: number; text: string }> {
  const lines = content.split(/\r?\n/);
  const chunks: Array<{ startLine: number; endLine: number; text: string }> = [];
  let start = 0;
  while (start < lines.length && chunks.length < maxChunks) {
    let size = 0;
    let end = start;
    while (end < lines.length && (end === start || size + (lines[end]?.length ?? 0) + 1 <= maxChars)) {
      size += (lines[end]?.length ?? 0) + 1;
      end++;
    }
    if (end === start) end = start + 1;
    chunks.push({ startLine: start + 1, endLine: end, text: lines.slice(start, end).join("\n") });
    if (end >= lines.length) break;
    start = Math.max(end - 4, start + 1);
  }
  return chunks;
}

/** Common English words that carry no retrieval signal. They are dropped from
 *  both documents and queries so a question like "where are permissions
 *  checked" ranks on `permissions`/`checked` instead of on `where`/`are`. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "did", "do", "does",
  "for", "from", "had", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its", "me",
  "my", "no", "not", "of", "on", "or", "our", "so", "that", "the", "their", "them", "then", "there",
  "these", "they", "this", "to", "up", "us", "was", "we", "were", "what", "when", "where", "which",
  "who", "why", "will", "with", "you", "your",
]);

/** Fold a simple plural onto its singular so `permissions` matches
 *  `permission`. Words already ending in `ss` (`class`) are left alone. */
function foldPlural(token: string): string {
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

/** Lower-cased tokens used by the BM25 fallback.
 *
 * Source code is identifier-heavy, so `assertPermissions` is split into
 * `assert` + `permissions` (and `snake_case` on its underscores) before being
 * lower-cased and plural-folded. Without that split, a query for "permissions"
 * could never match the identifier that actually implements the check. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9_]+/)) {
    if (!raw) continue;
    for (const part of raw.split(/_+/)) {
      if (!part) continue;
      const split = part
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
      for (const piece of split.split(/\s+/)) {
        const token = foldPlural(piece.toLowerCase());
        if (token.length >= 2 && !STOPWORDS.has(token)) out.push(token);
      }
    }
  }
  return out;
}

export interface CodeIndexOptions {
  /** Absolute path to the index database (defaults to `<root>/.loam/code-index.db`). */
  dbPath?: string;
  /** Embedder to use; when omitted the index works in BM25/FTS fallback mode. */
  embedder?: { embed(texts: string[]): Promise<number[][]> };
  /** Chunk size in characters. */
  chunkChars?: number;
  /** Model name recorded in the index metadata. */
  model?: string;
  /** Cap the number of files scanned (default 20000). */
  maxFiles?: number;
}

export class CodeIndex {
  private readonly root: string;
  private readonly db: DatabaseSync;
  private embedder: { embed(texts: string[]): Promise<number[][]> } | null;
  private readonly chunkChars: number;
  private readonly model: string;
  private readonly maxFiles: number;
  private mode: "vector" | "bm25" = "bm25";
  private lastScan = 0;

  constructor(root: string, opts: CodeIndexOptions = {}) {
    this.root = path.resolve(root);
    const dbPath = opts.dbPath ?? path.join(this.root, ".loam", "code-index.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      file TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      text TEXT NOT NULL,
      hash TEXT NOT NULL,
      vector TEXT,
      dim INTEGER NOT NULL DEFAULT 0,
      model TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.embedder = opts.embedder ?? null;
    this.chunkChars = Math.max(500, opts.chunkChars ?? MAX_CHUNK_CHARS);
    this.model = opts.model ?? "bm25";
    this.maxFiles = Math.max(1, opts.maxFiles ?? MAX_FILES);
  }

  /** The scoring mode after the last `index()` (`bm25` when no backend). */
  get scoringMode(): "vector" | "bm25" {
    return this.mode;
  }

  private meta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value?: string } | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  /** Walk the tree once, re-index changed files and prune deleted ones.
   *  Files whose content hash is unchanged are skipped, so a second scan only
   *  re-reads what actually changed. */
  async index(opts: { signal?: AbortSignal } = {}): Promise<{ files: number; chunks: number; reindexed: number; removed: number; skipped: number; mode: "vector" | "bm25" }> {
    const started = Date.now();
    const ignore = loadIgnoreMatchers(this.root);
    const seen = new Set<string>();
    const fileStack: string[] = [this.root];
    let scanned = 0;
    let skipped = 0;

    while (fileStack.length > 0) {
      if (opts.signal?.aborted) throw new Error("code index aborted");
      const dir = fileStack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.root, full).split(path.sep).join("/");
        if (ignore.isIgnored(rel, entry.isDirectory())) continue;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          fileStack.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!CODE_EXT.has(ext)) continue;
        if (seen.size >= this.maxFiles) continue;
        seen.add(rel);
        const changed = await this.indexFile(full, rel);
        if (changed) scanned++;
        else skipped++;
      }
    }

    // Prune chunks whose file is gone (or was ignored this run).
    const keep = new Set(seen);
    const indexedFiles = this.db.prepare("SELECT DISTINCT file FROM chunks").all() as Array<{ file: string }>;
    let removed = 0;
    for (const row of indexedFiles) {
      if (!keep.has(row.file)) {
        const res = this.db.prepare("DELETE FROM chunks WHERE file=?").run(row.file);
        removed += Number(res.changes);
      }
    }

    const mode = this.embedder ? "vector" : "bm25";
    this.mode = mode;
    this.setMeta("indexedAt", new Date().toISOString());
    this.setMeta("mode", mode);
    const files = Number((this.db.prepare("SELECT COUNT(DISTINCT file) AS n FROM chunks").get() as { n: number }).n);
    const chunks = Number((this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n);
    this.lastScan = Date.now();
    log.info(`code-index: ${scanned} files re-indexed, ${skipped} unchanged, ${chunks} chunks (${mode}) in ${Date.now() - started}ms`);
    return { files, chunks, reindexed: scanned, removed, skipped, mode };
  }

  /** Index one file only when its content hash changed. Returns true when the
   *  file was re-chunked (and re-embedded). The file is read once per scan. */
  private async indexFile(full: string, rel: string): Promise<boolean> {
    let content: string;
    try {
      const stat = fs.statSync(full);
      if (stat.size > MAX_FILE_BYTES) {
        this.db.prepare("DELETE FROM chunks WHERE file=?").run(rel);
        return true;
      }
      content = fs.readFileSync(full, "utf8");
    } catch {
      this.db.prepare("DELETE FROM chunks WHERE file=?").run(rel);
      return true;
    }
    const hash = hashContent(content);
    const existing = this.db.prepare("SELECT hash FROM chunks WHERE file=? LIMIT 1").get(rel) as { hash?: string } | undefined;
    if (existing && existing.hash === hash) return false;
    const pieces = chunkSource(content, this.chunkChars);
    // A pathologically large file is truncated at MAX_CHUNKS_PER_FILE so one file
    // cannot stall a step. Say so, rather than silently dropping its tail.
    const lastPiece = pieces[pieces.length - 1];
    if (lastPiece) {
      const totalLines = content.split(/\r?\n/).length;
      if (lastPiece.endLine < totalLines) {
        log.warn(`code-index: ${rel} truncated at ${pieces.length} chunks (lines 1-${lastPiece.endLine} of ${totalLines})`);
      }
    }
    this.db.prepare("DELETE FROM chunks WHERE file=?").run(rel);
    if (pieces.length === 0) return true;

    const vectors: Array<number[] | null> = this.embedder
      ? (await this.embedBatched(pieces.map((p) => p.text))).map((v) => (v.length > 0 ? v : null))
      : pieces.map(() => null);
    const insert = this.db.prepare(
      "INSERT INTO chunks(id,file,start_line,end_line,text,hash,vector,dim,model) VALUES(?,?,?,?,?,?,?,?,?)",
    );
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      const vec = vectors[i] ?? null;
      insert.run(
        `${rel}::${piece.startLine}-${piece.endLine}`,
        rel,
        piece.startLine,
        piece.endLine,
        piece.text,
        hash,
        vec ? toBase64(normalize(vec)) : null,
        vec ? vec.length : 0,
        vec ? this.model : null,
      );
    }
    return true;
  }

  private async embedBatched(texts: string[]): Promise<number[][]> {
    if (!this.embedder) return texts.map(() => []);
    const out: number[][] = new Array(texts.length);
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      let vectors: number[][];
      try {
        vectors = await this.embedder.embed(batch);
      } catch (err) {
        log.warn(`code-index: embedding failed (${err instanceof Error ? err.message : String(err)}); falling back to BM25`);
        this.mode = "bm25";
        this.embedder = null;
        return texts.map(() => []);
      }
      for (let j = 0; j < vectors.length; j++) out[i + j] = vectors[j]!;
    }
    return out;
  }

  /** Search the index. Returns file:line ranges with a snippet. */
  async search(query: string, k = 5): Promise<SearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const rows = this.db
      .prepare("SELECT file,start_line,end_line,text,vector,dim,model FROM chunks ORDER BY file,start_line")
      .all() as Array<{ file: string; start_line: number; end_line: number; text: string; vector: string | null; dim: number; model: string | null }>;
    if (rows.length === 0) return [];

    if (this.mode === "vector" && this.embedder) {
      let q: Float32Array;
      try {
        const [vec] = await this.embedder.embed([trimmed]);
        if (!vec || vec.length === 0) throw new Error("empty embedding");
        q = normalize(vec);
      } catch (err) {
        log.warn(`code-index: query embedding failed (${err instanceof Error ? err.message : String(err)}); using BM25`);
        return this.bm25(rows, tokenize(trimmed), k, "bm25");
      }
      const scored = rows
        .filter((r) => r.vector)
        .map((r) => ({ row: r, score: dot(q, fromBase64(r.vector!, r.dim || q.length)) }))
        .filter((s) => Number.isFinite(s.score) && s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, k));
      return scored.map((s) => this.toHit(s.row, s.score, "vector"));
    }

    return this.bm25(rows, tokenize(trimmed), k, "bm25");
  }

  private bm25(
    rows: Array<{ file: string; start_line: number; end_line: number; text: string }>,
    terms: string[],
    k: number,
    via: "bm25",
  ): SearchHit[] {
    if (terms.length === 0) return [];
    const n = rows.length;
    const avgLen = rows.reduce((sum, r) => sum + r.text.length, 0) / Math.max(1, n);
    const k1 = 1.5;
    const b = 0.75;
    const docFreq = new Map<string, number>();
    const docTokens = rows.map((r) => {
      const tokens = tokenize(r.text);
      for (const term of new Set(tokens)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      return tokens;
    });
    const scored = rows.map((row, i) => {
      const tokens = docTokens[i]!;
      const len = tokens.length;
      let score = 0;
      for (const term of terms) {
        const tf = tokens.filter((t) => t === term).length;
        if (tf === 0) continue;
        const df = docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / Math.max(1, avgLen)));
      }
      return { row, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, k))
      .map((s) => this.toHit(s.row, s.score, via));
  }

  private toHit(row: { file: string; start_line: number; end_line: number; text: string }, score: number, via: "vector" | "bm25"): SearchHit {
    const snippet = row.text.replace(/\s+/g, " ").trim().slice(0, 220);
    return { file: row.file, startLine: row.start_line, endLine: row.end_line, score, snippet, via };
  }

  stats(): IndexStats {
    const chunks = Number((this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n);
    const files = Number((this.db.prepare("SELECT COUNT(DISTINCT file) AS n FROM chunks").get() as { n: number }).n);
    return {
      files,
      chunks,
      indexedAt: this.meta("indexedAt") ?? "",
      mode: this.embedder ? "vector" : "bm25",
    };
  }

  /** Files currently in the index, sorted. */
  files(): string[] {
    return (this.db.prepare("SELECT DISTINCT file FROM chunks ORDER BY file").all() as Array<{ file: string }>).map((r) => r.file);
  }

  close(): void {
    this.db.close();
  }
}

/** Convenience: build an index over `root` and run one query. */
export async function semanticSearch(root: string, query: string, k = 5, opts: CodeIndexOptions = {}): Promise<SearchHit[]> {
  const index = new CodeIndex(root, opts);
  try {
    await index.index();
    return index.search(query, k);
  } finally {
    index.close();
  }
}
