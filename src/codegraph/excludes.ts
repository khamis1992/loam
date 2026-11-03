import fs from "node:fs";
import path from "node:path";

/**
 * Pre-scan run by Loam before every extract. graphify 0.9.95 has no size cap
 * for code files (only Office/PDF caps, OBSERVED graphify/detect.py:60-75) and
 * a single 17 MB bundled .cjs drove a worker past 1.5 GB until the kernel
 * OOM-killed it (OBSERVED on the box against Loam's own repo). Loam therefore
 * excludes oversized code files itself and counts what would be indexed.
 */

/** Extensions graphify parses with tree-sitter in the default install (pyproject dependencies) — superset is safe here. */
export const CODE_EXTENSIONS = new Set([
  ".py", ".pyw", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte",
  ".go", ".rs", ".java", ".groovy", ".gradle", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".rb", ".rake",
  ".cs", ".kt", ".kts", ".scala", ".php", ".swift", ".lua", ".zig", ".ps1", ".psm1", ".ex", ".exs",
  ".m", ".mm", ".jl", ".v", ".sv", ".f", ".f90", ".f95", ".sh", ".bash", ".json", ".yaml", ".yml", ".toml",
  ".sql", ".tf", ".dart", ".sol", ".erl", ".hrl", ".r", ".vb", ".razor", ".cshtml", ".md",
]);

/** Directory names never descended by the pre-scan (subset of DEFAULT_EXCLUDES expressible as names). */
export const PRESCAN_SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "release", "coverage", "vendor", "target",
  ".venv", "__pycache__", ".next", ".screenshots", ".manus", ".loam", "graphify-out",
]);

export interface PrescanResult {
  codeFiles: number;
  oversized: string[];          // forward-slash relative paths
  excludeArgs: string[];        // ["--exclude", "<pattern>", ...]
  truncatedWalk: boolean;
}

/** Hard limit for the combined --exclude argument text (Windows CreateProcess cap is 32,767 chars). */
export const MAX_EXCLUDE_ARG_CHARS = 24_000;

export function prescan(root: string, opts: { maxCodeFileBytes: number; excludes: readonly string[]; walkLimit?: number }): PrescanResult {
  const walkLimit = opts.walkLimit ?? 400_000;
  const oversized: string[] = [];
  let codeFiles = 0;
  let seen = 0;
  let truncatedWalk = false;
  const topLevelExcluded = new Set(
    opts.excludes.map((g) => /^([^*/?[\]{}]+)\/\*\*$/.exec(g)?.[1]).filter((x): x is string => Boolean(x)),
  );
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > walkLimit) { truncatedWalk = true; break; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (PRESCAN_SKIP_DIRS.has(e.name)) continue;
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (topLevelExcluded.has(rel)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext)) continue;
        if (e.name.endsWith(".min.js") || e.name.endsWith(".bundle.js") || e.name.endsWith(".map")) continue;
        let size = 0;
        try { size = fs.statSync(full).size; } catch { continue; }
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (size > opts.maxCodeFileBytes) oversized.push(rel);
        else codeFiles += 1;
      }
    }
    if (truncatedWalk) break;
  }
  oversized.sort();
  return { codeFiles, oversized, excludeArgs: collapseExcludes(oversized), truncatedWalk };
}

/** One --exclude per oversized file; a directory holding >= 10 of them is excluded as `<dir>/**` instead. */
export function collapseExcludes(oversized: string[]): string[] {
  const byDir = new Map<string, string[]>();
  for (const f of oversized) {
    const d = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
    byDir.set(d, [...(byDir.get(d) ?? []), f]);
  }
  const patterns: string[] = [];
  for (const [d, files] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (d && files.length >= 10) patterns.push(`${d}/**`);
    else patterns.push(...files.map(escapeGlob));
  }
  const args: string[] = [];
  for (const p of patterns) args.push("--exclude", p);
  return args;
}

/** Escape glob metacharacters in a literal path (gitignore-style matcher). */
export function escapeGlob(p: string): string {
  return p.replace(/([*?[\]])/g, "\\$1");
}

export function excludeArgChars(args: string[]): number {
  return args.reduce((n, a) => n + a.length + 3, 0);
}
