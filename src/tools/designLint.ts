/**
 * design_lint — Loam UI Kit token linting for agent runs.
 *
 * Wraps the static checker in ../design/tokenLint.ts so the model can audit a
 * generated UI (or a whole task workspace) against the design system without a
 * shell round-trip. The tool is read-only: it never edits files, never runs
 * code, and never touches the network.
 *
 * Two input shapes are supported:
 *  - `source` + optional `fileName`: lint a single in-memory string.
 *  - `paths`: lint one or more workspace files, recursively walking
 *    directories with an explicit extension allow-list.
 *
 * The result is the full violation list with 1-based line/column coordinates
 * plus a category summary, so the agent can decide whether to fix in place
 * (with file_edit) or hand the report to the user.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveRead } from "../policy/paths.js";
import { lintDesignSource, type DesignLintOptions, type DesignLintResult } from "../design/tokenLint.js";
import { bool, num, str, strs, type Tool, type ToolContext, type ToolResult } from "./registry.js";

export const DESIGN_LINT_TOOL_NAME = "design_lint";
export const DESIGN_LINT_TOOL_NAMES = [DESIGN_LINT_TOOL_NAME];

/** Extensions the linter is willing to read; everything else is skipped. */
const LINTABLE_EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js", ".html", ".css", ".scss", ".vue", ".svelte"]);
/** Directories that never contain UI source worth linting. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".manus", "vendor"]);
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 40;
const MAX_TEXT = 40_000;

function isLintable(file: string): boolean {
  return LINTABLE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  const deadline = Date.now() + 4000;
  const walk = (dir: string, depth: number): void => {
    if (out.length >= MAX_FILES || depth > 6 || Date.now() > deadline) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES || Date.now() > deadline) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(full, depth + 1);
        continue;
      }
      if (entry.isFile() && isLintable(entry.name)) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

function toWorkspaceRelative(file: string, ctx: ToolContext): string {
  const relative = path.relative(ctx.workspace, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return file;
  return relative.split(path.sep).join("/");
}

function readLintableFile(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) return undefined;
    const content = fs.readFileSync(file, "utf8");
    return content.slice(0, MAX_TEXT);
  } catch {
    return undefined;
  }
}

interface LintFile {
  path: string;
  source: string;
  /** Why the file was not linted, when it was skipped. */
  skipped?: string;
}

interface LintRequest {
  options: DesignLintOptions;
  files: LintFile[];
}

function lintFiles(paths: string[], ctx: ToolContext, options: DesignLintOptions): LintRequest {
  const files: LintFile[] = [];
  for (const rawPath of paths) {
    const resolved = resolveRead(ctx.workspace, rawPath, ctx.cfg.policy.allowOutsideWorkspaceRead);
    if (!fs.existsSync(resolved)) {
      files.push({ path: rawPath, source: "", skipped: "not found" });
      continue;
    }
    if (fs.statSync(resolved).isDirectory()) {
      for (const file of collectFiles(resolved)) {
        const source = readLintableFile(file);
        files.push({
          path: toWorkspaceRelative(file, ctx),
          source: source ?? "",
          skipped: source === undefined ? "too large or unreadable" : undefined,
        });
      }
      continue;
    }
    if (!isLintable(resolved)) {
      files.push({ path: rawPath, source: "", skipped: `unsupported extension (${path.extname(resolved) || "none"})` });
      continue;
    }
    const source = readLintableFile(resolved);
    files.push({ path: rawPath, source: source ?? "", skipped: source === undefined ? "too large or unreadable" : undefined });
  }
  return { options, files };
}

/** A file is reportable only when it was actually read and is lintable. */
function isLintableFile(file: LintFile): boolean {
  return file.source.length > 0 && !file.skipped;
}

function combineResults(results: DesignLintResult[]): { ok: boolean; total: number; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const result of results) {
    total += result.violations.length;
    for (const [category, count] of Object.entries(result.summary.counts)) {
      counts[category] = (counts[category] ?? 0) + count;
    }
  }
  return { ok: total === 0, total, counts };
}

function formatSingle(result: DesignLintResult, fileName: string): string {
  const header = `${fileName}: ${result.violations.length} violation(s), ${result.summary.colours} colour(s), ${result.summary.fonts} font family(ies)`;
  if (result.ok) return `${header}\nNo design-system violations found.`;
  const lines = [header];
  for (const violation of result.violations) {
    lines.push(`  ${violation.line}:${violation.column} [${violation.category}] ${violation.message}`);
  }
  return lines.join("\n");
}

function lintMany(request: LintRequest): { ok: boolean; report: string; files: string[]; counts: Record<string, number>; total: number } {
  const skipped = request.files.filter((file) => file.skipped);
  const results = request.files
    .filter(isLintableFile)
    .map((file) => ({ path: file.path, result: lintDesignSource(file.source, request.options) }));
  const combined = combineResults(results.map((entry) => entry.result));
  const lines: string[] = [];
  if (results.length === 0) {
    lines.push(`design_lint: nothing to check (0 lintable files among ${request.files.length} path(s)).`);
  } else {
    lines.push(`design_lint: ${combined.total} violation(s) across ${results.length} file(s)`);
    for (const entry of results) {
      lines.push("");
      lines.push(formatSingle(entry.result, entry.path));
    }
  }
  // Skipped entries are listed even when they are the whole request, so the
  // agent can see why a path produced no evidence instead of guessing.
  for (const file of skipped) lines.push(`  skipped ${file.path}: ${file.skipped}`);
  return {
    ok: combined.ok,
    report: lines.join("\n"),
    files: results.map((entry) => entry.path),
    counts: combined.counts,
    total: combined.total,
  };
}

export function createDesignLintTools(): Tool[] {
  return [
    {
      name: DESIGN_LINT_TOOL_NAME,
      description:
        "Check UI source against the Loam UI Kit design rules: raw colours, more than five colours, more than two font families, arbitrary pixel values, emoji used as icons, images missing alt text, decorative gradients, and RTL layout correctness (logical properties, dir=rtl for Arabic). Pass `source` to lint one in-memory string, or `paths` to lint workspace files/directories (recursively, lintable extensions only). Returns every violation with 1-based line and column, a source snippet and a per-category summary. Read-only: it never modifies files. Use it before presenting a generated UI, then fix violations in place with file_edit.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Design source to lint (TSX/HTML/CSS/JS text)." },
          fileName: { type: "string", description: "Label for `source` in the report (default 'inline')." },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Workspace files or directories to lint; directories are walked recursively.",
          },
          maxColours: { type: "integer", minimum: 1, description: "Palette limit (default 5)." },
          maxFonts: { type: "integer", minimum: 1, description: "Font-family limit (default 2)." },
          allowedColours: {
            type: "array",
            items: { type: "string" },
            description: "Colour values that are explicitly permitted (hex or Tailwind utility).",
          },
          disabled: {
            type: "array",
            items: { type: "string" },
            description: "Categories to skip (raw-colour, too-many-colours, too-many-fonts, arbitrary-px, emoji-icon, missing-alt, gradient, rtl-logical-properties, rtl-direction).",
          },
          ignoreTokenDefinitions: { type: "boolean", description: "Skip CSS custom-property definitions (default true)." },
          format: { type: "string", enum: ["text", "json"], description: "Report format (default 'text')." },
        },
      },
      async run(args, ctx): Promise<ToolResult> {
        const options: DesignLintOptions = {
          maxColours: num(args, "maxColours", 5),
          maxFonts: num(args, "maxFonts", 2),
          allowedColours: strs(args, "allowedColours"),
          disabled: strs(args, "disabled") as DesignLintOptions["disabled"],
          ignoreTokenDefinitions: bool(args, "ignoreTokenDefinitions", true),
        };
        const source = str(args, "source");
        const paths = strs(args, "paths").filter((p) => p.length > 0);
        if (source.length === 0 && paths.length === 0) {
          return { ok: false, content: "design_lint: provide `source` or `paths`." };
        }
        if (source.length > 0 && paths.length > 0) {
          return { ok: false, content: "design_lint: pass either `source` or `paths`, not both." };
        }

        try {
          if (source.length > 0) {
            const fileName = str(args, "fileName") || "inline";
            const result = lintDesignSource(source, options);
            const payload = {
              ok: result.ok,
              file: fileName,
              violations: result.violations,
              summary: result.summary,
            };
            const content = str(args, "format") === "json" ? JSON.stringify(payload) : formatSingle(result, fileName);
            return { ok: result.ok, content };
          }

          const request = lintFiles(paths, ctx, options);
          const outcome = lintMany(request);
          const payload = {
            ok: outcome.ok,
            files: outcome.files,
            totalViolations: outcome.total,
            counts: outcome.counts,
            report: outcome.report,
          };
          return { ok: outcome.ok, content: str(args, "format") === "json" ? JSON.stringify(payload) : outcome.report };
        } catch (error) {
          return { ok: false, content: `design_lint failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    },
  ];
}
