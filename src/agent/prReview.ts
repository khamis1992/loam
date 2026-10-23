/**
 * PR review (D15): turn a pull request's diff into review findings.
 *
 * `pr_review` fetches the changed files through the D1 `PrProvider`, hands each
 * file's unified diff (plus the repo conventions it must honour) to the model,
 * and returns deduplicated findings `{severity, file, line, explanation,
 * suggested_fix}`.
 *
 * Three things here are deliberately deterministic rather than model-authored,
 * so the tool never has to trust the model for arithmetic or bookkeeping:
 *  - the diff hunk headers are parsed here, so `line` is a real new-file line
 *    number and a finding can be clamped into the range it was found in;
 *  - findings are validated and deduplicated here, so a model that repeats
 *    itself (or two files that report the same line) cannot produce noise;
 *  - the per-file prompt is built here, so the conventions actually reach the
 *    model instead of being an implicit hope.
 *
 * No network is used in tests: the model client and the provider are injected,
 * and `LocalPrProvider` serves a scripted diff.
 */
import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "../ollama.js";
import type { PrDiff, PrFileDiff, PrProvider } from "../tools/gitPrProvider.js";

/** Finding severities, most to least severe. */
export type PrReviewSeverity = "bug" | "flag" | "nit";

/** Order used when sorting findings for output and deduplication. */
export const SEVERITY_ORDER: readonly PrReviewSeverity[] = ["bug", "flag", "nit"];

/** One review finding, as `pr_review` returns it. */
export interface PrReviewFinding {
  severity: PrReviewSeverity;
  file: string;
  line: number;
  explanation: string;
  suggested_fix: string;
}

/** A model finding before its file/line have been validated. */
export interface RawFinding {
  severity: unknown;
  file?: unknown;
  line?: unknown;
  explanation?: unknown;
  suggested_fix?: unknown;
}

/** Budget for the conventions block: keeps a huge AGENTS.md out of every prompt. */
export const MAX_CONVENTIONS_CHARS = 12_000;
/** Budget for one file's diff when it is sent to the model. */
export const MAX_FILE_DIFF_CHARS = 20_000;
/** Hard cap on findings kept from one review, whatever the model returns. */
export const MAX_FINDINGS = 60;

/** The model surface the reviewer needs; tests inject a fake. */
export interface PrReviewModelClient {
  chat(opts: { model: string; messages: ChatMessage[]; temperature?: number; format?: Record<string, unknown> }): Promise<{ content: string }>;
}

/** Files whose changes are mechanical and carry no convention signal to review. */
const SKIPPED_FILE = /(^|\/)(\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|poetry\.lock|Cargo\.lock|uv\.lock)$/i;
/** Vendor/build output that is never worth a model round trip. */
const SKIPPED_PATH = /(^|\\|\/)(node_modules|dist|build|out|coverage|\.next|\.git|vendor|__pycache__|\.venv|target)(\\|\/|$)/i;
/** Conventions the reviewer asks the model to check the diff against. */
const CONVENTION_FILES = ["AGENTS.md", "CONTRIBUTING.md", "AGENTS.local.md", "CLAUDE.md"] as const;

// ---------------------------------------------------------------------------
// Unified-diff parsing
// ---------------------------------------------------------------------------

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * A parsed hunk: where it starts in the new file and which new-file line
 * numbers it touches.
 */
export interface DiffHunk {
  newStart: number;
  newCount: number;
  /** New-file line numbers this hunk touches, in order. */
  lines: number[];
}

/**
 * Parse one file's unified diff into its hunks.
 *
 * Only `@@` hunk headers matter here: added and context lines advance the
 * new-file counter, removed lines do not. A hunk with no header (for example
 * GitHub's `\ No newline at end of file` marker on its own) is skipped rather
 * than throwing, because the provider may hand back a partial patch.
 */
export function parseHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let cursor = 0;
  let current: DiffHunk | null = null;

  for (const raw of diff.split(/\r?\n/)) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      const newStart = Number(header[3]);
      const newCount = header[4] === undefined ? 1 : Number(header[4]);
      current = { newStart, newCount, lines: [] };
      hunks.push(current);
      cursor = newStart;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      current.lines.push(cursor);
      cursor += 1;
    } else if (raw.startsWith("-")) {
      // Removed lines belong to the old file: they advance no new-file number.
      continue;
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file" annotates the line above it.
      continue;
    } else if (raw.trim() === "") {
      // A blank line inside a hunk is a context line whose leading space was
      // trimmed by some diff producers; treat it as context.
      current.lines.push(cursor);
      cursor += 1;
    } else {
      // Any other text ends the hunk (diffstat, next file header, prose).
      current = null;
    }
  }

  return hunks;
}

/** The new-file line numbers a file's diff touches, plus its largest line. */
export function reviewRanges(file: PrFileDiff): { changed: Set<number>; maxLine: number } {
  const changed = new Set<number>();
  let maxLine = 0;
  for (const hunk of parseHunks(file.diff)) {
    for (const line of hunk.lines) {
      changed.add(line);
      if (line > maxLine) maxLine = line;
    }
    if (hunk.newStart + Math.max(0, hunk.newCount - 1) > maxLine) {
      maxLine = hunk.newStart + Math.max(0, hunk.newCount - 1);
    }
  }
  return { changed, maxLine };
}

/** Whether a file is worth spending a model call on. */
export function isReviewable(file: PrFileDiff): boolean {
  if (file.path.trim() === "") return false;
  if (file.diff.trim() === "") return false;
  if (SKIPPED_FILE.test(file.path)) return false;
  if (SKIPPED_PATH.test(file.path)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Conventions
// ---------------------------------------------------------------------------

/** The conventions block the reviewer puts in front of every file prompt. */
export interface RepoConventions {
  text: string;
  files: string[];
}

function readConventionFile(dir: string, name: string): { text: string; file: string } | null {
  const file = path.join(dir, name);
  try {
    if (!fs.statSync(file).isFile()) return null;
    let raw = fs.readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const text = raw.trim();
    return text ? { text, file } : null;
  } catch {
    return null;
  }
}

/**
 * Load the repo conventions a review must check the diff against.
 *
 * `AGENTS.md` and `CONTRIBUTING.md` are the primary sources; `CLAUDE.md` and
 * `AGENTS.local.md` are accepted for compatibility. A missing file is not an
 * error: the review still runs, it simply has no conventions to check.
 */
export function loadRepoConventions(
  workspace: string,
  names: readonly string[] = CONVENTION_FILES,
  maxChars = MAX_CONVENTIONS_CHARS,
): RepoConventions {
  const root = path.resolve(workspace);
  const chunks: string[] = [];
  const files: string[] = [];
  let size = 0;

  for (const name of names) {
    const found = readConventionFile(root, name);
    if (!found) continue;
    const section = `## ${name}\n${found.text}`;
    if (size + section.length > maxChars) {
      const room = Math.max(0, maxChars - size);
      if (room < 200) break;
      chunks.push(`## ${name}\n${found.text.slice(0, room)}\n[...conventions truncated]`);
      files.push(found.file);
      size += room;
      break;
    }
    chunks.push(section);
    files.push(found.file);
    size += section.length;
  }

  return { text: chunks.join("\n\n"), files };
}

// ---------------------------------------------------------------------------
// Prompts and model output
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are a meticulous code reviewer for this repository.",
  "You are given a unified diff for ONE changed file plus the repository conventions it must honour.",
  "Report only real defects and convention violations that are visible in this diff: correctness bugs (off-by-one, wrong condition, null/undefined handling, resource leaks, unhandled errors), then style/consistency violations of the conventions, then nits.",
  "Do not report the same problem twice, do not invent line numbers that the diff does not contain, and do not suggest speculative refactors.",
  "Reply with ONLY a JSON object of the form:",
  '{"findings":[{"severity":"bug|flag|nit","line":<new-file line number>,"explanation":"what is wrong and why","suggested_fix":"the concrete change, or an empty string when nothing to suggest"}]}',
  "Use the file you were given; never include a file name in the JSON.",
  "If the diff is clean, reply with exactly {\"findings\":[]}.",
].join("\n");

/** The numbered, annotated diff the model sees for one file. */
export function renderFilePrompt(file: PrFileDiff): string {
  const changed = reviewRanges(file);
  const kept: string[] = [];
  let cursor = 0;
  let current: DiffHunk | null = null;

  for (const raw of file.diff.split(/\r?\n/)) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      current = { newStart: Number(header[3]), newCount: 0, lines: [] };
      kept.push(raw);
      cursor = Number(header[3]);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+")) {
      kept.push(`${cursor} + ${raw.slice(1)}`);
      current.lines.push(cursor);
      cursor += 1;
    } else if (raw.startsWith("-")) {
      kept.push(`  - ${raw.slice(1)}`);
    } else if (raw.startsWith("\\")) {
      kept.push(raw);
    } else if (raw.startsWith(" ")) {
      kept.push(`${cursor}   ${raw.slice(1)}`);
      cursor += 1;
    } else if (raw.trim() === "") {
      kept.push(`${cursor}   `);
      cursor += 1;
    } else {
      kept.push(raw);
      current = null;
    }
  }

  const body = kept.join("\n");
  const trimmed = body.length > MAX_FILE_DIFF_CHARS ? `${body.slice(0, MAX_FILE_DIFF_CHARS)}\n[...diff truncated]` : body;
  const range = changed.maxLine > 0 ? ` (new-file lines 1-${changed.maxLine})` : "";
  return `File: ${file.path}${range}\n\n${trimmed}`;
}

/** Build the two messages one file review is sent as. */
export function buildReviewMessages(file: PrFileDiff, conventions: string): ChatMessage[] {
  const conv = conventions.trim();
  const user = conv
    ? `${conv}\n\n---\n\n${renderFilePrompt(file)}`
    : renderFilePrompt(file);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

/** Extract the first JSON object from a model reply, tolerating code fences. */
export function parseFindings(raw: string): RawFinding[] {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return [];
  return findings.filter((f): f is RawFinding => !!f && typeof f === "object" && !Array.isArray(f));
}

// ---------------------------------------------------------------------------
// Validation and deduplication
// ---------------------------------------------------------------------------

/**
 * Validate one raw finding against the file it was reported for.
 *
 * A finding is dropped when its file does not match, its severity is unknown,
 * or it has no explanation. Its line is clamped into the new-file range the
 * diff actually touched, so a model that guesses `1` or a line past the end
 * still lands on a line a reviewer can open.
 */
export function normalizeFinding(
  raw: RawFinding,
  file: PrFileDiff,
  ranges: { changed: Set<number>; maxLine: number },
): PrReviewFinding | null {
  const severity = String(raw.severity ?? "").trim().toLowerCase();
  if (severity !== "bug" && severity !== "flag" && severity !== "nit") return null;
  const reportedFile = typeof raw.file === "string" ? raw.file.trim() : "";
  if (reportedFile && reportedFile !== file.path) return null;

  const explanation = typeof raw.explanation === "string" ? raw.explanation.trim() : "";
  if (!explanation) return null;
  const suggested = typeof raw.suggested_fix === "string" ? raw.suggested_fix.trim() : "";

  const line = clampLine(raw.line, ranges);
  return { severity: severity as PrReviewSeverity, file: file.path, line, explanation, suggested_fix: suggested };
}

/** Clamp a reported line into the new-file range the diff touched. */
export function clampLine(value: unknown, ranges: { changed: Set<number>; maxLine: number }): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.trunc(value);
    if (n >= 1) return clampToRange(n, ranges);
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    const n = Math.trunc(Number(value));
    if (n >= 1) return clampToRange(n, ranges);
  }
  return firstChangedLine(ranges);
}

function clampToRange(n: number, ranges: { changed: Set<number>; maxLine: number }): number {
  const max = Math.max(1, ranges.maxLine);
  const bounded = Math.min(n, max);
  if (ranges.changed.has(bounded)) return bounded;
  // Prefer the nearest touched line, then the first one, so the finding still
  // points at something the diff contains.
  let best = firstChangedLine(ranges);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const line of ranges.changed) {
    const distance = Math.abs(line - bounded);
    if (distance < bestDistance) {
      best = line;
      bestDistance = distance;
    }
  }
  return best;
}

function firstChangedLine(ranges: { changed: Set<number> }): number {
  let best = 1;
  let first = true;
  for (const line of ranges.changed) {
    if (first || line < best) {
      best = line;
      first = false;
    }
  }
  return best;
}

export function findingKey(f: PrReviewFinding): string {
  return `${f.file}:${f.line}`;
}

/**
 * Merge duplicate findings.
 *
 * Two findings are the same issue when they point at the same file and line,
 * however the model worded them: the model repeats itself across files and
 * replies, so an exact-text key would let one issue through twice. The most
 * severe one wins, the fuller explanation is kept, and the losing explanation is
 * appended as an `also` note only when it says something new. Findings reported
 * on a different file are kept: they are different issues even at the same line.
 */
export function dedupeFindings(findings: PrReviewFinding[]): PrReviewFinding[] {
  const byKey = new Map<string, PrReviewFinding>();
  for (const finding of findings) {
    const key = findingKey(finding);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, finding);
      continue;
    }
    byKey.set(key, mergeFinding(existing, finding));
  }
  return [...byKey.values()];
}

function mergeFinding(a: PrReviewFinding, b: PrReviewFinding): PrReviewFinding {
  const rank = (s: PrReviewSeverity): number => SEVERITY_ORDER.indexOf(s);
  const winner = rank(b.severity) < rank(a.severity) ? b : a;
  const loser = winner === a ? b : a;
  // The fuller explanation carries more detail, whichever severity won.
  const fuller = winner.explanation.length >= loser.explanation.length ? winner.explanation : loser.explanation;
  const shorter = fuller === winner.explanation ? loser.explanation : winner.explanation;
  return {
    ...winner,
    explanation: explanationWithNote(fuller, shorter),
    suggested_fix: winner.suggested_fix || loser.suggested_fix,
  };
}

/** Keep a duplicate's explanation only when it says something new. */
export function explanationWithNote(keep: string, other: string): string {
  const a = keep.trim();
  const b = other.trim();
  if (!b || b.toLowerCase() === a.toLowerCase()) return a;
  if (a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase())) return a;
  return `${a} (also reported as: ${b})`;
}

/** Sort findings most severe first, then by file and line. */
export function sortFindings(findings: PrReviewFinding[]): PrReviewFinding[] {
  return [...findings].sort((a, b) => {
    const rank = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (rank !== 0) return rank;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
}

// ---------------------------------------------------------------------------
// The review itself
// ---------------------------------------------------------------------------

export interface PrReviewOptions {
  /** Conventions block; defaults to the workspace's AGENTS.md / CONTRIBUTING.md. */
  conventions?: string;
  /** Model id; "" uses the run's main model. */
  model?: string;
  /** Injectable model client (tests). Defaults to the Ollama client. */
  modelClient?: PrReviewModelClient;
  /** Injectable chat call (tests); wins over `modelClient`. */
  callModel?: (messages: ChatMessage[], model: string) => Promise<string>;
  /** Per-file timeout; a slow model fails that file, not the whole review. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Cap on model calls (files reviewed); defaults to the diff's file count. */
  maxFiles?: number;
}

export interface PrReviewResult {
  findings: PrReviewFinding[];
  /** Files whose review was attempted and produced no parseable findings. */
  reviewedFiles: string[];
  /** Files skipped without a model call (lockfiles, build output, no patch). */
  skippedFiles: string[];
  /** Per-file model failures, so the caller can report a partial review. */
  warnings: string[];
  /** Model calls made (one per reviewed file). */
  modelCalls: number;
}

/** Wrap one provider/model call so a slow call cannot stall the whole review. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Review one changed file against the conventions.
 *
 * Exported separately so a caller can review files itself (or in parallel) and
 * still use the same validation and dedup rules as the tool.
 */
export async function reviewFile(
  file: PrFileDiff,
  conventions: string,
  call: (messages: ChatMessage[], model: string) => Promise<string>,
  model: string,
): Promise<PrReviewFinding[]> {
  const raw = await call(buildReviewMessages(file, conventions), model);
  const ranges = reviewRanges(file);
  return dedupeFindings(parseFindings(raw).map((f) => normalizeFinding(f, file, ranges)).filter((f): f is PrReviewFinding => f !== null));
}

/**
 * Review a whole pull request diff.
 *
 * Each changed file is reviewed on its own so one long file cannot crowd out
 * the rest, and a file whose model call fails is reported as a warning instead
 * of failing the review. Findings are deduplicated across files at the end.
 */
export async function reviewPullRequest(
  provider: PrProvider,
  repo: string,
  number: number,
  options: PrReviewOptions = {},
): Promise<PrReviewResult> {
  const conventions = options.conventions ?? "";
  const model = options.model ?? "";
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
  const warnings: string[] = [];
  const reviewedFiles: string[] = [];
  const skippedFiles: string[] = [];
  const findings: PrReviewFinding[] = [];
  let modelCalls = 0;

  let diff: PrDiff;
  try {
    diff = await provider.prDiff(repo, number);
  } catch (error) {
    throw new Error(`pr_review could not fetch the diff for ${repo}#${number}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const reviewable: PrFileDiff[] = [];
  for (const file of diff.files) {
    if (isReviewable(file)) reviewable.push(file);
    else skippedFiles.push(file.path);
  }

  for (const file of reviewable.slice(0, Math.max(0, maxFiles))) {
    if (options.signal?.aborted) {
      warnings.push(`review aborted before ${file.path}`);
      break;
    }
    try {
      const fileFindings = await reviewFile(file, conventions, (messages, m) => {
        const call = async (): Promise<string> => {
          modelCalls += 1;
          if (options.callModel) return options.callModel(messages, m);
          if (options.modelClient) return (await options.modelClient.chat({ model: m, messages, temperature: 0 })).content;
          throw new Error("pr_review requires a model client");
        };
        return options.timeoutMs ? withTimeout(call(), options.timeoutMs, `review ${file.path}`) : call();
      }, model);
      reviewedFiles.push(file.path);
      findings.push(...fileFindings);
    } catch (error) {
      warnings.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    findings: sortFindings(dedupeFindings(findings)).slice(0, MAX_FINDINGS),
    reviewedFiles,
    skippedFiles,
    warnings,
    modelCalls,
  };
}

/** Render a review result as the model-facing tool content. */
export function formatReviewResult(
  result: PrReviewResult,
  meta: { repo: string; number: number; posted: number },
): string {
  if (result.findings.length === 0) {
    const parts = ["pr_review found no issues in the reviewed files."];
    if (result.skippedFiles.length > 0) parts.push(`skipped: ${result.skippedFiles.join(", ")}`);
    if (result.warnings.length > 0) parts.push(`warnings: ${result.warnings.join("; ")}`);
    return parts.join("\n");
  }
  const lines = result.findings.map((f) => {
    const fix = f.suggested_fix ? `\n  suggested fix: ${f.suggested_fix}` : "";
    const mark = meta.posted > 0 ? " (posted)" : "";
    return `- [${f.severity}]${mark} ${f.file}:${f.line} — ${f.explanation}${fix}`;
  });
  const parts = [`pr_review found ${result.findings.length} issue(s) in ${meta.repo}#${meta.number}:`, ...lines];
  if (result.skippedFiles.length > 0) parts.push(`skipped: ${result.skippedFiles.join(", ")}`);
  if (result.warnings.length > 0) parts.push(`warnings: ${result.warnings.join("; ")}`);
  return parts.join("\n");
}
