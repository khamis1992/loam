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

/** Cap on the number of replacements a single batch may perform. */
const MAX_BATCH_EDITS = 50;
/** Lines of context shown around each applied edit in the post-edit snippet. */
const EDIT_CONTEXT_LINES = 3;

/**
 * 1-based line number at which a literal substring starts (1 when absent).
 * Counted on `\n`, so it stays correct for CRLF content.
 */
export function findLineNumber(content: string, substring: string): number {
  const pos = content.indexOf(substring);
  if (pos < 0) return 1;
  let line = 1;
  for (let i = 0; i < pos; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * A line-numbered excerpt of `content` around the edited range. `start`/`end`
 * are 1-based inclusive lines; `padding` context lines are added on both sides,
 * clamped to the file bounds.
 */
export function extractContext(
  content: string,
  start: number,
  end: number,
  padding: number,
): { startLine: number; endLine: number; text: string } {
  const lines = content.split("\n");
  const first = Math.max(1, start - padding);
  const last = Math.min(lines.length, end + padding);
  const numbered = lines.slice(first - 1, last).map((line, i) => `${String(first + i).padStart(4)}| ${line}`);
  return { startLine: first, endLine: last, text: numbered.join("\n") };
}

/**
 * Diagnose why a literal `old_string` is absent. Adapted from jcode (MIT)
 * crates/jcode-app-core/src/tool/edit.rs (`flexible_match_hint`). The edit is
 * never applied from the hint; the hint only tells the model what to change.
 */
export function flexibleMatchHint(content: string, oldString: string, filePath: string): string {
  const trimmed = oldString.trim();
  if (trimmed.length > 0 && trimmed !== oldString && content.includes(trimmed)) {
    return `old_string not found exactly, but found after trimming whitespace. Use the exact string from the file, including leading/trailing whitespace.`;
  }

  const wanted = oldString.split("\n");
  if (wanted.length > 0) {
    const source = content.split("\n");
    for (let i = 0; i + wanted.length <= source.length; i++) {
      let matches = true;
      for (let j = 0; j < wanted.length; j++) {
        if ((source[i + j] ?? "").trim() !== (wanted[j] ?? "").trim()) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return `old_string not found exactly, but found with different indentation around line ${i + 1}. Preserve the exact whitespace from the file.`;
      }
    }
  }

  return `old_string not found in ${filePath}. Use file_read to see the current file contents.`;
}

/** A parsed single replacement: exactly one literal find and its replacement. */
export interface EditOperation {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

/**
 * Replace the first literal occurrence. `String.prototype.replace` is NOT used
 * here: with a string pattern it still expands `$&`, `` $` ``, `$'` and `$$` in
 * the replacement, whereas the spec (jcode `ref/edit.rs`) substitutes the text
 * verbatim. Replacing via slice keeps `$` in the new_string literal.
 */
function replaceFirstLiteral(content: string, find: string, replacement: string): string {
  const at = content.indexOf(find);
  if (at < 0) return content;
  return content.slice(0, at) + replacement + content.slice(at + find.length);
}

/**
 * Number of lines a replacement occupies, counted the way Rust's `str::lines`
 * does: a trailing newline does not start a further line, and "" is 0 lines.
 * Used only to place the end of the post-edit context window.
 */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  const segments = text.split("\n").length;
  return text.endsWith("\n") ? segments - 1 : segments;
}

/** Where one replacement landed. */
interface AppliedEdit {
  occurrences: number;
  startLine: number;
  endLine: number;
}

/**
 * Apply every operation in order to an in-memory copy. All-or-nothing: every
 * failure is collected and the caller only writes when the list is empty, so a
 * batch never leaves the file half-edited.
 */
export function applyEditOperations(
  content: string,
  operations: EditOperation[],
  filePath: string,
): { ok: true; content: string; applied: AppliedEdit[] } | { ok: false; failures: string[] } {
  let work = content;
  const applied: AppliedEdit[] = [];
  const failures: string[] = [];
  const label = (index: number): string => (operations.length === 1 ? "" : `Edit ${index + 1}: `);

  for (let index = 0; index < operations.length; index++) {
    const op = operations[index]!;
    const tag = label(index);
    if (op.oldString === op.newString) {
      failures.push(`${tag}old_string and new_string must be different`);
      continue;
    }
    if (op.oldString.length === 0) {
      failures.push(`${tag}old_string must not be empty`);
      continue;
    }
    let occurrences = 0;
    let from = 0;
    while (from <= work.length - op.oldString.length) {
      const at = work.indexOf(op.oldString, from);
      if (at < 0) break;
      occurrences++;
      from = at + op.oldString.length;
    }
    if (occurrences === 0) {
      failures.push(`${tag}${flexibleMatchHint(work, op.oldString, filePath)}`);
      continue;
    }
    if (occurrences > 1 && !op.replaceAll) {
      failures.push(
        `${tag}old_string found ${occurrences} times. Either:\n1. Provide more context to make it unique, or\n2. Set replace_all: true to replace all occurrences`,
      );
      continue;
    }
    const startLine = findLineNumber(work, op.oldString);
    work = op.replaceAll ? work.split(op.oldString).join(op.newString) : replaceFirstLiteral(work, op.oldString, op.newString);
    applied.push({ occurrences, startLine, endLine: startLine + countLines(op.newString) - 1 });
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, content: work, applied };
}

/**
 * Build the failure body for a batch that was rejected. A single operation
 * returns its own message; a batch lists every failure so the model can fix
 * them all at once.
 */
export function formatEditFailures(filePath: string, failures: string[], total: number): string {
  if (failures.length === 1) return failures[0]!;
  return [
    `No changes written to ${filePath}. ${failures.length} of ${total} edits failed:`,
    ...failures.map((failure) => `  x ${failure}`),
    "Edits apply in order, so later edits see the result of earlier ones.",
  ].join("\n");
}

/**
 * Turn the tool arguments into an ordered list of operations. Accepts either
 * the `edits` array or the single-edit shorthand (`old_string`/`new_string`,
 * with `find`/`replace` aliases), never both, and never an empty batch.
 * `usedBatch` tells the caller which validation rules apply (the single-edit
 * path honours the legacy `count` argument; a batch requires each entry to be
 * unique unless its own `replace_all` is set).
 */
export function resolveEditOperations(
  args: Record<string, unknown>,
): { ok: true; operations: EditOperation[]; usedBatch: boolean } | { ok: false; content: string } {
  const hasSingle = args.old_string !== undefined || args.new_string !== undefined;
  const rawEdits = args.edits;
  const hasBatch = rawEdits !== undefined;

  if (hasBatch && hasSingle) {
    return { ok: false, content: `file_edit: use either edits (array) or old_string/new_string, not both.` };
  }

  if (hasBatch) {
    if (!Array.isArray(rawEdits)) return { ok: false, content: "file_edit: edits must be an array" };
    if (rawEdits.length < 1 || rawEdits.length > MAX_BATCH_EDITS) {
      return { ok: false, content: `file_edit: edits must contain between 1 and ${MAX_BATCH_EDITS} items` };
    }
    const operations: EditOperation[] = [];
    for (let index = 0; index < rawEdits.length; index++) {
      const entry = rawEdits[index];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return { ok: false, content: `edit ${index + 1}: must be an object` };
      }
      const record = entry as Record<string, unknown>;
      const oldString = strFirst(record, "old_string", "find");
      const newString = strFirst(record, "new_string", "replace");
      if (oldString === undefined) {
        return { ok: false, content: `edit ${index + 1}: requires old_string (or its alias find)` };
      }
      if (newString === undefined) {
        return { ok: false, content: `edit ${index + 1}: requires new_string (or its alias replace)` };
      }
      if (oldString.length === 0) return { ok: false, content: `edit ${index + 1}: old_string must be non-empty` };
      operations.push({ oldString, newString, replaceAll: bool(record, "replace_all", false) });
    }
    return { ok: true, operations, usedBatch: true };
  }

  const oldString = strFirst(args, "old_string", "find");
  const newString = strFirst(args, "new_string", "replace");
  if (oldString === undefined) return { ok: false, content: "file_edit requires old_string (or its alias find)" };
  if (newString === undefined) return { ok: false, content: "file_edit requires new_string (or its alias replace)" };
  if (oldString.length === 0) return { ok: false, content: "old_string must be non-empty" };
  const replaceAll = bool(args, "replace_all", false);
  return { ok: true, operations: [{ oldString, newString, replaceAll }], usedBatch: false };
}

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
      "Replace exact text inside a workspace file with a targeted edit. Pass the exact old_string to find and the new_string to write in its place; find/replace are accepted as aliases. The match must be unique unless you pass replace_all, which replaces every occurrence, or count, which must equal the number of occurrences. Include enough surrounding context (a full line or more) so the find text matches exactly once, and remember the match is literal, not a regular expression. To change several spots at once, pass `edits` (an ordered array of {old_string, new_string, replace_all?}); the batch is all-or-nothing and reports every failure, so nothing is written unless every edit matches. A missing match never fuzzy-applies: the error says whether the text was found after trimming whitespace or with different indentation, and the indentation hint names the 1-based line, otherwise it is a plain not-found. Read the file first: an unread or stale file is refused, and a successful edit refreshes the read snapshot. An old_string equal to new_string is reported as a no-op and writes nothing. On success the result includes a line-numbered snippet of the file around the change. When NOT to use: use file_multi_edit for several changes to the same file (it is atomic and reports a diff); use file_write to create a file or fully rewrite one you have read; use file_search to find text; never build a file through repeated shell echo/Set-Content, which bypasses read tracking and can corrupt line endings.",
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
        edits: {
          type: "array",
          description:
            "Ordered batch of replacements applied in one atomic operation. Each entry is applied in order, so a later edit sees the result of an earlier one. All-or-nothing: if any entry fails, nothing is written and every failure is reported. Mutually exclusive with old_string/new_string.",
          minItems: 1,
          maxItems: MAX_BATCH_EDITS,
          items: {
            type: "object",
            properties: {
              old_string: { type: "string", description: "Exact text to find. Must occur exactly once unless replace_all is true." },
              new_string: { type: "string", description: "Replacement text. Must differ from old_string." },
              find: { type: "string", description: "Alias for old_string." },
              replace: { type: "string", description: "Alias for new_string." },
              replace_all: { type: "boolean", description: "Replace every occurrence for this entry instead of requiring a single match (default false)." },
            },
            anyOf: [{ required: ["old_string", "new_string"] }, { required: ["find", "replace"] }],
          },
        },
      },
      required: ["path"],
      anyOf: [{ required: ["edits"] }, { required: ["old_string", "new_string"] }, { required: ["find", "replace"] }],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      let p: string;
      try {
        p = resolveWrite(ctx.workspace, str(args, "path"));
      } catch (err) {
        return { ok: false, content: err instanceof Error ? err.message : String(err) };
      }

      // Resolve the requested operations before taking the lock: argument
      // shape problems are reported without touching the file.
      const operations = resolveEditOperations(args);
      if (!operations.ok) return { ok: false, content: operations.content };

      // Read the file, verify the match and write the replacement under one
      // per-path lock, so two concurrent edits cannot both read the same
      // original and race their writes (a lost update).
      return withLock(p, async () => {
        const guard = guardExistingEdit(ctx, p);
        if (guard) return guard;
        if (!fs.existsSync(p)) return { ok: false, content: `not found: ${p}` };
        let original: string;
        try {
          original = fs.readFileSync(p, "utf8");
        } catch (err) {
          return { ok: false, content: `cannot read ${p}: ${err instanceof Error ? err.message : String(err)}` };
        }

        const first = operations.operations[0]!;

        if (!operations.usedBatch && first.oldString === first.newString) {
          return {
            ok: false,
            content: `old_string and new_string are identical, so this edit would change nothing. Provide a new_string that actually differs from old_string (or drop this no-op edit).`,
          };
        }

        // Legacy `count` (single-edit path, replace_all unset): the caller asserts
        // how many occurrences exist. That assertion takes the place of the
        // uniqueness rule, and the legacy write behaviour is to replace every
        // occurrence, so the count is checked against what was actually replaced
        // before anything is written. Without an explicit count the spec rule
        // applies (the match must be unique unless replace_all is set).
        const legacyCount =
          !operations.usedBatch && !first.replaceAll && args.count !== undefined ? num(args, "count", 1) : undefined;
        const requested =
          legacyCount === undefined
            ? operations.operations
            : operations.operations.map((operation) => ({ ...operation, replaceAll: true }));

        const outcome = applyEditOperations(original, requested, p);
        if (!outcome.ok) return { ok: false, content: formatEditFailures(p, outcome.failures, requested.length) };

        const applied = outcome.applied;
        const occurrences = applied.reduce((sum, edit) => sum + edit.occurrences, 0);

        if (!operations.usedBatch) {
          // Single-edit shorthand: honour the legacy `count` expectation.
          const replaceAll = first.replaceAll;
          if (legacyCount !== undefined && occurrences !== legacyCount) {
            return {
              ok: false,
              content: `Found ${occurrences} matches of old_string in ${p}, but replace_all is false and count is ${legacyCount}. Add more surrounding context to old_string (include more lines or words around the change) so it matches exactly ${legacyCount} time(s), or set replace_all to true to replace every match.`,
            };
          }
          fs.writeFileSync(p, outcome.content, "utf8");
          // Refresh the read snapshot so a follow-up edit in the same session is
          // not rejected as stale; the model already saw the pre-edit content.
          ctx.readState?.record(p);
          const where = extractContext(outcome.content, applied[0]!.startLine, applied[0]!.endLine, EDIT_CONTEXT_LINES);
          const snippet = `\nContext after edit (lines ${where.startLine}-${where.endLine}):\n${where.text}`;
          const suffix = replaceAll ? " (replace_all)" : "";
          return {
            ok: true,
            content: await withDiagnostics(`replaced ${occurrences} occurrence(s) in ${p}${suffix}${snippet}`, p, ctx),
          };
        }

        // Batch: apply in order to the in-memory content, line endings and a
        // BOM are preserved by operating on the raw string.
        fs.writeFileSync(p, outcome.content, "utf8");
        ctx.readState?.record(p);
        const lines: string[] = [`applied ${operations.operations.length} edit(s) to ${p} (${occurrences} replacement(s))`];
        for (let i = 0; i < applied.length; i++) {
          const edit = applied[i]!;
          lines.push(`  ok edit ${i + 1}: replaced ${edit.occurrences} occurrence(s) at line ${edit.startLine}`);
        }
        lines.push("");
        for (let i = 0; i < applied.length; i++) {
          const edit = applied[i]!;
          const where = extractContext(outcome.content, edit.startLine, edit.endLine, EDIT_CONTEXT_LINES);
          lines.push(`Context after edit ${i + 1} (lines ${where.startLine}-${where.endLine}):`);
          lines.push(where.text);
          lines.push("");
        }
        return { ok: true, content: await withDiagnostics(lines.join("\n").trimEnd(), p, ctx) };
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
