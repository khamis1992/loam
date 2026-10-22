import fs from "node:fs";
import path from "node:path";
import { resolveRead, resolveWrite } from "../policy/paths.js";
import { loadMemoryForFile } from "../agent/projectMemory.js";
import {
  formatDiagnosticReport,
  resolveDiagnosticsSettings,
  runDiagnostics,
} from "../agent/diagnostics.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { bool, num, str, strFirst } from "./registry.js";
import { guardExistingEdit } from "./readState.js";
import { withLock, withLocks } from "./fileLock.js";

/** Append per-edit diagnostics to a successful write result. Never throws and
 *  never turns a successful edit into a failure. */
async function withDiagnostics(content: string, file: string, ctx: ToolContext): Promise<string> {
  try {
    const settings = resolveDiagnosticsSettings(ctx.workspace, ctx.cfg);
    if (!settings.enabled) return content;
    const outcome = await runDiagnostics(file, settings);
    if (!outcome) return content;
    return `${content}\n\n${formatDiagnosticReport(outcome)}`;
  } catch {
    return content;
  }
}

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
    description:
      "Read a UTF-8 text file and get it back with 1-based line numbers, so you can cite exact locations in later edits. Read a file before you edit or overwrite it: file_edit and file_write refuse an existing file you have not read this session and refuse one whose contents changed on disk since your last read. Use startLine/maxLines to page through a large file instead of pulling it all in; omit them to start at line 1 (default 400 lines). Paths may be workspace-relative or absolute; reading outside the workspace requires policy.allowOutsideWorkspaceRead. A read records the snapshot, so a follow-up edit is accepted. Independent reads are safe to issue together in one turn (up to 8 run concurrently); keep writes serial. When NOT to use: use file_search or code_symbols to locate text or definitions, file_list to see a directory, file_extract_text / file_view_image for PDFs, Office files or images, and shell_run with head/Get-Content only for files over the 400 KB limit; never read a file through shell cat/type because that skips read tracking and line numbering.",
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
      const content = fs.readFileSync(p, "utf8");
      ctx.readState?.record(p, content);
      const lines = content.split(/\r?\n/);
      const start = Math.max(1, num(args, "startLine", 1));
      const max = Math.max(1, num(args, "maxLines", 400));
      const slice = lines.slice(start - 1, start - 1 + max);
      const numbered = slice.map((l, i) => `${start + i}: ${l}`).join("\n");
      // Subdirectory memory is loaded on demand when a file there is read; the
      // workspace root is already part of the system prompt, so it is excluded.
      const memory = loadMemoryForFile(p, ctx.workspace);
      const memoryBlock = memory.text
        ? `\n\n--- project memory (${memory.files.map((f) => path.relative(ctx.workspace, f) || f).join(", ")}) ---\n${memory.text}`
        : "";
      return { ok: true, content: `${p} (${lines.length} lines)\n${numbered}${memoryBlock}` };
    },
  },
  {
    name: "file_write",
    description:
      "Create a new text file or overwrite an existing one inside the workspace; parent directories are created for you. Pass the full content unless append is true, which adds to the end. Read an existing file first: the tool rejects an unread or stale file (read-before-edit / mtime guard) so you never clobber changes you have not seen, and it records the write so later edits are accepted. Writing is a mutating effect, so keep it serial — never batch a write with other calls in the same turn. When NOT to use: use file_edit or file_multi_edit for targeted changes to a file you have read (they preserve line endings and avoid rewriting the whole file); use file_mkdir to create a directory and file_move to rename; do not write outside the workspace — paths are confined to it.",
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
      // Read-guard + write is one read-modify-write cycle, so hold the per-path
      // lock across all of it: a concurrent edit cannot read the file in between.
      return withLock(p, async () => {
        const guard = guardExistingEdit(ctx, p);
        if (guard) return guard;
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const content = str(args, "content");
        if (bool(args, "append")) fs.appendFileSync(p, content, "utf8");
        else fs.writeFileSync(p, content, "utf8");
        ctx.readState?.record(p);
        const size = fs.statSync(p).size;
        return { ok: true, content: await withDiagnostics(`wrote ${size} bytes to ${p}`, p, ctx) };
      });
    },
  },
  {
    name: "file_edit",
    description:
      "Replace exact text inside a workspace file with a targeted edit. Pass the exact old_string to find and the new_string to write in its place; find/replace are accepted as aliases. The match must be unique unless you pass replace_all, which replaces every occurrence, or count, which must equal the number of occurrences. Include enough surrounding context (a full line or more) so the find text matches exactly once, and remember the match is literal, not a regular expression. Read the file first: an unread or stale file is refused, and a successful edit refreshes the read snapshot. An old_string equal to new_string is reported as a no-op and writes nothing. When NOT to use: use file_multi_edit for several changes to the same file (it is atomic and reports a diff); use file_write to create a file or fully rewrite one you have read; use file_search to find text; never build a file through repeated shell echo/Set-Content, which bypasses read tracking and can corrupt line endings.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Target file path inside the workspace." },
        old_string: { type: "string", description: "Exact text to find. Must occur exactly once unless replace_all is true." },
        new_string: { type: "string", description: "Replacement text. Must differ from old_string." },
        find: { type: "string", description: "Alias for old_string." },
        replace: { type: "string", description: "Alias for new_string." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a single unique match (default false)." },
        count: { type: "number", description: "Legacy: expected occurrence count when replace_all is false (default 1)." },
      },
      required: ["path"],
      anyOf: [{ required: ["old_string", "new_string"] }, { required: ["find", "replace"] }],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const p = resolveWrite(ctx.workspace, str(args, "path"));
      // Read the file, verify the match and write the replacement under one
      // per-path lock, so two concurrent edits cannot both read the same
      // original and race their writes (a lost update).
      return withLock(p, async () => {
        const guard = guardExistingEdit(ctx, p);
        if (guard) return guard;
        if (!fs.existsSync(p)) return { ok: false, content: `not found: ${p}` };
        const original = fs.readFileSync(p, "utf8");
        const oldString = strFirst(args, "old_string", "find");
        const newString = strFirst(args, "new_string", "replace");
        if (oldString === undefined) return { ok: false, content: "file_edit requires old_string (or its alias find)" };
        if (newString === undefined) return { ok: false, content: "file_edit requires new_string (or its alias replace)" };
        if (oldString.length === 0) return { ok: false, content: "old_string must be non-empty" };
        if (oldString === newString) {
          return {
            ok: false,
            content: `old_string and new_string are identical, so this edit would change nothing. Provide a new_string that actually differs from old_string (or drop this no-op edit).`,
          };
        }
        const occurrences = original.split(oldString).length - 1;
        if (occurrences === 0) return { ok: false, content: `old_string not present in ${p}` };
        const replaceAll = bool(args, "replace_all", false);
        if (replaceAll) {
          fs.writeFileSync(p, original.split(oldString).join(newString), "utf8");
          ctx.readState?.record(p);
          return { ok: true, content: `replaced ${occurrences} occurrence(s) in ${p} (replace_all)` };
        }
        const want = num(args, "count", 1);
        if (occurrences !== want) {
          return {
            ok: false,
            content: `Found ${occurrences} matches of old_string in ${p}, but replace_all is false and the match is not unique. Add more surrounding context to old_string (include more lines or words around the change) so it matches exactly once, or set replace_all to true to replace every match.`,
          };
        }
        fs.writeFileSync(p, original.split(oldString).join(newString), "utf8");
        // Refresh the read snapshot so a follow-up edit in the same session is
        // not rejected as stale; the model already saw the pre-edit content.
        ctx.readState?.record(p);
        return { ok: true, content: await withDiagnostics(`replaced ${occurrences} occurrence(s) in ${p}`, p, ctx) };
      });
    },
  },
  {
    name: "file_list",
    description:
      "List the entries in a workspace directory so you can see what exists before reading or editing it. Pass recursive to walk subdirectories (dependency and VCS folders such as node_modules and .git are skipped automatically) and maxEntries to cap the output (default 300). Prefer this over a shell directory listing when you only need a folder's shape. Listing is a read, so independent listings may be issued together with other reads in the same turn. When NOT to use: use file_read to open a file's contents, file_search to find text across files, and code_symbols to navigate definitions; do not use it to inspect what is inside a file.",
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
    description:
      "Search for a regular expression in one file or recursively across a workspace directory, returning file:line:match hits. The pattern is a case-insensitive regex; pass path to scope it to a file or subtree and glob as a substring filter on the file path (for example .ts). Results are capped by maxResults (default 60) and the walker skips dot-directories and dependency folders, so it stays cheap. When NOT to use: use file_read to open a file you already know, code_symbols for symbol definitions, and shell_run only when you need a fuller ripgrep feature set; prefer this for quick in-workspace lookups because it reports numbered lines.",
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
    description:
      "Show metadata for a path — whether it is a file or a directory, its byte size and its last-modified time — without reading its contents. Use it to confirm a file exists, to judge whether a file is too large for file_read before opening it, or to verify that a change landed. It is a cheap read and may be batched with other reads. When NOT to use: use file_read for contents, file_list for a directory's entries, and file_search to find text inside it; never use it to modify anything.",
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
    description:
      "Create a directory inside the workspace, including any missing parent directories. Prefer this over a shell mkdir/New-Item so the path stays confined to the workspace and is reported consistently. It is a mutating effect, so keep it serial with other writes rather than batching it in one turn. When NOT to use: use file_write to create a file (it creates parent directories automatically) and file_move to relocate an existing path; do not create directories outside the workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const p = resolveWrite(ctx.workspace, str(args, "path"));
      fs.mkdirSync(p, { recursive: true });
      return { ok: true, content: `created ${p}` };
    },
  },
  {
    name: "file_move",
    description:
      "Move or rename a file or directory inside the workspace, creating the destination's parent directories as needed. Both the from and to paths must resolve inside the workspace. It changes location only, never contents. It is a mutating effect, so issue it on its own rather than batched with other writes. When NOT to use: use file_edit or file_write to change contents, file_delete to remove a path, and a shell move only when you need shell-specific behaviour.",
    parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const from = resolveWrite(ctx.workspace, str(args, "from"));
      const to = resolveWrite(ctx.workspace, str(args, "to"));
      // Rename touches both paths; acquire them in sorted order (lockAll) so a
      // move and an edit racing on the same two paths cannot deadlock.
      return withLocks([from, to], async () => {
        if (!fs.existsSync(from)) return { ok: false, content: `not found: ${from}` };
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        return { ok: true, content: `moved ${from} -> ${to}` };
      });
    },
  },
  {
    name: "file_delete",
    description:
      "Delete a file or directory inside the workspace. A directory requires recursive=true, and the removal is forced so it will not prompt. Deletion is destructive and irreversible, so confirm the exact target before calling and prefer version control for anything you may need to recover. It is a mutating effect; keep it serial and never target anything outside the workspace, which is confined. When NOT to use: use file_move to relocate a path instead of removing it, and use file_edit/file_write to change contents.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, recursive: { type: "boolean" } },
      required: ["path"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const p = resolveWrite(ctx.workspace, str(args, "path"));
      return withLock(p, async () => {
        if (!fs.existsSync(p)) return { ok: false, content: `not found: ${p}` };
        fs.rmSync(p, { recursive: bool(args, "recursive"), force: true });
        return { ok: true, content: `deleted ${p}` };
      });
    },
  },
];
