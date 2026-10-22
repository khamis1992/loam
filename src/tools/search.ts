/**
 * Dedicated `grep` and `glob` tools (Claude Code parity, task C5).
 *
 * `grep` runs ripgrep when a binary is available (`rg` on PATH or an explicit
 * override) and falls back to a built-in, streaming-free scanner that mirrors
 * ripgrep semantics closely enough for agent use: regular expressions, output
 * modes (content / files_with_matches / count), line numbers, context lines,
 * case-insensitive search and glob include/exclude filters.
 *
 * `glob` enumerates files by name pattern and returns them ordered by
 * modification time (newest first) by default, matching the behaviour agents
 * expect from a fast file-locator.
 *
 * Both tools are read-only and confined to the workspace by the caller
 * (`resolveRead`), exactly like `file_search`.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { resolveRead } from "../policy/paths.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { bool, num, str } from "./registry.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  "out",
  "release",
  "coverage",
  "target",
  "vendor",
  ".manus",
  ".browser-profile",
  ".screenshots",
]);
const MAX_SCAN_FILES = 8000;
const MAX_FILE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESULTS = 200;

export type GrepOutputMode = "content" | "files_with_matches" | "count";
export type GlobSortBy = "mtime" | "name" | "path";

export interface GrepOptions {
  pattern: string;
  path?: string;
  outputMode?: GrepOutputMode;
  lineNumbers?: boolean;
  context?: number;
  glob?: string;
  caseInsensitive?: boolean;
  maxResults?: number;
}

export interface GrepResult {
  ok: boolean;
  mode: GrepOutputMode;
  content: string;
  matchCount: number;
  fileCount: number;
  truncated: boolean;
  engine: "ripgrep" | "js";
  error?: string;
}

export interface GlobOptions {
  pattern: string;
  path?: string;
  sortBy?: GlobSortBy;
  limit?: number;
  includeHidden?: boolean;
}

export interface GlobResult {
  ok: boolean;
  content: string;
  count: number;
  truncated: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Glob compilation
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Translate a single glob into a regular-expression source (no anchors). */
function globToRegExpSource(pattern: string): string {
  const p = pattern.replace(/\\/g, "/");
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        let j = i;
        while (p[j] === "*") j++;
        const prevSlash = i === 0 || p[i - 1] === "/";
        const nextSlash = p[j] === "/";
        if (prevSlash && nextSlash) {
          out += "(?:.*/)?";
          i = j;
          continue;
        }
        out += ".*";
        i = j - 1;
        continue;
      }
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      const end = p.indexOf("}", i);
      if (end === -1) {
        out += "\\{";
      } else {
        const inner = p.slice(i + 1, end);
        const parts = inner.split(",").map((part) => escapeRegex(part));
        out += `(?:${parts.join("|")})`;
        i = end;
      }
    } else if (c === "[") {
      const end = p.indexOf("]", i);
      if (end === -1) {
        out += "\\[";
      } else {
        out += p.slice(i, end + 1).replace(/^\[!/, "[^");
        i = end;
      }
    } else if ("\\^$.|+()".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return out;
}

export interface GlobMatcher {
  test(relPath: string, baseName: string): boolean;
}

/** Split on commas that are not nested inside `{...}` or `[...]`. */
function splitTopLevel(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of input) {
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Compile a comma-separated glob list (supporting `!` negation). */
export function compileGlobs(glob: string): GlobMatcher | null {
  const raw = splitTopLevel(glob).map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) return null;
  const positive: RegExp[] = [];
  const negative: RegExp[] = [];
  for (const p of raw) {
    if (p.startsWith("!")) {
      negative.push(new RegExp(`^(?:${globToRegExpSource(p.slice(1))})$`));
    } else {
      positive.push(new RegExp(`^(?:${globToRegExpSource(p)})$`));
    }
  }
  const matches = (rel: string, base: string): boolean =>
    positive.some((r) => r.test(rel) || r.test(base));
  const excluded = (rel: string, base: string): boolean =>
    negative.some((r) => r.test(rel) || r.test(base));
  if (positive.length === 0) {
    return { test: (rel, base) => !excluded(rel, base) };
  }
  return { test: (rel, base) => matches(rel, base) && !excluded(rel, base) };
}

// ---------------------------------------------------------------------------
// Shared file walk
// ---------------------------------------------------------------------------

interface WalkedFile {
  full: string;
  rel: string;
}

function walkFiles(
  root: string,
  matcher: GlobMatcher | null,
  opts: { maxFiles: number; timeoutMs: number; includeHidden: boolean },
): WalkedFile[] {
  const out: WalkedFile[] = [];
  const deadline = Date.now() + opts.timeoutMs;
  const stack: string[] = [root];
  let visited = 0;
  while (stack.length > 0 && visited < opts.maxFiles && Date.now() < deadline) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= opts.maxFiles || Date.now() > deadline) break;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (!opts.includeHidden && entry.name.startsWith(".")) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        visited += 1;
        if (!opts.includeHidden && entry.name.startsWith(".")) continue;
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (matcher && !matcher.test(rel, entry.name)) continue;
        out.push({ full, rel });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ripgrep fast path
// ---------------------------------------------------------------------------

function findRipgrep(): string | null {
  const overrides = [process.env.LOAM_RIPGREP_PATH, process.env.RIPGREP_PATH].filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  for (const candidate of overrides) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* ignore */
    }
  }
  const which = process.platform === "win32" ? "where" : "which";
  try {
    const res = spawnSync(which, ["rg"], { encoding: "utf8" });
    if (res.status === 0 && res.stdout) {
      const first = res.stdout.split(/\r?\n/)[0]?.trim();
      if (first) return first;
    }
  } catch {
    /* ignore */
  }
  return null;
}

interface RipgrepRun {
  ok: boolean;
  content: string;
  fileCount: number;
  error?: string;
}

function runRipgrep(root: string, isFile: boolean, opts: GrepOptions): RipgrepRun {
  const rg = findRipgrep();
  if (!rg) return { ok: false, content: "", fileCount: 0 };
  const mode = opts.outputMode ?? "content";
  const args: string[] = ["--no-heading", "--color", "never", "--with-filename", "--no-messages"];
  if (mode === "files_with_matches") args.push("--files-with-matches");
  else if (mode === "count") args.push("--count");
  else args.push(opts.lineNumbers === false ? "--no-line-number" : "--line-number");
  const context = Math.max(0, opts.context ?? 0);
  if (context > 0 && mode === "content") args.push("--context", String(context));
  if (opts.glob && opts.glob.trim()) args.push("--glob", opts.glob.trim());
  if (opts.caseInsensitive) args.push("--ignore-case");
  args.push("--regexp", opts.pattern);

  const cwd = isFile ? path.dirname(root) : root;
  const target = isFile ? path.basename(root) : ".";
  let res: SpawnSyncReturns<string>;
  try {
    res = spawnSync(rg, [...args, "--", target], { cwd, encoding: "utf8", timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    return { ok: false, content: "", fileCount: 0, error: err instanceof Error ? err.message : String(err) };
  }
  if (res.error || res.status === null) return { ok: false, content: "", fileCount: 0 };
  const stdout = res.stdout ?? "";
  if (res.status !== 0 && stdout.trim().length === 0) {
    return { ok: false, content: "", fileCount: 0, error: (res.stderr ?? "").trim() || `rg exited ${res.status}` };
  }
  const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
  const fileCount = mode === "count"
    ? lines.length
    : mode === "files_with_matches"
      ? lines.length
      : new Set(lines.map((l) => l.split(/:(?=\d+:|-)/)[0])).size;
  return { ok: true, content: lines.join("\n"), fileCount };
}

// ---------------------------------------------------------------------------
// Built-in scanner (JS fallback)
// ---------------------------------------------------------------------------

function countMatches(content: string, re: RegExp): number {
  return content.split(re).length - 1;
}

/** Longest literal run in the pattern; safe prefilter only when the whole
 *  pattern is a plain literal (no regex metacharacters, no alternation). */
function literalPrefilter(pattern: string): string | null {
  if (pattern.length < 2) return null;
  if (!/^[A-Za-z0-9_.\- ]+$/.test(pattern)) return null;
  return pattern;
}

/** Extensions that are never worth reading as text. */
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff",
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".mp3", ".wav", ".flac", ".ogg",
  ".zip", ".gz", ".tar", ".rar", ".7z", ".bz2", ".xz",
  ".pdf", ".exe", ".dll", ".so", ".dylib", ".bin", ".dat",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".db", ".sqlite", ".sqlite3", ".pyc", ".class", ".o", ".a",
]);

export async function grepInWorkspace(workspace: string, opts: GrepOptions): Promise<GrepResult> {
  const pattern = opts.pattern;
  const mode: GrepOutputMode = opts.outputMode ?? "content";
  if (!pattern) {
    return { ok: false, mode, content: "grep requires a pattern", matchCount: 0, fileCount: 0, truncated: false, engine: "js" };
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.caseInsensitive ? "i" : "");
  } catch (err) {
    return {
      ok: false,
      mode,
      content: `invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
      matchCount: 0,
      fileCount: 0,
      truncated: false,
      engine: "js",
    };
  }
  const matcher = compileGlobs(opts.glob ?? "");
  const root = path.resolve(opts.path && opts.path.trim() ? (path.isAbsolute(opts.path) ? opts.path : path.join(workspace, opts.path)) : workspace);
  let isFile = false;
  try {
    isFile = fs.statSync(root).isFile();
  } catch {
    return { ok: false, mode, content: `path not found: ${root}`, matchCount: 0, fileCount: 0, truncated: false, engine: "js" };
  }

  if (process.env.LOAM_SEARCH_FORCE_JS !== "1") {
    const rg = runRipgrep(root, isFile, opts);
    if (rg.ok) {
      const maxResults = Math.max(1, opts.maxResults ?? MAX_RESULTS);
      let content = rg.content;
      let truncated = false;
      if (mode === "content") {
        const lines = content.split("\n");
        if (lines.length > maxResults) {
          content = lines.slice(0, maxResults).join("\n");
          truncated = true;
        }
      } else {
        const lines = content.split("\n");
        if (lines.length > maxResults) {
          content = lines.slice(0, maxResults).join("\n");
          truncated = true;
        }
      }
      const matchCount = mode === "count"
        ? content.split("\n").reduce((sum, line) => sum + (Number(line.split(":").pop()) || 0), 0)
        : mode === "files_with_matches"
          ? rg.fileCount
          : countMatches(content, /:\d+:/g);
      return {
        ok: true,
        mode,
        content: content.length ? content : "(no matches)",
        matchCount,
        fileCount: rg.fileCount,
        truncated,
        engine: "ripgrep",
      };
    }
  }

  const maxResults = Math.max(1, opts.maxResults ?? MAX_RESULTS);
  const context = Math.min(Math.max(0, opts.context ?? 0), 20);
  const lineNumbers = opts.lineNumbers !== false;
  const literal = literalPrefilter(pattern);
  const prefilter = literal
    ? opts.caseInsensitive
      ? (content: string) => content.toLowerCase().includes(literal.toLowerCase())
      : (content: string) => content.includes(literal)
    : null;
  const out: string[] = [];
  let matchCount = 0;
  let fileCount = 0;
  let truncated = false;

  const walk: WalkedFile[] = isFile
    ? [{ full: root, rel: path.basename(root) }]
    : walkFiles(root, matcher, { maxFiles: MAX_SCAN_FILES, timeoutMs: DEFAULT_TIMEOUT_MS, includeHidden: false });

  // Drop oversized and binary files before reading anything.
  const candidates: WalkedFile[] = [];
  for (const file of walk) {
    if (BINARY_EXT.has(path.extname(file.full).toLowerCase())) continue;
    try {
      if (fs.statSync(file.full).size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }
    candidates.push(file);
  }

  const processContent = (file: WalkedFile, content: string): void => {
    if (content.includes("\0")) return;
    if (prefilter && !prefilter(content)) return;
    const lines = content.split(/\r?\n/);
    if (mode === "files_with_matches") {
      if (lines.some((line) => re.test(line))) {
        fileCount += 1;
        out.push(file.rel);
        if (fileCount >= maxResults) truncated = true;
      }
      return;
    }
    if (mode === "count") {
      let count = 0;
      for (const line of lines) if (re.test(line)) count += 1;
      if (count > 0) {
        fileCount += 1;
        matchCount += count;
        out.push(`${file.rel}:${count}`);
        if (fileCount >= maxResults) truncated = true;
      }
      return;
    }

    const include = new Set<number>();
    let hits = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i]!)) continue;
      hits += 1;
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) include.add(k);
    }
    if (hits === 0) return;
    fileCount += 1;
    let last = -2;
    for (let i = 0; i < lines.length; i++) {
      if (!include.has(i)) continue;
      if (context > 0 && last !== -2 && i > last + 1) out.push(`${file.rel}--`);
      const line = lines[i]!;
      if (re.test(line)) {
        matchCount += 1;
        out.push(lineNumbers ? `${file.rel}:${i + 1}:${line}` : `${file.rel}:${line}`);
      } else {
        out.push(`${file.rel}-${i + 1}-${line}`);
      }
      last = i;
      if (matchCount >= maxResults) {
        truncated = true;
        break;
      }
    }
  };

  // Read in concurrent chunks so large workspaces stay fast on disk.
  const CHUNK = 64;
  for (let i = 0; i < candidates.length && !truncated; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    const contents = await Promise.all(
      chunk.map((file) => fs.promises.readFile(file.full, "utf8").catch(() => null)),
    );
    for (let j = 0; j < chunk.length && !truncated; j++) {
      const content = contents[j];
      if (content == null) continue;
      processContent(chunk[j]!, content);
    }
  }

  return {
    ok: true,
    mode,
    content: out.length ? out.join("\n") : "(no matches)",
    matchCount,
    fileCount,
    truncated,
    engine: "js",
  };
}

export function globInWorkspace(workspace: string, opts: GlobOptions): GlobResult {
  const pattern = opts.pattern;
  if (!pattern || !pattern.trim()) {
    return { ok: false, content: "glob requires a pattern", count: 0, truncated: false };
  }
  const matcher = compileGlobs(pattern);
  if (!matcher) {
    return { ok: false, content: `invalid glob pattern: ${pattern}`, count: 0, truncated: false };
  }
  const root = path.resolve(opts.path && opts.path.trim() ? (path.isAbsolute(opts.path) ? opts.path : path.join(workspace, opts.path)) : workspace);
  let isFile = false;
  try {
    isFile = fs.statSync(root).isFile();
  } catch {
    return { ok: false, content: `path not found: ${root}`, count: 0, truncated: false };
  }
  const sortBy: GlobSortBy = opts.sortBy ?? "mtime";
  const limit = Math.max(1, opts.limit ?? MAX_RESULTS);

  const files: WalkedFile[] = isFile
    ? [{ full: root, rel: path.basename(root) }]
    : walkFiles(root, matcher, { maxFiles: MAX_SCAN_FILES, timeoutMs: DEFAULT_TIMEOUT_MS, includeHidden: opts.includeHidden === true });

  const entries: Array<{ rel: string; mtime: number; size: number }> = [];
  for (const file of files) {
    try {
      const st = fs.statSync(file.full);
      if (!st.isFile()) continue;
      entries.push({ rel: file.rel, mtime: st.mtimeMs, size: st.size });
    } catch {
      /* ignore */
    }
  }

  if (sortBy === "name") entries.sort((a, b) => a.rel.localeCompare(b.rel));
  else if (sortBy === "path") entries.sort((a, b) => a.rel.split("/").length - b.rel.split("/").length || a.rel.localeCompare(b.rel));
  else entries.sort((a, b) => b.mtime - a.mtime || a.rel.localeCompare(b.rel));

  const truncated = entries.length > limit;
  const shown = entries.slice(0, limit);
  const content = shown.length ? shown.map((e) => e.rel).join("\n") : "(no files matched)";
  return { ok: true, content, count: shown.length, truncated };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const OUTPUT_MODES: GrepOutputMode[] = ["content", "files_with_matches", "count"];

export function searchTools(): Tool[] {
  return [
    {
      name: "grep",
      description:
        "Search file contents recursively with a regular expression. Uses ripgrep when available and a fast built-in scanner otherwise, so it stays quick on large workspaces. " +
        "Choose output_mode: 'content' shows matching lines as `path:line:text` (add `context` lines around each match); 'files_with_matches' lists only the file paths; 'count' lists `path:count` per file. " +
        "Set `lineNumbers` false to drop line numbers in content mode, `caseInsensitive` for case-insensitive matching, and `glob` to include/exclude files (comma-separated, `!` negates, e.g. '*.ts,!*.test.ts'). " +
        "Prefer this over `grep`/`rg` through `shell_run` and over `file_search` when you need regex, context or output modes. Search the narrowest directory you can and cap results with `maxResults`.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for." },
          path: { type: "string", description: "File or directory to search (default: workspace root)." },
          output_mode: { type: "string", enum: OUTPUT_MODES, description: "Output shape: content (default), files_with_matches, or count." },
          lineNumbers: { type: "boolean", description: "Prefix content matches with line numbers (default true)." },
          context: { type: "number", description: "Lines of context before and after each match (content mode only, default 0)." },
          glob: { type: "string", description: "Comma-separated glob filter on paths, e.g. '*.ts' or '*.ts,!*.test.ts'." },
          caseInsensitive: { type: "boolean", description: "Case-insensitive matching (default false)." },
          maxResults: { type: "number", description: "Maximum files or matches to return (default 200)." },
        },
        required: ["pattern"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const relPath = str(args, "path");
        const root = resolveRead(ctx.workspace, relPath || ctx.workspace, ctx.cfg.policy.allowOutsideWorkspaceRead);
        const opts: GrepOptions = {
          pattern: str(args, "pattern"),
          path: root,
          outputMode: (str(args, "output_mode") || "content") as GrepOutputMode,
          lineNumbers: bool(args, "lineNumbers", true),
          context: num(args, "context", 0),
          glob: str(args, "glob"),
          caseInsensitive: bool(args, "caseInsensitive", false),
          maxResults: num(args, "maxResults", MAX_RESULTS),
        };
        const res = await grepInWorkspace(ctx.workspace, opts);
        if (!res.ok) return { ok: false, content: `grep failed: ${res.error ?? res.content}` };
        const header = `${res.matchCount} match${res.matchCount === 1 ? "" : "es"} in ${res.fileCount} file${res.fileCount === 1 ? "" : "s"} (${res.engine})`;
        const note = res.truncated ? `\n[truncated to ${opts.maxResults} result(s)]` : "";
        return { ok: true, content: `${res.content}\n${header}${note}` };
      },
    },
    {
      name: "glob",
      description:
        "Find files by name pattern anywhere under a directory. Supports `**` for recursive matching, `*` and `?` wildcards, and `{a,b}` alternation; comma-separated patterns are OR-ed and a leading `!` excludes. " +
        "Results are returned as workspace-relative paths sorted by modification time (newest first) by default; use sortBy 'name' or 'path' for a stable order. " +
        "Use this to locate recently changed files, or to enumerate candidate files before reading them. Prefer it over a recursive `file_list` when you need pattern matching or mtime ordering.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts' or 'src/**/*.{ts,tsx}'." },
          path: { type: "string", description: "Root directory (default: workspace root)." },
          sortBy: { type: "string", enum: ["mtime", "name", "path"], description: "Sort order (default mtime, newest first)." },
          limit: { type: "number", description: "Maximum results (default 200)." },
          includeHidden: { type: "boolean", description: "Include dotfiles and hidden directories (default false)." },
        },
        required: ["pattern"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const relPath = str(args, "path");
        const root = resolveRead(ctx.workspace, relPath || ctx.workspace, ctx.cfg.policy.allowOutsideWorkspaceRead);
        const opts: GlobOptions = {
          pattern: str(args, "pattern"),
          path: root,
          sortBy: (str(args, "sortBy") || "mtime") as GlobSortBy,
          limit: num(args, "limit", MAX_RESULTS),
          includeHidden: bool(args, "includeHidden", false),
        };
        const res = globInWorkspace(ctx.workspace, opts);
        if (!res.ok) return { ok: false, content: `glob failed: ${res.error ?? res.content}` };
        const note = res.truncated ? `\n[truncated to ${opts.limit} result(s)]` : "";
        return { ok: true, content: `${res.content}\n${res.count} file${res.count === 1 ? "" : "s"}${note}` };
      },
    },
  ];
}

