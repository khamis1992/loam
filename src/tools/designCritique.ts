/**
 * design_critique — vision rubric critique for a built interface.
 *
 * Wraps the rubric loop in src/design/critique.ts so the model can judge a
 * generated site against the Loam UI Kit without a shell round-trip. The tool is
 * read-only: it lints the source, captures the screenshots itself, sends them to
 * the vision model, parses and validates the rubric answer, and applies the
 * threshold logic. It never edits files, never rebuilds, and never touches the
 * network beyond the model endpoint and the local preview server.
 *
 * Two paths are supported:
 *  - `source` + `siteDir`: lint an in-memory UI and critique the screenshots
 *    already captured for it.
 *  - `dir` (a built site) + a running preview or `url`: capture fresh
 *    screenshots at the standard viewports, then critique them.
 *
 * Each fix round below the threshold returns one concrete instruction, so the
 * caller can edit and rebuild, capture again, and call the tool once more. The
 * loop is bounded and reported honestly: an unusable model answer is never
 * silently passed.
 */

import fs from "node:fs";
import path from "node:path";
import type { OllamaClient } from "../ollama.js";
import { PreviewService } from "../preview/serve.js";
import { DEFAULT_VIEWPORTS, PreviewScreenshotService } from "../preview/shot.js";
import { isInside, resolveRead, resolveWrite } from "../policy/paths.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { bool, num, str, strs } from "./registry.js";
import {
  CRITIQUE_MAX_MODEL_ATTEMPTS,
  CRITIQUE_MAX_ROUNDS,
  CRITIQUE_PASS_THRESHOLD,
  runVisionCritique,
  type VisionCritiqueInput,
} from "../design/critique.js";
import { lintSiteSource, minimalDesignLinter, resolveDirection, type LintResult } from "../design/tokenLint.js";

export const DESIGN_CRITIQUE_TOOL_NAME = "design_critique";
export const DESIGN_CRITIQUE_TOOL_NAMES = [DESIGN_CRITIQUE_TOOL_NAME];

export interface DesignCritiqueToolOptions {
  /** Injected model client. Without one the tool degrades to a deterministic
   *  rubric derived from the lint result, so a run never blocks on vision. */
  ollama?: OllamaClient;
}

function normalizeDirection(value: string): "ltr" | "rtl" | undefined {
  const v = value.trim().toLowerCase();
  if (v === "ltr" || v === "rtl") return v;
  return undefined;
}

function toWorkspaceRelative(file: string, ctx: ToolContext): string {
  const relative = path.relative(ctx.workspace, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return file;
  return relative.split(path.sep).join("/");
}

/**
 * Lint a directory on disk with the filesystem linter. Kept next to the tool so
 * the critique always judges the same rules `design_lint` reports, and so the
 * two tools cannot drift on the locale/direction defaults.
 */
export async function lintSiteDirectory(siteDir: string, options: { locale?: string; direction?: "ltr" | "rtl" } = {}): Promise<LintResult> {
  return minimalDesignLinter().lintSite(siteDir, options);
}

/**
 * Capture the screenshots the rubric judges. When a preview is already running
 * inside the workspace its URL is reused; otherwise the given directory is
 * served for the capture. The preview is left running so the next round can
 * reuse it.
 */
async function captureForCritique(args: Record<string, unknown>, ctx: ToolContext, preview: PreviewService): Promise<{ files: string[]; relative: string[]; url: string; errors: string[] } | { error: string }> {
  const shots = new PreviewScreenshotService(ctx.cfg);
  const workspace = ctx.workspace;

  let url = str(args, "url", "").trim();
  const dirArg = str(args, "dir", "").trim();
  const running = preview.status;
  if (!url && running.url && running.root && isInside(workspace, running.root)) url = running.url;
  if (!url) {
    if (!dirArg) return { error: "design_critique needs a `url`, a running preview (preview_serve first), or a `dir` to serve." };
    const resolved = resolveRead(workspace, dirArg, false);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return { error: `design_critique: not a directory: ${dirArg}` };
    url = (await preview.start(resolved, num(args, "port", 0) || undefined)).url;
  }

  const outDir = resolveWrite(workspace, str(args, "outDir") || `.preview-shots/${DESIGN_CRITIQUE_TOOL_NAME}`);
  const result = await shots.capture({
    workspace,
    url,
    outDir,
    viewports: DEFAULT_VIEWPORTS,
    waitMs: num(args, "waitMs", 0),
    fullPage: bool(args, "fullPage", true),
    signal: ctx.signal,
  });
  if (result.shots.length === 0) return { error: result.message ?? `screenshot capture failed for ${url}` };
  return {
    files: result.shots.map((shot) => shot.file),
    relative: result.shots.map((shot) => shot.relative),
    url,
    errors: result.errors,
  };
}

/**
 * Format the critique report. `source` says whether the rubric came from the
 * vision model or from the deterministic fallback, so the agent can tell a real
 * verdict from a lint-derived one.
 */
export function formatCritiqueReport(result: {
  ok: boolean;
  verdict: "accept" | "revise" | "invalid";
  score: number;
  dimensions: Array<{ id: string; label: string; score: number; note: string }>;
  issues: string[];
  fixes: string[];
  notes: string[];
  attempts: number;
  model: string;
  source: "model" | "fallback";
  lintScore: number;
  screenshotCount: number;
  threshold: number;
  /** Which critique round this verdict is, 1-based. */
  round?: number;
  /** Total rounds the caller allowed for this run. */
  maxRounds?: number;
}): string {
  const lines = [
    `design_critique: ${result.verdict} (score ${result.score}/100, bar ${result.threshold})${result.round !== undefined && result.maxRounds !== undefined ? ` — round ${result.round}/${result.maxRounds}` : ""}`,
    `source: ${result.source}${result.source === "model" ? ` (${result.model}, ${result.attempts} attempt(s))` : " (deterministic lint rubric)"}`,
    `token lint: ${result.lintScore}/100`,
    `screenshots judged: ${result.screenshotCount}`,
  ];
  lines.push("", "dimensions:");
  for (const dimension of result.dimensions) lines.push(`  ${String(dimension.score).padStart(3)}  ${dimension.label} (${dimension.id}) — ${dimension.note}`);
  lines.push("", `issues (${result.issues.length}):`);
  lines.push(...(result.issues.length > 0 ? result.issues.map((issue) => `- ${issue}`) : ["- none"]));
  lines.push("", `fixes (${result.fixes.length}):`);
  lines.push(...(result.fixes.length > 0 ? result.fixes.map((fix, index) => `${index + 1}. ${fix}`) : ["- none"]));
  if (result.notes.length > 0) lines.push("", `notes: ${result.notes.join("; ")}`);
  return lines.join("\n");
}

export function createDesignCritiqueTools(preview: PreviewService, options: DesignCritiqueToolOptions = {}): Tool[] {
  return [
    {
      name: DESIGN_CRITIQUE_TOOL_NAME,
      description:
        "Score a built interface against the Loam UI Kit rubric (visual hierarchy, spacing rhythm, text contrast, alignment, colour discipline, overflow control and RTL correctness) by sending the captured screenshots to the vision model. The answer is parsed and validated against a strict rubric contract; contrast, overflow and RTL are safety gates that block acceptance whatever the mean score is. Pass `dir` (a built site) plus a running preview or `url` to capture fresh screenshots at the 375/768/1440 viewports and critique them, or pass `screenshots` to critique an existing capture set. Returns the per-dimension scores, the blocking issues and the most impactful fix instruction. Read-only: it never edits files and never rebuilds. When the vision model is unavailable it degrades to a deterministic lint-derived rubric and says so in the report.",
      parameters: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Workspace folder of the built site to serve and capture (used when no url or screenshots are given)." },
          url: { type: "string", description: "Page URL to capture. Defaults to the running preview server URL." },
          screenshots: {
            type: "array",
            items: { type: "string" },
            description: "Existing PNG paths to critique instead of capturing new ones (workspace-relative or absolute inside the workspace).",
          },
          source: { type: "string", description: "Optional in-memory UI source to lint, for a report richer than the on-disk lint." },
          prompt: { type: "string", description: "The original build request, so the rubric can judge the page against it." },
          language: { type: "string", description: "Content language tag (e.g. 'en', 'ar'); Arabic content triggers RTL scrutiny." },
          direction: { type: "string", enum: ["ltr", "rtl"], description: "Explicit text direction; overrides language inference." },
          brief: { type: "string", description: "Design brief context (palette, tone, layout intent) for the critic." },
          threshold: { type: "integer", minimum: 0, maximum: 100, description: `Acceptance bar for the mean score (default ${CRITIQUE_PASS_THRESHOLD}).` },
          maxAttempts: { type: "integer", minimum: 1, maximum: 4, description: `Model repair attempts before the rubric is reported unusable (default ${CRITIQUE_MAX_MODEL_ATTEMPTS}).` },
          round: { type: "integer", minimum: 1, maximum: 8, description: "Which critique round this call is (1 for the first). Pass the previous round + 1 after applying a fix." },
          maxRounds: { type: "integer", minimum: 1, maximum: 8, description: `Total rounds this run may use before it must stop and report (default ${CRITIQUE_MAX_ROUNDS}).` },
          format: { type: "string", enum: ["text", "json"], description: "Report format (default 'text')." },
        },
      },
      async run(args, ctx): Promise<ToolResult> {
        try {
          const direction = normalizeDirection(str(args, "direction")) ?? (resolveDirection(str(args, "language")) === "rtl" ? "rtl" : "ltr");
          const locale = str(args, "language") || (direction === "rtl" ? "ar" : "en");
          const screenshotArgs = strs(args, "screenshots").map((file) => file.trim()).filter((file) => file.length > 0);
          const source = str(args, "source");

          let screenshotFiles: string[] = [];
          let screenshotRelative: string[] = [];
          let captureErrors: string[] = [];
          if (screenshotArgs.length > 0) {
            for (const raw of screenshotArgs) {
              const resolved = resolveRead(ctx.workspace, raw, ctx.cfg.policy.allowOutsideWorkspaceRead);
              if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
                screenshotFiles.push(resolved);
                screenshotRelative.push(toWorkspaceRelative(resolved, ctx));
              } else {
                captureErrors.push(`screenshot not found: ${raw}`);
              }
            }
          } else {
            const captured = await captureForCritique(args, ctx, preview);
            if ("error" in captured) return { ok: false, content: captured.error };
            screenshotFiles = captured.files;
            screenshotRelative = captured.relative;
            captureErrors = captured.errors;
          }

          if (screenshotFiles.length === 0) {
            return { ok: false, content: `design_critique: no screenshots to judge${captureErrors.length > 0 ? ` (${captureErrors.join("; ")})` : ""}` };
          }

          const siteDir = source.length > 0 ? (str(args, "dir", "").trim() || ctx.workspace) : (str(args, "dir", "").trim() ? resolveRead(ctx.workspace, str(args, "dir", ""), false) : ctx.workspace);
          const lint = source.length > 0
            ? lintSiteSource(source, { locale, direction })
            : await lintSiteDirectory(fs.existsSync(siteDir) ? siteDir : ctx.workspace, { locale, direction });

          const input: VisionCritiqueInput = {
            siteDir,
            fixtureId: "design_critique",
            prompt: str(args, "prompt"),
            locale,
            direction,
            lint,
            screenshots: screenshotFiles,
            brief: str(args, "brief") || undefined,
          };

          const threshold = num(args, "threshold", CRITIQUE_PASS_THRESHOLD);
          const round = Math.max(1, Math.round(num(args, "round", 1)));
          const maxRounds = Math.max(1, Math.round(num(args, "maxRounds", CRITIQUE_MAX_ROUNDS)));
          const payload = options.ollama
            ? await runVisionCritique(input, {
                cfg: ctx.cfg,
                ollama: options.ollama,
                signal: ctx.signal,
                threshold,
                maxAttempts: num(args, "maxAttempts", CRITIQUE_MAX_MODEL_ATTEMPTS),
              })
            : fallbackCritique(input, lint.score);

          // The fix loop needs an edit and a rebuild, which this read-only tool
          // must not do itself, so the caller drives it. The bound is still
          // enforced here: past the last round the tool refuses to keep asking
          // and tells the caller to report what it reached.
          const budgetExhausted = payload.verdict !== "accept" && round >= maxRounds;
          const loopNotes = budgetExhausted
            ? [`round budget exhausted (${round}/${maxRounds}): stop here and report the best score, the dimensions that stayed weak and what could not be fixed`]
            : payload.verdict === "accept"
              ? []
              : [`apply the first fix, rebuild, capture again and call design_critique with round=${round + 1} (of ${maxRounds})`];

          const report = formatCritiqueReport({
            ...payload,
            notes: [...payload.notes, ...loopNotes],
            round,
            maxRounds,
            lintScore: lint.score,
            screenshotCount: screenshotRelative.length,
            threshold,
          });
          const content = str(args, "format") === "json"
            ? JSON.stringify({ report, ...payload, round, maxRounds, budgetExhausted, lintScore: lint.score, screenshots: screenshotRelative })
            : report;
          return { ok: payload.verdict === "accept", content };
        } catch (error) {
          return { ok: false, content: `design_critique failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    },
  ];
}

/**
 * Deterministic rubric for the no-model path. It is derived from the lint
 * result and the RTL gate only, so it can never invent a visual defect it could
 * not measure; the report labels it `fallback` for that reason.
 */
function fallbackCritique(input: VisionCritiqueInput, lintScore: number): {
  ok: boolean;
  verdict: "accept" | "revise" | "invalid";
  score: number;
  dimensions: Array<{ id: string; label: string; score: number; note: string }>;
  issues: string[];
  fixes: string[];
  notes: string[];
  attempts: number;
  model: string;
  source: "model" | "fallback";
} {
  const rtl = input.direction === "rtl";
  const rtlReady = input.lint.metrics.rtlReady;
  const base = Math.min(100, lintScore);
  const dimensions = [
    { id: "hierarchy", label: "Visual hierarchy", score: base, note: "measured by the token linter only" },
    { id: "spacing", label: "Spacing rhythm", score: base, note: "measured by the token linter only" },
    { id: "contrast", label: "Text contrast", score: base, note: "measured by the token linter only" },
    { id: "alignment", label: "Alignment", score: base, note: "measured by the token linter only" },
    { id: "color-count", label: "Colour discipline", score: base, note: "measured by the token linter only" },
    { id: "overflow", label: "Overflow control", score: base, note: "measured by the token linter only" },
    { id: "rtl", label: "RTL correctness", score: rtl ? (rtlReady ? 100 : 40) : 100, note: rtl ? (rtlReady ? "dir=rtl and logical properties present" : "RTL layout is not ready") : "not applicable for this locale" },
  ];
  const score = Math.round(dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / dimensions.length);
  const issues: string[] = [];
  const fixes: string[] = [];
  if (lintScore < CRITIQUE_PASS_THRESHOLD) {
    issues.push(`token lint scored ${lintScore}/100, below the ${CRITIQUE_PASS_THRESHOLD} bar`);
    fixes.push("fix every design_lint violation, then capture the site again");
  }
  if (rtl && !rtlReady) {
    issues.push("the site is not RTL-ready for an Arabic locale");
    fixes.push("declare dir=\"rtl\" and lang=\"ar\" on the root and switch physical properties (ml/mr, pl/pr, left/right) to logical ones (ms/me, ps/pe, start/end)");
  }
  return {
    ok: true,
    verdict: lintScore >= CRITIQUE_PASS_THRESHOLD && (!rtl || rtlReady) ? "accept" : "revise",
    score,
    dimensions,
    issues,
    fixes,
    notes: ["the vision model was unavailable; this rubric is derived from the token linter and cannot judge the screenshots"],
    attempts: 0,
    model: "fallback",
    source: "fallback",
  };
}
