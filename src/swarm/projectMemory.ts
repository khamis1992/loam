import fs from "node:fs";
import path from "node:path";

/** Deterministic, engine-side project memory: one index per company-run workspace.
 * It never leaves the run's own folder, so one project's code, secrets and context
 * can never leak into another run. Rebuilt whenever files change; the diff is the
 * honest record of what each stage actually touched. */
export type FileKind = "code" | "test" | "doc" | "config" | "report" | "other";
export interface ProjectFile { path: string; kind: FileKind; lines: number; dependsOn: string[] }
export interface ProjectIndex {
  builtAt: string;
  files: ProjectFile[];
  edges: Array<{ from: string; to: string }>;
  stats: Record<FileKind, number>;
}
export interface MemorySummary { files: number; kinds: Partial<Record<FileKind, number>>; edges: number; updatedAt: string }
export interface IndexDiff { added: string[]; changed: string[]; removed: string[] }
/** Roadmap §5: a lightweight, deterministic search over the project index — keyword scoring
 * across file paths and (when present) content excerpts, plus dependency-aware lifts so a
 * hit also surfaces the modules that depend on it. No embeddings, no network: honest text. */
export interface SearchHit { path: string; kind: FileKind; score: number; lines: number; dependedOnBy: string[] }

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "dist", "coverage", "__pycache__"]);
const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|vue|svelte|rb|php)$/i;
const TEST_PATH = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.go$|(?:^|\/)(?:tests?|__tests__)(?:\/|$)/i;
const DOC_EXT = /\.(?:md|markdown|txt|rst|adoc)$/i;
const CONFIG_NAME = /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|\.env\.example|pyproject\.toml|Cargo\.toml|go\.mod|requirements\.txt|dockerfile|\.gitignore)$/i;
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function classify(rel: string): FileKind {
  if (rel.startsWith(".loam/")) return "report";
  if (TEST_PATH.test(rel)) return "test";
  if (DOC_EXT.test(rel)) return "doc";
  if (CONFIG_NAME.test(path.basename(rel))) return "config";
  if (CODE_EXT.test(rel)) return "code";
  return "other";
}

/** Local dependency extraction: relative require/import specifiers only. */
function rawDeps(content: string): string[] {
  const deps: string[] = [];
  const patterns = [/require\(\s*["'](\.[^"']*)["']\s*\)/g, /import\s+[^;"']*from\s*["'](\.[^"']*)["']/g, /import\(\s*["'](\.[^"']*)["']\s*\)/g];
  for (const pattern of patterns) for (const match of content.matchAll(pattern)) if (match[1]) deps.push(match[1]);
  return deps;
}

function resolveDep(fromFile: string, spec: string, known: Set<string>): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec)).replace(/^\.\//, "");
  const ext = path.posix.extname(base);
  const candidates = ext
    ? [base, base.replace(/\.[cm]?[jt]sx?$/i, ".cjs"), base.replace(/\.[cm]?[jt]sx?$/i, ".js")]
    : [`${base}.cjs`, `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`, `${base}/index.cjs`, `${base}/index.js`, `${base}/index.ts`];
  for (const candidate of candidates) if (known.has(candidate)) return candidate;
  return null;
}

export function buildProjectIndex(root: string): ProjectIndex {
  const files: ProjectFile[] = [];
  const known = new Set<string>();
  const walk = (rel: string, depth: number): void => {
    if (depth > 12 || files.length >= MAX_FILES) return;
    const abs = path.join(root, rel);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (child === ".loam/swarm/project-index.json") continue; // never index the index itself
      if (entry.isDirectory()) { walk(child, depth + 1); continue; }
      if (!entry.isFile()) continue;
      let content = "";
      try {
        const stat = fs.statSync(path.join(root, child));
        if (stat.size > MAX_FILE_BYTES) continue;
        content = fs.readFileSync(path.join(root, child), "utf8");
      } catch { continue; }
      const kind = classify(child);
      const file: ProjectFile = { path: child, kind, lines: content ? content.split("\n").length : 0, dependsOn: [] };
      if (kind === "code" || kind === "test") file.dependsOn = rawDeps(content);
      files.push(file); known.add(child);
    }
  };
  walk("", 0);
  const edges: Array<{ from: string; to: string }> = [];
  for (const file of files) {
    for (const spec of file.dependsOn) {
      const resolved = resolveDep(file.path, spec, known);
      if (resolved && resolved !== file.path) edges.push({ from: file.path, to: resolved });
    }
  }
  const stats: Record<FileKind, number> = { code: 0, test: 0, doc: 0, config: 0, report: 0, other: 0 };
  for (const file of files) stats[file.kind]++;
  return { builtAt: new Date().toISOString(), files, edges, stats };
}

export function diffIndexes(previous: ProjectIndex | null, next: ProjectIndex): IndexDiff {
  const before = new Map(previous?.files.map(f => [f.path, f]) ?? []);
  const after = new Map(next.files.map(f => [f.path, f]));
  const added: string[] = [], changed: string[] = [], removed: string[] = [];
  for (const [p, file] of after) { if (!before.has(p)) added.push(p); else if (before.get(p)!.lines !== file.lines || before.get(p)!.kind !== file.kind) changed.push(p); }
  for (const p of before.keys()) if (!after.has(p)) removed.push(p);
  return { added, changed, removed };
}

export function summarizeIndex(index: ProjectIndex): MemorySummary {
  return { files: index.files.length, kinds: { ...index.stats }, edges: index.edges.length, updatedAt: index.builtAt };
}

/** Compact, bounded text rendering injected into stage prompts — the indexed understanding
 * of the project the agents work in, including seeded existing repositories. */
export function searchIndex(index: ProjectIndex, query: string, limit = 5): SearchHit[] {
  const terms = query.toLowerCase().split(/[^a-z0-9\u0600-\u06FF]+/).filter(w => w.length > 3);
  if (!terms.length) return [];
  const inbound = new Map<string, string[]>();
  for (const edge of index.edges) inbound.set(edge.to, [...(inbound.get(edge.to) ?? []), edge.from]);
  const scored: SearchHit[] = [];
  for (const file of index.files) {
    if (file.path.startsWith(".loam/")) continue;
    const haystack = file.path.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) score += 3;
      const segments = haystack.split("/");
      if (segments.some(s => s.replace(/\.[cm]?[jt]sx?$/i, "") === term)) score += 2;
    }
    if (score > 0) scored.push({ path: file.path, kind: file.kind, score, lines: file.lines, dependedOnBy: (inbound.get(file.path) ?? []).slice(0, 3) });
  }
  return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

/** Top index hits for a stage prompt, derived from the brief's own keywords. */
export function searchBriefForPrompt(index: ProjectIndex, brief: string, maxChars = 600): string {
  const hits = searchIndex(index, brief, 4);
  if (!hits.length) return "";
  const text = hits.map(h => `${h.path} (${h.kind}, ${h.lines} lines${h.dependedOnBy.length ? `, used by ${h.dependedOnBy.join(", ")}` : ""})`).join("; ");
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function indexBriefForPrompt(index: ProjectIndex, maxChars = 3500): string {
  const line = (label: string, values: string[], max: number): string =>
    values.length ? `${label} (${values.length}): ${values.slice(0, max).join(", ")}${values.length > max ? " …" : ""}` : "";
  const docs = index.files.filter(f => f.kind === "doc" || f.kind === "report").map(f => f.path);
  const code = index.files.filter(f => f.kind === "code").map(f => f.path);
  const tests = index.files.filter(f => f.kind === "test").map(f => f.path);
  const edges = index.edges.map(e => `${e.from} → ${e.to}`);
  const parts = [
    `files ${index.files.length} | code ${index.stats.code} | tests ${index.stats.test} | docs/reports ${index.stats.doc + index.stats.report} | local-dependency edges ${index.edges.length} | built ${index.builtAt}`,
    line("code", code, 40),
    line("tests", tests, 15),
    line("docs/decisions", docs, 15),
    line("dependency map", edges, 40),
  ].filter(Boolean);
  const text = parts.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text;
}
