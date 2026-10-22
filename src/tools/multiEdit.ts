import fs from "node:fs";
import path from "node:path";
import { resolveWrite } from "../policy/paths.js";
import {
  formatDiagnosticReport,
  resolveDiagnosticsSettings,
  runDiagnostics,
} from "../agent/diagnostics.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { bool, str, strFirst } from "./registry.js";
import { guardExistingEdit } from "./readState.js";

const MAX_EDITS = 50;
/** Above this many lines on either side, fall back to a coarse prefix/suffix diff. */
const MAX_DIFF_LINES = 2000;
const BOM = "\uFEFF";

interface MultiEdit {
  find: string;
  replace: string;
  replaceAll: boolean;
}

interface DiffHunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  added: number;
  removed: number;
}

interface DiffSummary {
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n|\r/g, "\n");
}

/** Write via a sibling temp file + rename so readers never observe a partial write. */
function atomicWrite(target: string, data: string): void {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp file may never have been created */
    }
    throw err;
  }
}

/** Coarse diff used when the file is too large for the LCS table. */
function coarseDiff(a: string[], b: string[]): DiffSummary {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const removed = a.length - prefix - suffix;
  const added = b.length - prefix - suffix;
  const hunks: DiffHunk[] =
    removed > 0 || added > 0
      ? [{ oldStart: prefix + 1, oldEnd: prefix + removed, newStart: prefix + 1, newEnd: prefix + added, added, removed }]
      : [];
  return { added, removed, hunks };
}

/** Line diff via LCS, producing unified-diff-style hunks. */
function diffLines(a: string[], b: string[]): DiffSummary {
  const n = a.length;
  const m = b.length;
  if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES) return coarseDiff(a, b);

  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  const at = (row: number, col: number): number => dp[row * width + col] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  type Op = { type: "equal" | "delete" | "insert" };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal" });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ type: "delete" });
      i++;
    } else {
      ops.push({ type: "insert" });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "delete" });
    i++;
  }
  while (j < m) {
    ops.push({ type: "insert" });
    j++;
  }

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const op of ops) {
    if (op.type === "equal") {
      if (current) {
        hunks.push(current);
        current = null;
      }
      oldLine++;
      newLine++;
      continue;
    }
    if (!current) {
      current = { oldStart: oldLine + 1, oldEnd: oldLine, newStart: newLine + 1, newEnd: newLine, added: 0, removed: 0 };
    }
    if (op.type === "delete") {
      current.removed++;
      current.oldEnd = oldLine + 1;
      oldLine++;
    } else {
      current.added++;
      current.newEnd = newLine + 1;
      newLine++;
    }
  }
  if (current) hunks.push(current);

  for (const h of hunks) {
    if (h.removed === 0) h.oldStart = h.oldEnd;
    if (h.added === 0) h.newStart = h.newEnd;
  }
  return {
    added: hunks.reduce((sum, h) => sum + h.added, 0),
    removed: hunks.reduce((sum, h) => sum + h.removed, 0),
    hunks,
  };
}

function formatSummary(p: string, editCount: number, oldLineCount: number, newLineCount: number, diff: DiffSummary): string {
  const lines = [`applied ${editCount} edit(s) to ${p}`, `lines: ${oldLineCount} -> ${newLineCount}`];
  for (const h of diff.hunks) {
    lines.push(`@@ -${h.oldStart},${h.removed} +${h.newStart},${h.added} @@`);
  }
  lines.push(`total: +${diff.added} -${diff.removed} across ${diff.hunks.length} changed range(s)`);
  return lines.join("\n");
}

export function createMultiEditTools(): Tool[] {
  return [
    {
      name: "file_multi_edit",
      description:
        "Apply several exact string replacements to one workspace file in a single atomic operation. Each edit uses old_string/new_string; find/replace are accepted as aliases. Each old_string must match exactly once unless you set replace_all, which replaces every occurrence. The file is only rewritten if every edit succeeds; if any find is missing or ambiguous, nothing is written and the original is left untouched. Edits are applied in order to the in-memory content, line endings and a BOM are preserved, and a successful call refreshes the read snapshot. It is a mutating effect, so keep it serial. When NOT to use: use file_edit for a single change, file_write to create or fully rewrite a file, and file_search to locate text; never build a file through repeated shell echoes, which bypasses read tracking and can corrupt line endings.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Target file path inside the workspace." },
          edits: {
            type: "array",
            description: "Ordered edits applied sequentially to the in-memory content.",
            minItems: 1,
            maxItems: MAX_EDITS,
            items: {
              type: "object",
              properties: {
                old_string: { type: "string", description: "Exact text to find. Must occur exactly once unless replace_all is true." },
                new_string: { type: "string", description: "Replacement text. Must differ from old_string." },
                find: { type: "string", description: "Alias for old_string." },
                replace: { type: "string", description: "Alias for new_string." },
                replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one (default false)." },
                replaceAll: { type: "boolean", description: "Alias for replace_all." },
              },
              anyOf: [{ required: ["old_string", "new_string"] }, { required: ["find", "replace"] }],
            },
          },
        },
        required: ["path", "edits"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        let p: string;
        try {
          p = resolveWrite(ctx.workspace, str(args, "path"));
        } catch (err) {
          return { ok: false, content: err instanceof Error ? err.message : String(err) };
        }

        const guard = guardExistingEdit(ctx, p);
        if (guard) return guard;

        const rawEdits = args.edits;
        if (!Array.isArray(rawEdits)) return { ok: false, content: "edits must be an array" };
        if (rawEdits.length < 1 || rawEdits.length > MAX_EDITS) {
          return { ok: false, content: `edits must contain between 1 and ${MAX_EDITS} items` };
        }

        const edits: MultiEdit[] = [];
        for (let index = 0; index < rawEdits.length; index++) {
          const entry = rawEdits[index];
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            return { ok: false, content: `edit ${index + 1}: must be an object` };
          }
          const record = entry as Record<string, unknown>;
          const find = strFirst(record, "old_string", "find");
          const replace = strFirst(record, "new_string", "replace");
          if (find === undefined) return { ok: false, content: `edit ${index + 1}: requires old_string (or its alias find)` };
          if (replace === undefined) return { ok: false, content: `edit ${index + 1}: requires new_string (or its alias replace)` };
          if (find.length === 0) return { ok: false, content: `edit ${index + 1}: old_string must be non-empty` };
          edits.push({ find, replace, replaceAll: bool(record, "replace_all", bool(record, "replaceAll")) });
        }

        if (!fs.existsSync(p)) return { ok: false, content: `not found: ${p}` };

        let original: string;
        try {
          original = fs.readFileSync(p, "utf8");
        } catch (err) {
          return { ok: false, content: `cannot read ${p}: ${err instanceof Error ? err.message : String(err)}` };
        }

        let bom = "";
        let body = original;
        if (body.startsWith(BOM)) {
          bom = BOM;
          body = body.slice(BOM.length);
        }
        const hasCrlf = body.includes("\r\n");
        const normalized = body.replace(/\r\n/g, "\n");

        let work = normalized;
        for (let index = 0; index < edits.length; index++) {
          const edit = edits[index]!;
          const find = normalizeNewlines(edit.find);
          const replace = normalizeNewlines(edit.replace);
          if (find === replace) {
            return {
              ok: false,
              content: `edit ${index + 1}: old_string and new_string are identical, so this edit would change nothing. Provide a new_string that actually differs from old_string (or drop this no-op edit).`,
            };
          }
          const count = countOccurrences(work, find);
          if (count === 0) return { ok: false, content: `edit ${index + 1}: old_string text not found` };
          if (count > 1 && !edit.replaceAll) {
            return {
              ok: false,
              content: `edit ${index + 1}: old_string is ambiguous: ${count} matches in ${p}, but replace_all is false. Add more surrounding context to old_string (include more lines or words around the change) so it matches exactly once, or set replace_all to true to replace every match.`,
            };
          }
          work = work.split(find).join(replace);
        }

        const result = hasCrlf ? work.replace(/\n/g, "\r\n") : work;
        const data = bom + result;

        const diff = diffLines(normalized.split("\n"), work.split("\n"));
        try {
          atomicWrite(p, data);
        } catch (err) {
          return { ok: false, content: `cannot write ${p}: ${err instanceof Error ? err.message : String(err)}` };
        }

        // Refresh the read snapshot so a follow-up edit in the same session is
        // not rejected as stale; the model already saw the pre-edit content.
        ctx.readState?.record(p);

        const summary = formatSummary(p, edits.length, normalized.split("\n").length, work.split("\n").length, diff);
        let content = summary;
        try {
          const settings = resolveDiagnosticsSettings(ctx.workspace, ctx.cfg);
          if (settings.enabled) {
            const outcome = await runDiagnostics(p, settings);
            if (outcome) content = `${summary}\n\n${formatDiagnosticReport(outcome)}`;
          }
        } catch {
          /* diagnostics are advisory and never fail the edit */
        }
        return { ok: true, content };
      },
    },
  ];
}
