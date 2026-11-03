/**
 * repomix-style context packing (ALL_SERVICES §18), flag-gated: bundle workspace
 * source files into one bounded, LLM-readable document with per-file headers.
 * Off by default — opt in with LOAM_CONTEXT_PACK=1 for RE/SAST context handoff.
 */
import fs from "node:fs";
import path from "node:path";

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb", ".php"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "release", "coverage", "vendor", ".venv"]);
const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export const contextPackEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.LOAM_CONTEXT_PACK === "1";

export interface PackOptions { root: string; maxFiles?: number }

/** Pack source files into one document: `path/to/file.ts\n-------\n<content>` blocks. */
export function packContext(opts: PackOptions): { text: string; files: number; truncated: boolean } {
  const root = path.resolve(opts.root);
  const cap = opts.maxFiles ?? MAX_FILES;
  const blocks: string[] = [];
  let total = 0;
  let files = 0;
  let truncated = false;
  const walk = (dir: string): void => {
    let es: fs.Dirent[] = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (files >= cap || total >= MAX_TOTAL_BYTES) { truncated = true; return; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(full); continue; }
      if (!e.isFile() || !CODE_EXT.has(path.extname(e.name).toLowerCase())) continue;
      let text: string;
      try {
        if (fs.statSync(full).size > MAX_FILE_BYTES) { truncated = true; continue; }
        text = fs.readFileSync(full, "utf8");
      } catch { continue; }
      const rel = path.relative(root, full).split(path.sep).join("/");
      const block = `${rel}\n-------\n${text}`;
      if (total + block.length > MAX_TOTAL_BYTES) { truncated = true; return; }
      blocks.push(block);
      total += block.length;
      files++;
    }
  };
  walk(root);
  return { text: blocks.join("\n\n"), files, truncated };
}
