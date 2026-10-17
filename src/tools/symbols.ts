import fs from "node:fs";
import path from "node:path";
import { resolveRead } from "../policy/paths.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

export type SymbolKind = "function" | "class" | "interface" | "type" | "const";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  exported: boolean;
  signature: string;
}

export interface FileOutline {
  file: string;
  imports: string[];
  symbols: CodeSymbol[];
}

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "release", "build", ".next", "out", "coverage", ".screenshots", "feed"]);

interface CachedIndex {
  root: string;
  at: number;
  files: FileOutline[];
  symbols: CodeSymbol[];
}

let cache: CachedIndex | null = null;

function extractFileOutline(abs: string, relFile: string): FileOutline {
  let content = "";
  try {
    const stat = fs.statSync(abs);
    if (stat.size > 1_500_000) return { file: relFile, imports: [], symbols: [] };
    content = fs.readFileSync(abs, "utf8");
  } catch {
    return { file: relFile, imports: [], symbols: [] };
  }
  const lines = content.split(/\r?\n/);
  const imports: string[] = [];
  const symbols: CodeSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;

    // imports
    const impFrom = /^(?:import|export)\s+[\s\S]*?\s+from\s+["']([^"']+)["']/.exec(trimmed);
    if (impFrom?.[1]) {
      imports.push(impFrom[1]);
      continue;
    }
    const reqMatch = /\brequire\(\s*["']([^"']+)["']\s*\)/.exec(trimmed);
    if (reqMatch?.[1]) {
      imports.push(reqMatch[1]);
    }
    const pyImp = /^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/.exec(trimmed);
    if (pyImp) {
      imports.push((pyImp[1] ?? pyImp[2])!);
      continue;
    }

    const exported = /^export\s+/.test(trimmed) || /^pub\s+/.test(trimmed);

    // class / struct
    const cls = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|struct)\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (cls?.[1]) {
      symbols.push({ name: cls[1], kind: "class", file: relFile, line: i + 1, exported, signature: trimmed.slice(0, 120) });
      continue;
    }

    // interface
    const iface = /^(?:export\s+)?interface\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (iface?.[1]) {
      symbols.push({ name: iface[1], kind: "interface", file: relFile, line: i + 1, exported, signature: trimmed.slice(0, 120) });
      continue;
    }

    // type / enum
    const typ = /^(?:export\s+)?(?:type|enum)\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (typ?.[1]) {
      symbols.push({ name: typ[1], kind: "type", file: relFile, line: i + 1, exported, signature: trimmed.slice(0, 120) });
      continue;
    }

    // JS/TS/Go/Rust/Python function
    const fn =
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_]\w*)/.exec(trimmed) ??
      /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/.exec(trimmed) ??
      /^func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)/.exec(trimmed) ??
      /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (fn?.[1]) {
      symbols.push({ name: fn[1], kind: "function", file: relFile, line: i + 1, exported, signature: trimmed.slice(0, 120) });
      continue;
    }

    // exported const arrow or value
    const arrow = /^(?:export\s+)(?:const|let)\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>/.exec(trimmed);
    if (arrow?.[1]) {
      symbols.push({ name: arrow[1], kind: "function", file: relFile, line: i + 1, exported: true, signature: trimmed.slice(0, 120) });
      continue;
    }
    const expConst = /^export\s+const\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (expConst?.[1]) {
      symbols.push({ name: expConst[1], kind: "const", file: relFile, line: i + 1, exported: true, signature: trimmed.slice(0, 120) });
    }
  }

  return { file: relFile, imports: [...new Set(imports)], symbols };
}

export function buildWorkspaceIndex(workspace: string, force = false): CachedIndex {
  const root = path.resolve(workspace);
  if (!force && cache && cache.root === root && Date.now() - cache.at < 15_000) {
    return cache;
  }
  const files: FileOutline[] = [];
  const symbols: CodeSymbol[] = [];
  const stack: string[] = [root];
  let visited = 0;

  while (stack.length > 0 && visited < 1500) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".manus") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile() && CODE_EXT.has(path.extname(entry.name).toLowerCase())) {
        visited += 1;
        const rel = path.relative(root, full).split(path.sep).join("/");
        const outline = extractFileOutline(full, rel);
        files.push(outline);
        symbols.push(...outline.symbols);
      }
    }
  }

  files.sort((a, b) => a.file.localeCompare(b.file));
  cache = { root, at: Date.now(), files, symbols };
  return cache;
}

export function queryWorkspaceSymbols(
  workspace: string,
  opts: { query?: string; kind?: string; limit?: number; refresh?: boolean } = {},
): { totalFiles: number; totalSymbols: number; matches: CodeSymbol[]; importersOf: Record<string, string[]> } {
  const idx = buildWorkspaceIndex(workspace, opts.refresh === true);
  const q = (opts.query ?? "").trim().toLowerCase();
  const kind = (opts.kind ?? "").trim().toLowerCase();
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 300);

  let filtered = idx.symbols;
  if (kind) filtered = filtered.filter((s) => s.kind === kind);
  if (q) {
    filtered = filtered.filter((s) => s.name.toLowerCase().includes(q) || s.file.toLowerCase().includes(q));
  }
  const matches = filtered.slice(0, limit);

  // Build reverse-import map for matched files
  const matchedFiles = new Set(matches.map((m) => m.file));
  const importersOf: Record<string, string[]> = {};
  for (const f of matchedFiles) {
    const baseNoExt = path.basename(f).replace(/\.[^.]+$/, "");
    importersOf[f] = idx.files
      .filter((other) => other.file !== f && other.imports.some((imp) => imp.includes(baseNoExt)))
      .map((other) => other.file)
      .slice(0, 12);
  }

  return { totalFiles: idx.files.length, totalSymbols: idx.symbols.length, matches, importersOf };
}

export function outlineWorkspacePath(workspace: string, targetPath?: string): FileOutline[] {
  const abs = resolveRead(workspace, targetPath && targetPath.trim() ? targetPath : ".", false);
  if (!fs.existsSync(abs)) throw new Error(`path not found: ${targetPath ?? "."}`);
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    const rel = path.relative(path.resolve(workspace), abs).split(path.sep).join("/");
    return [extractFileOutline(abs, rel)];
  }
  const idx = buildWorkspaceIndex(abs, true);
  return idx.files;
}

export function symbolTools(): Tool[] {
  return [
    {
      name: "code_symbols",
      description:
        "Search the workspace symbol index (functions, classes, interfaces, types, exported consts) and see which files import them. Much faster and cheaper than full-text grep when navigating a codebase.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring of symbol name or file path (empty = list top symbols)." },
          kind: { type: "string", enum: ["function", "class", "interface", "type", "const"] },
          limit: { type: "number", description: "Max results (default 60)." },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const res = queryWorkspaceSymbols(ctx.workspace, {
          query: str(args, "query"),
          kind: str(args, "kind"),
          limit: num(args, "limit", 60),
        });
        if (res.matches.length === 0) {
          return { ok: true, content: `(no symbols matched in ${res.totalFiles} indexed files / ${res.totalSymbols} symbols)` };
        }
        const lines = res.matches.map((s) => {
          const imp = res.importersOf[s.file];
          const impNote = imp && imp.length > 0 ? `  [imported by: ${imp.join(", ")}]` : "";
          return `${s.file}:${s.line}  [${s.kind}${s.exported ? " export" : ""}] ${s.name}${impNote}`;
        });
        return {
          ok: true,
          content: `Indexed ${res.totalFiles} files (${res.totalSymbols} symbols). Showing ${res.matches.length}:\n` + lines.join("\n"),
        };
      },
    },
    {
      name: "code_outline",
      description:
        "Return the structural outline (imports + declared functions/classes/types with line numbers) of a file or directory without reading every line.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory path inside the workspace (default: workspace root)." },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        try {
          const outlines = outlineWorkspacePath(ctx.workspace, str(args, "path") || ".");
          if (outlines.length === 0) return { ok: true, content: "(no code files found)" };
          const blocks = outlines.slice(0, 60).map((o) => {
            const imp = o.imports.length > 0 ? `  imports: ${o.imports.slice(0, 12).join(", ")}` : "";
            const syms = o.symbols.map((s) => `  L${s.line} [${s.kind}${s.exported ? "*" : ""}] ${s.name}`).join("\n");
            return `### ${o.file}\n${[imp, syms].filter(Boolean).join("\n") || "  (no top-level symbols)"}`;
          });
          return { ok: true, content: blocks.join("\n\n") };
        } catch (err) {
          return { ok: false, content: `code_outline failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  ];
}
