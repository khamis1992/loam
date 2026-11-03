import fs from "node:fs";
import path from "node:path";

const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "vendor", "dist", "build", "coverage", ".next", "out"]);

export interface ChangedFile {
  relPath: string;
  content: string;
  truncated: boolean;
  binary: boolean;
  source: "tool-ledger" | "mtime" | "both";
}

export interface ChangeScanLimits {
  maxFiles: number;
  maxCharsPerFile: number;
  maxTotalChars: number;
  maxEntries: number;
  maxDepth: number;
  maxFileBytes: number;
}

export const DEFAULT_CHANGE_LIMITS: ChangeScanLimits = {
  maxFiles: 8,
  maxCharsPerFile: 12_000,
  maxTotalChars: 40_000,
  maxEntries: 4000,
  maxDepth: 8,
  maxFileBytes: 256 * 1024,
};

const WRITE_TOOLS = new Set(["file_write", "file_edit", "file_patch"]);

export function pathFromTool(name: string, args: unknown): string | undefined {
  if (!WRITE_TOOLS.has(name) || !args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const value = record.path ?? record.file ?? record.filePath;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function collectChangedFiles(opts: {
  workspace: string;
  turnStartedAt: number;
  ledger: string[];
  limits?: Partial<ChangeScanLimits>;
}): ChangedFile[] {
  const limits = { ...DEFAULT_CHANGE_LIMITS, ...opts.limits };
  const found = new Map<string, ChangedFile["source"]>();
  for (const item of opts.ledger) {
    const rel = path.relative(opts.workspace, path.resolve(opts.workspace, item));
    if (rel.startsWith("..")) continue;
    found.set(rel, "tool-ledger");
  }
  walk(opts.workspace, opts.workspace, 0, opts.turnStartedAt, limits, found, { entries: 0 });
  const files: ChangedFile[] = [];
  let total = 0;
  for (const [relPath, source] of found) {
    if (files.length >= limits.maxFiles) break;
    const abs = path.join(opts.workspace, relPath);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile()) continue;
    if (stat.size > limits.maxFileBytes) {
      files.push({ relPath, content: "", truncated: true, binary: true, source });
      continue;
    }
    const buf = fs.readFileSync(abs);
    const binary = buf.includes(0);
    if (binary) {
      files.push({ relPath, content: "", truncated: false, binary: true, source });
      continue;
    }
    let content = buf.toString("utf8");
    let truncated = false;
    if (content.length > limits.maxCharsPerFile) {
      content = content.slice(0, limits.maxCharsPerFile);
      truncated = true;
    }
    if (total + content.length > limits.maxTotalChars) {
      content = content.slice(0, Math.max(0, limits.maxTotalChars - total));
      truncated = true;
    }
    total += content.length;
    files.push({ relPath, content, truncated, binary: false, source });
  }
  return files;
}

function walk(root: string, dir: string, depth: number, since: number, limits: ChangeScanLimits, found: Map<string, ChangedFile["source"]>, budget: { entries: number }): void {
  if (depth > limits.maxDepth || budget.entries >= limits.maxEntries) return;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (budget.entries >= limits.maxEntries) return;
    budget.entries += 1;
    if (SKIP.has(name) || name.startsWith("release-build")) continue;
    const abs = path.join(dir, name);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.isDirectory()) {
      walk(root, abs, depth + 1, since, limits, found, budget);
      continue;
    }
    if (stat.mtimeMs + 1 < since) continue;
    const rel = path.relative(root, abs);
    const previous = found.get(rel);
    found.set(rel, previous === "tool-ledger" ? "both" : previous ?? "mtime");
  }
}
