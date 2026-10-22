/**
 * Project memory (LOAM.md / AGENTS.md / CLAUDE.md).
 *
 * Implements the hierarchical project-rules behaviour the master prompt already
 * describes (A§11.3): a user-level file, a project-level file, compatibility
 * files, subdirectory files loaded on demand when a file there is read, and
 * `@path` / `#[[file:path]]` imports with a bounded depth and a cycle guard.
 *
 * Every read is fail-safe: a missing, unreadable or oversized file never breaks
 * prompt assembly. The loader is synchronous on purpose so it can run inside
 * the system-prompt builder and inside file_read without an async boundary.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Project memory file names, in priority order. */
export const PROJECT_MEMORY_FILES = ["LOAM.md", "AGENTS.md", "CLAUDE.md"] as const;
export const DEFAULT_PROJECT_MEMORY_FILE = PROJECT_MEMORY_FILES[0]!;

export interface ProjectMemoryOptions {
  /** User-level memory directory. Defaults to `~/.loam` (LOAM_HOME override). */
  homeDir?: string;
  /** Maximum `@path` import depth (default 5). */
  maxImportDepth?: number;
  /** Total rendered budget in characters (default 60_000). */
  maxBytes?: number;
  /** Per-file budget in characters (default 24_000). */
  maxFileBytes?: number;
}

export interface ProjectMemoryResult {
  /** Rendered block ready to append to a system prompt ("" when nothing loaded). */
  text: string;
  /** Absolute paths of the files actually included, in load order. */
  files: string[];
  /** True when the budget or the import depth stopped further content. */
  truncated: boolean;
  /** Number of import cycles detected and skipped. */
  cycles: number;
}

/** User-level memory directory: `~/.loam`, overridable for tests and packaging. */
export function defaultHomeDir(): string {
  const fromEnv = process.env.LOAM_HOME ?? process.env.MANUS_LOCAL_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".loam");
}

function resolveOptions(opts: ProjectMemoryOptions = {}): Required<ProjectMemoryOptions> {
  return {
    homeDir: opts.homeDir ?? defaultHomeDir(),
    maxImportDepth: Math.max(0, opts.maxImportDepth ?? 5),
    maxBytes: Math.max(1, opts.maxBytes ?? 60_000),
    maxFileBytes: Math.max(1, opts.maxFileBytes ?? 24_000),
  };
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function realKey(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

interface LoaderState {
  opts: Required<ProjectMemoryOptions>;
  workspace: string;
  homeDir: string;
  files: string[];
  chunks: string[];
  size: number;
  truncated: boolean;
  cycles: number;
  loaded: Set<string>;
}

function newState(workspace: string, opts: Required<ProjectMemoryOptions>): LoaderState {
  return {
    opts,
    workspace: path.resolve(workspace),
    homeDir: path.resolve(opts.homeDir),
    files: [],
    chunks: [],
    size: 0,
    truncated: false,
    cycles: 0,
    loaded: new Set<string>(),
  };
}

function finalize(state: LoaderState): ProjectMemoryResult {
  return {
    text: state.chunks.join("\n\n"),
    files: state.files,
    truncated: state.truncated,
    cycles: state.cycles,
  };
}

/** Human-friendly label: workspace-relative, then `~/...`, then absolute. */
function label(state: LoaderState, file: string): string {
  const relWs = path.relative(state.workspace, file);
  if (relWs && !relWs.startsWith("..") && !path.isAbsolute(relWs)) return relWs.split(path.sep).join("/");
  const relHome = path.relative(state.homeDir, file);
  if (relHome && !relHome.startsWith("..") && !path.isAbsolute(relHome)) return `~/${relHome.split(path.sep).join("/")}`;
  return file;
}

function appendWithinBudget(state: LoaderState, section: string): boolean {
  if (state.size + section.length + 1 > state.opts.maxBytes) {
    state.truncated = true;
    return false;
  }
  state.chunks.push(section);
  state.size += section.length + 1;
  return true;
}

/** Match a line that imports another memory file: `@path` or `#[[file:path]]`. */
function matchImport(line: string): string | null {
  const at = /^\s*@(\S(?:.*?\S)?)\s*$/.exec(line);
  if (at) return at[1]!;
  const wiki = /^\s*#\[\[file:(.+?)\]\]\s*$/.exec(line);
  if (wiki) return wiki[1]!.trim();
  return null;
}

function resolveImport(spec: string, baseDir: string): string | null {
  const cleaned = spec.trim().replace(/^["']|["']$/g, "");
  if (!cleaned) return null;
  const target = path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(baseDir, cleaned);
  return isFile(target) ? target : null;
}

/**
 * Read one memory file, expanding its imports depth-first. `stack` holds the
 * active import chain so a cycle is detected and skipped instead of looping;
 * `loaded` prevents a file already included from being rendered twice.
 */
function loadFileInto(file: string, state: LoaderState, depth: number, stack: Set<string>): void {
  const key = realKey(file);
  if (state.loaded.has(key)) return;
  if (stack.has(key)) {
    state.cycles++;
    return;
  }
  if (depth > state.opts.maxImportDepth) {
    state.truncated = true;
    return;
  }
  if (!isFile(file)) return;
  stack.add(key);
  state.files.push(file);

  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    stack.delete(key);
    return;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  if (raw.length > state.opts.maxFileBytes) {
    raw = `${raw.slice(0, state.opts.maxFileBytes)}\n[...truncated ${raw.length - state.opts.maxFileBytes} chars]`;
    state.truncated = true;
  }

  const lines = raw.split(/\r?\n/);
  const body: string[] = [];
  for (const line of lines) {
    const imp = matchImport(line);
    if (imp) {
      const target = resolveImport(imp, path.dirname(file));
      if (target) loadFileInto(target, state, depth + 1, stack);
      else state.truncated = true;
      continue;
    }
    body.push(line);
  }

  const content = body.join("\n").trim();
  if (content) appendWithinBudget(state, `## Project memory: ${label(state, file)}\n${content}`);

  stack.delete(key);
  state.loaded.add(key);
}

function loadRulesDir(root: string, state: LoaderState): void {
  const rulesDir = path.join(root, ".loam", "rules");
  if (!isDirectory(rulesDir)) return;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(rulesDir).filter((n) => n.toLowerCase().endsWith(".md")).sort();
  } catch {
    return;
  }
  for (const name of entries) loadFileInto(path.join(rulesDir, name), state, 0, new Set());
}

/**
 * Load the project memory that applies to a whole run: the user-level file,
 * the project-level file, their compatibility names, `.loam/rules/*.md`, and
 * any `@path` imports reachable from them.
 */
export function loadProjectMemory(workspace: string, opts: ProjectMemoryOptions = {}): ProjectMemoryResult {
  const o = resolveOptions(opts);
  const state = newState(workspace, o);
  for (const root of [state.homeDir, state.workspace]) {
    for (const name of PROJECT_MEMORY_FILES) {
      const file = path.join(root, name);
      if (isFile(file)) loadFileInto(file, state, 0, new Set());
    }
    loadRulesDir(root, state);
    if (state.truncated) break;
  }
  return finalize(state);
}

/**
 * Load the subdirectory memory that applies to a specific file: walk from the
 * file's directory up to the workspace root and include the nearest memory file
 * in each directory. `includeRoot` is false by default because the workspace
 * root is already part of the system prompt.
 */
export function loadMemoryForFile(
  filePath: string,
  workspace: string,
  opts: ProjectMemoryOptions = {},
  includeRoot = false,
): ProjectMemoryResult {
  const o = resolveOptions(opts);
  const state = newState(workspace, o);
  const root = state.workspace;

  let dir = path.resolve(filePath);
  if (isFile(filePath)) dir = path.dirname(filePath);

  const within = (d: string): boolean => {
    const rel = path.relative(root, d);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  if (!within(dir)) return finalize(state);

  const dirs: string[] = [];
  let cur = dir;
  while (within(cur)) {
    dirs.push(cur);
    if (cur === root) break;
    cur = path.dirname(cur);
  }

  for (const d of dirs) {
    if (d === root && !includeRoot) continue;
    for (const name of PROJECT_MEMORY_FILES) {
      const file = path.join(d, name);
      if (isFile(file)) loadFileInto(file, state, 0, new Set());
    }
  }
  return finalize(state);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Quick-add one note to a project memory file. The note is filed under a
 * `## <section>` heading (created at the end when absent). The target must stay
 * inside the workspace.
 */
export function appendMemoryEntry(
  text: string,
  workspace: string,
  file: string = DEFAULT_PROJECT_MEMORY_FILE,
  section = "Memory",
): { file: string; entry: string } {
  const ws = path.resolve(workspace);
  const target = path.isAbsolute(file) ? path.normalize(file) : path.resolve(ws, file);
  if (target !== ws && !target.startsWith(ws + path.sep)) {
    throw new Error(`memory_add target escapes the workspace: ${file}`);
  }
  const entry = `- ${text.replace(/\s+/g, " ").trim()}`;
  const heading = `## ${section}`;
  const headingRe = new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, "i");

  let existing = "";
  if (fs.existsSync(target)) existing = fs.readFileSync(target, "utf8");

  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const idx = lines.findIndex((line) => headingRe.test(line));
  if (idx >= 0) {
    let insertAt = idx + 1;
    while (insertAt < lines.length && !/^##\s+/.test(lines[insertAt] ?? "")) insertAt++;
    lines.splice(insertAt, 0, entry);
  } else {
    if (lines.length > 0 && !existing.endsWith("\n")) lines.push("");
    lines.push(heading, entry, "");
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join("\n"), "utf8");
  return { file: target, entry };
}
