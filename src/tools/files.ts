import fs from "node:fs";
import path from "node:path";
import { resolveRead, resolveWrite } from "../policy/paths.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { bool, num, str } from "./registry.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  ".browser-profile",
  ".screenshots",
  ".manus",
  "vendor",
  "release",
  "coverage",
  "target",
]);
const MAX_READ_BYTES = 400_000;

function listDir(dir: string, recursive: boolean, maxEntries: number): string[] {
  const out: string[] = [];
  const deadline = Date.now() + 2500;
  const walk = (d: string, depth: number): void => {
    if (out.length >= maxEntries || depth > 8 || Date.now() > deadline) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        out.push(`${full}/`);
        if (recursive && !IGNORE_DIRS.has(e.name)) walk(full, depth + 1);
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* ignore */
        }
        out.push(`${full} (${size} bytes)`);
      }
    }
  };
  walk(dir, 0);
  return out;
}

export const fileTools: Tool[] = [
  {
    name: "file_read",
    description: "Read a text file. Paths outside the workspace are allowed only for reading if the config permits.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute or relative to workspace)." },
        startLine: { type: "number", description: "1-based start line (optional)." },
        maxLines: { type: "number", description: "Max lines to return (default 400)." },
      },
      required: ["path"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const p = resolveRead(ctx.workspace, str(args, "path"), ctx.cfg.policy.allowOutsideWorkspaceRead);
      if (!fs.existsSync(p)) return { ok: false, content: `not found: ${p}` };
      const st = fs.statSync(p);
      if (st.size > MAX_READ_BYTES) return { ok: false, content: `file too large (${st.size} bytes) for file_read; use shell_run with head/get-content` };
      const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
      const start = Math.max(1, num(args, "startLine", 1));
      const max = Math.max(1, num(args, "maxLines", 400));
      const slice = lines.slice(start - 1, start - 1 + max);
      const numbered = slice.map((l, i) => `${start + i}: ${l}`).join("\n");
      return { ok: true, content: `${p} (${lines.length} lines)\n${numbered}` };
    },
  },
  {
    name: "file_write",
    description: "Create or overwrite a text file inside the workspace (parent directories are created).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Target file path inside the workspace." },
        content: { type: "string", description: "Full file content." },
        append: { type: "boolean", description: "Append instead of overwrite (default false)." },
      },
      required: ["path", "content"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const p = resolveWrite(ctx.workspace, str(args, "path"));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const content = str(args, "content");
      if (bool(args, "append")) fs.appendFileSync(p, content, "utf8");
      else fs.writeFileSync(p, content, "utf8");
      const size = fs.statSync(p).size;
      return { ok: true, content: `wrote ${size} bytes to ${p}` };
    },
  },
  {
    name: "file_edit",
    description: "Exact string replacement inside a workspace file. Fails if the find string is missing or ambiguous (unless count is given).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        find: { type: "string", description: "Exact text to find." },
        replace: { type: "string", description: "Replacement text." },
        count: { type: "number", description: "Expected occurrences to replace (default 1)." },
      },
      required: ["path", "find", "replace"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const p = resolveWrite(ctx.workspace, str(args, "path"));
      if (!fs.existsSync(p)) return { ok: false, content: `not found: ${p}` };
      const original = fs.readFileSync(p, "utf8");
      const find = str(args, "find");
      const replace = str(args, "replace");
      const occurrences = original.split(find).length - 1;
      const want = num(args, "count", 1);
      if (occurrences === 0) return { ok: false, content: `find string not present in ${p}` };
      if (occurrences !== want) return { ok: false, content: `find string appears ${occurrences} times (expected ${want}); refine the search text` };
      if (find === replace) return { ok: true, content: `no change: find and replace are identical; ${p} was not written. This is not evidence of a new modification.` };
      fs.writeFileSync(p, original.split(find).join(replace), "utf8");
      return { ok: true, content: `replaced ${occurrences} occurrence(s) in ${p}` };
    },
  },
  {
    name: "file_list",
    description: "List files/directories in the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory (default workspace root)." },
        recursive: { type: "boolean", description: "Recurse into subdirectories (skips node_modules/.git)." },
        maxEntries: { type: "number", description: "Cap (default 300)." },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const dir = resolveRead(ctx.workspace, str(args, "path") || ctx.workspace, ctx.cfg.policy.allowOutsideWorkspaceRead);
      if (!fs.existsSync(dir)) return { ok: false, content: `not found: ${dir}` };
      if (!fs.statSync(dir).isDirectory()) return { ok: false, content: `not a directory: ${dir}` };
      const entries = listDir(dir, bool(args, "recursive"), Math.max(1, num(args, "maxEntries", 300)));
      return { ok: true, content: entries.length > 0 ? entries.join("\n") : "(empty)" };
    },
  },
  {
    name: "file_search",
    description: "Text search in a workspace file or recursively in a directory (regular expression). Returns file:line:match.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression." },
        path: { type: "string", description: "File or root directory (default workspace)." },
        maxResults: { type: "number", description: "Cap (default 60)." },
        glob: { type: "string", description: "Optional substring filter on file path (e.g. .ts)." },
      },
      required: ["pattern"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const root = resolveRead(ctx.workspace, str(args, "path") || ctx.workspace, ctx.cfg.policy.allowOutsideWorkspaceRead);
      const maxResults = Math.max(1, num(args, "maxResults", 60));
      const globFilter = str(args, "glob");
      let re: RegExp;
      try {
        re = new RegExp(str(args, "pattern"), "i");
      } catch (err) {
        return { ok: false, content: `invalid regex: ${err instanceof Error ? err.message : String(err)}` };
      }
      const hits: string[] = [];
      const deadline = Date.now() + 2500;
      let filesVisited = 0;
      const scanFile = (full: string): void => {
        if (hits.length >= maxResults || filesVisited >= 500 || Date.now() > deadline) return;
        if (globFilter && !full.includes(globFilter)) return;
        try {
          if (fs.statSync(full).size > 500_000) return;
          filesVisited++;
          const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
            const line = lines[i] ?? '';
            if (re.test(line)) hits.push(`${full}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        } catch { return; }
      };
      const walk = (d: string, depth: number): void => {
        if (hits.length >= maxResults || depth > 8 || filesVisited >= 500 || Date.now() > deadline) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (hits.length >= maxResults || filesVisited >= 500 || Date.now() > deadline) return;
          const full = path.join(d, e.name);
          if (e.isDirectory()) {
            if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith(".")) walk(full, depth + 1);
            continue;
          }
          if (!e.isFile()) continue;
          scanFile(full);
        }
      };
      if (!fs.existsSync(root)) return { ok: false, content: `not found: ${root}` };
      if (fs.statSync(root).isFile()) scanFile(root);
      else walk(root, 0);
      return { ok: true, content: hits.length ? hits.join("\n") : `no matches for ${str(args, "pattern")}` };
    },
  },
  {
    name: "file_stat",
    description: "Show metadata (type, size, mtime) for a path.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const p = resolveRead(ctx.workspace, str(args, "path"), ctx.cfg.policy.allowOutsideWorkspaceRead);
      if (!fs.existsSync(p)) return { ok: false, content: `not found: ${p}` };
      const st = fs.statSync(p);
      return {
        ok: true,
        content: `${p}\ntype=${st.isDirectory() ? "directory" : "file"}\nsize=${st.size}\nmtime=${st.mtime.toISOString()}`,
      };
    },
  },
  {
    name: "file_mkdir",
    description: "Create a directory inside the workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const p = resolveWrite(ctx.workspace, str(args, "path"));
      fs.mkdirSync(p, { recursive: true });
      return { ok: true, content: `created ${p}` };
    },
  },
  {
    name: "file_move",
    description: "Move/rename a file or directory inside the workspace.",
    parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const from = resolveWrite(ctx.workspace, str(args, "from"));
      const to = resolveWrite(ctx.workspace, str(args, "to"));
      if (!fs.existsSync(from)) return { ok: false, content: `not found: ${from}` };
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return { ok: true, content: `moved ${from} -> ${to}` };
    },
  },
  {
    name: "file_delete",
    description: "Delete a file or directory inside the workspace (directory requires recursive=true).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, recursive: { type: "boolean" } },
      required: ["path"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const p = resolveWrite(ctx.workspace, str(args, "path"));
      if (!fs.existsSync(p)) return { ok: false, content: `not found: ${p}` };
      fs.rmSync(p, { recursive: bool(args, "recursive"), force: true });
      return { ok: true, content: `deleted ${p}` };
    },
  },
];
