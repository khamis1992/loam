import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, OllamaClient } from "../ollama.js";
import { chatWithFallback } from "../agent/model.js";
import { resolveWrite } from "../policy/paths.js";
import { atomicWrite, countOccurrences, diffLines, normalizeNewlines, type DiffSummary } from "./multiEdit.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { bool, num, str } from "./registry.js";

/**
 * `find_and_edit` — regex fan-out editing.
 *
 * Finds every regex match under a directory (honouring file/exclude globs), asks
 * the model — one sub-call per match, through the existing model layer — to
 * produce either an edit or "no change", then applies the approved edits with the
 * same safe primitives as `file_multi_edit` (exact match, BOM/CRLF preserved,
 * atomic write). Supports `dry_run` and a `max_matches` cap.
 */

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

const BOM = "\uFEFF";
const MAX_SCAN_BYTES = 500_000;
const MAX_FILES = 1000;
const DEFAULT_MAX_MATCHES = 100;
const MAX_MAX_MATCHES = 500;
const CONTEXT_LINES = 2;

export type FindAndEditModelCall = (messages: ChatMessage[]) => Promise<string>;

export interface FindAndEditOptions {
  ollama: OllamaClient;
  /** Injectable model sub-call for tests; defaults to the shared fallback chain. */
  callModel?: FindAndEditModelCall;
}

export type EditDecision =
  | { action: "no_change" }
  | { action: "edit"; find: string; replace: string };

interface MatchLocation {
  file: string;
  line: number;
  column: number;
  text: string;
  before: string;
  after: string;
}

interface FileEdit {
  find: string;
  replace: string;
}

interface AppliedFile {
  file: string;
  original: string;
  content: string;
  applied: number;
  skipped: Array<{ find: string; reason: string }>;
  diff: DiffSummary;
}

interface SkippedMatch {
  file: string;
  line: number;
  reason: string;
}

/** Minimal glob → RegExp: `**` crosses directories, `*`/`?` stay within one segment. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  let pattern = escaped
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  // A leading `**/` also matches files at the root (zero directories).
  pattern = pattern.replace(/^\.\*\//, "(?:.*/)?");
  return new RegExp(`^${pattern}$`, "i");
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function matchesGlob(relPath: string, basename: string, glob: string): boolean {
  const trimmed = glob.trim();
  if (trimmed.length === 0) return true;
  if (!/[*?]/.test(trimmed)) return relPath.toLowerCase().includes(trimmed.toLowerCase());
  const re = globToRegExp(trimmed);
  return re.test(relPath) || re.test(basename);
}

function listFiles(root: string, fileGlob: string, excludeGlob: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= MAX_FILES || depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = toPosix(path.relative(root, full));
      if (!matchesGlob(rel, entry.name, fileGlob)) continue;
      if (excludeGlob.trim().length > 0 && matchesGlob(rel, entry.name, excludeGlob)) continue;
      out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

/** Collect regex matches across files, stopping once `maxMatches` is reached. */
export function collectMatches(root: string, regex: string, opts: { fileGlob?: string; excludeGlob?: string; maxMatches: number }): MatchLocation[] {
  let re: RegExp;
  try {
    re = new RegExp(regex, "g");
  } catch (err) {
    throw new Error(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
  }
  const matches: MatchLocation[] = [];
  for (const file of listFiles(root, opts.fileGlob ?? "", opts.excludeGlob ?? "")) {
    if (matches.length >= opts.maxMatches) break;
    let content: string;
    try {
      if (fs.statSync(file).size > MAX_SCAN_BYTES) continue;
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (matches.length >= opts.maxMatches) break;
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const before = content.slice(0, m.index);
      const line = before.split("\n").length;
      const lineStart = before.lastIndexOf("\n") + 1;
      const after = content.slice(m.index + m[0].length);
      matches.push({
        file,
        line,
        column: m.index - lineStart + 1,
        text: m[0],
        before: before.split("\n").slice(-CONTEXT_LINES).join("\n"),
        after: after.split("\n").slice(0, CONTEXT_LINES + 1).join("\n"),
      });
    }
  }
  return matches;
}

/** Parse the model's decision, tolerating code fences and stray prose. */
export function parseEditDecision(raw: string, fallbackFind: string): EditDecision {
  const fenced = raw.replace(/```(?:json)?/gi, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return { action: "no_change" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return { action: "no_change" };
  }
  if (typeof parsed !== "object" || parsed === null) return { action: "no_change" };
  const record = parsed as Record<string, unknown>;
  const action = String(record.action ?? "").toLowerCase();
  if (action === "edit" || action === "replace" || action === "change") {
    const replace = typeof record.replace === "string" ? record.replace : "";
    const find = typeof record.find === "string" && record.find.length > 0 ? record.find : fallbackFind;
    if (find.length === 0) return { action: "no_change" };
    return { action: "edit", find, replace };
  }
  return { action: "no_change" };
}

function buildSystemPrompt(): string {
  return [
    "You are a precise code editor. For each match you receive, decide the single best edit or make no change.",
    "Reply with ONLY a JSON object — no prose, no markdown, no line numbers.",
    'If a change is needed: {"action":"edit","find":"<exact text currently in the file to replace>","replace":"<new text>"}',
    'If no change is needed: {"action":"no_change"}',
    'Rules: "find" must be the exact text as it appears in the file (you may include surrounding context to make it unique).',
    "If the match already satisfies the instruction, return no_change.",
  ].join("\n");
}

function buildUserPrompt(match: MatchLocation, instruction: string): string {
  return [
    `Instruction: ${instruction}`,
    "",
    `File: ${match.file}`,
    `Line: ${match.line}`,
    "",
    "Match:",
    match.text,
    "",
    "Context before:",
    match.before,
    "",
    "Context after:",
    match.after,
  ].join("\n");
}

/** Apply exact-match edits sequentially; BOM/CRLF preserved; returns per-file outcome. */
function applyFileEdits(file: string, original: string, edits: FileEdit[]): AppliedFile {
  const skipped: Array<{ find: string; reason: string }> = [];
  let bom = "";
  let body = original;
  if (body.startsWith(BOM)) {
    bom = BOM;
    body = body.slice(BOM.length);
  }
  const hasCrlf = body.includes("\r\n");
  const normalized = normalizeNewlines(body);
  let work = normalized;
  let applied = 0;
  for (const edit of edits) {
    const find = normalizeNewlines(edit.find);
    const replace = normalizeNewlines(edit.replace);
    if (find.length === 0) {
      skipped.push({ find: edit.find, reason: "empty find text" });
      continue;
    }
    const count = countOccurrences(work, find);
    if (count === 0) {
      skipped.push({ find: edit.find, reason: "find text not found" });
      continue;
    }
    if (count > 1) {
      skipped.push({ find: edit.find, reason: `ambiguous (${count} matches)` });
      continue;
    }
    work = work.split(find).join(replace);
    applied++;
  }
  const content = bom + (hasCrlf ? work.replace(/\n/g, "\r\n") : work);
  const diff = diffLines(normalized.split("\n"), work.split("\n"));
  return { file, original, content, applied, skipped, diff };
}

function formatCombined(files: AppliedFile[], dryRun: boolean, totalMatches: number, noChange: number, skippedMatches: SkippedMatch[]): string {
  const lines: string[] = [];
  const appliedEdits = files.reduce((sum, f) => sum + f.applied, 0);
  const skippedEdits = files.reduce((sum, f) => sum + f.skipped.length, 0);
  lines.push(
    `find_and_edit: ${totalMatches} match(es) in ${files.length} file(s); ${appliedEdits} edit(s) applied, ${noChange} no-change, ${skippedEdits + skippedMatches.length} skipped${dryRun ? " (dry run — nothing written)" : ""}`,
  );
  for (const f of files) {
    lines.push("");
    lines.push(`${f.file}${dryRun ? " (would change)" : ""}`);
    lines.push(`applied ${f.applied} edit(s); lines: ${f.original.split("\n").length} -> ${f.content.split("\n").length}`);
    for (const h of f.diff.hunks) {
      lines.push(`@@ -${h.oldStart},${h.removed} +${h.newStart},${h.added} @@`);
    }
    lines.push(`total: +${f.diff.added} -${f.diff.removed} across ${f.diff.hunks.length} changed range(s)`);
    for (const s of f.skipped) lines.push(`skipped: ${s.reason}: ${JSON.stringify(s.find).slice(0, 120)}`);
  }
  for (const s of skippedMatches) lines.push(`skipped ${s.file}:${s.line}: ${s.reason}`);
  const added = files.reduce((sum, f) => sum + f.diff.added, 0);
  const removed = files.reduce((sum, f) => sum + f.diff.removed, 0);
  const changed = files.filter((f) => f.diff.hunks.length > 0).length;
  lines.push("");
  lines.push(`combined: +${added} -${removed} across ${changed} changed file(s)`);
  return lines.join("\n");
}

export function createFindAndEditTools(options: FindAndEditOptions): Tool[] {
  return [
    {
      name: "find_and_edit",
      description:
        "Find every regex match under a directory, then for each match ask the model to produce an edit or 'no change' and apply the approved edits safely. " +
        "Use for repetitive, instruction-driven changes spread across many files/locations (rename a pattern, apply a convention, update a marker). " +
        "Returns a combined diff. Set dry_run to preview without writing; max_matches caps the number of matches processed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["dir", "regex", "instruction"],
        properties: {
          dir: { type: "string", description: "Directory to search, relative to the workspace (default '.')." },
          regex: { type: "string", description: "Regular expression to match in file contents." },
          instruction: { type: "string", description: "What the model should do at each match (the edit to produce)." },
          file_glob: { type: "string", description: "Only search files matching this glob (e.g. '*.ts', 'src/**')." },
          exclude_glob: { type: "string", description: "Skip files matching this glob (e.g. '*.md', 'dist/**')." },
          dry_run: { type: "boolean", description: "Preview the edits without writing any file (default false)." },
          max_matches: { type: "number", description: `Cap on matches processed (1-${MAX_MAX_MATCHES}, default ${DEFAULT_MAX_MATCHES}).` },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        let root: string;
        try {
          root = resolveWrite(ctx.workspace, str(args, "dir") || ".");
        } catch (err) {
          return { ok: false, content: err instanceof Error ? err.message : String(err) };
        }
        if (!fs.existsSync(root)) return { ok: false, content: `not found: ${root}` };
        if (!fs.statSync(root).isDirectory()) return { ok: false, content: `not a directory: ${root}` };

        const regex = str(args, "regex");
        const instruction = str(args, "instruction").trim();
        if (regex.length === 0) return { ok: false, content: "find_and_edit requires a regex" };
        if (instruction.length === 0) return { ok: false, content: "find_and_edit requires an instruction" };
        const fileGlob = str(args, "file_glob");
        const excludeGlob = str(args, "exclude_glob");
        const dryRun = bool(args, "dry_run");
        const maxMatches = Math.min(Math.max(num(args, "max_matches", DEFAULT_MAX_MATCHES), 1), MAX_MAX_MATCHES);

        let matches: MatchLocation[];
        try {
          matches = collectMatches(root, regex, { fileGlob, excludeGlob, maxMatches });
        } catch (err) {
          return { ok: false, content: err instanceof Error ? err.message : String(err) };
        }
        if (matches.length === 0) {
          return { ok: true, content: `find_and_edit: no matches for /${regex}/ under ${root}` };
        }

        const callModel: FindAndEditModelCall =
          options.callModel ??
          (async (messages) => {
            const res = await chatWithFallback({ cfg: ctx.cfg, ollama: options.ollama, messages, temperature: 0 });
            return res.content;
          });

        const system = buildSystemPrompt();
        const editsByFile = new Map<string, FileEdit[]>();
        const skippedMatches: SkippedMatch[] = [];
        let noChange = 0;
        let cancelled = false;

        for (const match of matches) {
          if (ctx.signal?.aborted) {
            cancelled = true;
            break;
          }
          let raw: string;
          try {
            raw = await callModel([
              { role: "system", content: system },
              { role: "user", content: buildUserPrompt(match, instruction) },
            ]);
          } catch (err) {
            skippedMatches.push({ file: match.file, line: match.line, reason: err instanceof Error ? err.message : String(err) });
            continue;
          }
          const decision = parseEditDecision(raw, match.text);
          if (decision.action === "no_change") {
            noChange++;
            continue;
          }
          const list = editsByFile.get(match.file) ?? [];
          list.push({ find: decision.find, replace: decision.replace });
          editsByFile.set(match.file, list);
        }

        const files: AppliedFile[] = [];
        for (const [file, edits] of editsByFile) {
          let original: string;
          try {
            original = fs.readFileSync(file, "utf8");
          } catch {
            skippedMatches.push({ file, line: 0, reason: "cannot read file" });
            continue;
          }
          const result = applyFileEdits(file, original, edits);
          if (!dryRun && result.applied > 0) {
            try {
              atomicWrite(file, result.content);
            } catch (err) {
              skippedMatches.push({ file, line: 0, reason: `cannot write: ${err instanceof Error ? err.message : String(err)}` });
              continue;
            }
          }
          if (result.applied > 0 || result.skipped.length > 0) files.push(result);
        }

        const content = formatCombined(files, dryRun, matches.length, noChange, skippedMatches);
        return { ok: true, content: cancelled ? `${content}\n[cancelled — partial result]` : content };
      },
    },
  ];
}
