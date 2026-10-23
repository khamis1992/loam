/**
 * Quick-edit route (v0-parity gap G10).
 *
 * A narrow follow-up edit — a label rename, a wording fix, a line reorder, a
 * typo — is cheap to apply and does not need the frontier model. Sending every
 * edit down the same model and the same full-file path is slower and regresses
 * more of the surrounding code. This module decides, from the edit's *scope* or
 * from a short instruction, whether an edit is narrow enough to route to the
 * fast model, and turns a before/after pair into a minimal targeted diff.
 *
 * The classifier is deliberately conservative: when the evidence is ambiguous
 * it returns the base model. A wrong "quick" decision costs quality, while a
 * wrong "base" decision only costs a little speed.
 *
 * RTL/Arabic: narrow-edit instructions are recognised in both English and
 * Arabic, and `hasRtlScript` lets callers keep Arabic text in logical order when
 * they apply a patch. The targeted diff is line-based, so a `dir="rtl"` attribute
 * or an Arabic string literal is treated as ordinary text and never reordered
 * implicitly.
 */
import type { Config } from "../config.js";
import { diffLines } from "../tools/multiEdit.js";

export type EditRoute = "quick" | "base";

/** How large an edit may be before it is no longer "narrow". */
export const QUICK_EDIT_LIMITS = {
  maxChangedLines: 40,
  maxFiles: 3,
  /** Instructions longer than this are treated as larger tasks, not narrow edits. */
  maxInstructionChars: 240,
} as const;

/** The measurable shape of one proposed edit. */
export interface QuickEditScope {
  /** Workspace-relative files the edit touches. Empty when unknown. */
  files: readonly string[];
  /** Total changed lines (added + removed) across every file. */
  changedLines: number;
  /** Only literal/copy/text content changes; no code logic is touched. */
  textOnly: boolean;
  /** The edit only moves existing lines; the line multiset is unchanged. */
  reorderOnly: boolean;
  /** The edit adds/removes functions, imports, signatures or block boundaries. */
  structural: boolean;
  /** The edit changes behaviour (logic, algorithm or an API contract). */
  behavioural: boolean;
  /** The edit creates or deletes files. */
  fileBoundary: boolean;
}

export interface QuickEditDecision {
  route: EditRoute;
  /** Short, human-readable reason for the route (safe to log). */
  reason: string;
  /** Number of files the route must handle. */
  files: number;
  /** Changed lines observed for the decision. */
  changedLines: number;
}

/** The model to run plus an optional system-prompt suffix for the fast route. */
export interface QuickEditRoute {
  decision: QuickEditDecision;
  model: string;
  suffix: string;
}

/** One line-anchored, minimal replacement. */
export interface TargetedPatch {
  /** 1-based line in the original text where the patch starts. */
  start: number;
  /** Number of original lines the patch replaces (0 for a pure insertion). */
  count: number;
  /** Exact original text to find (may be empty for a pure insertion). */
  find: string;
  /** Replacement text (may be empty for a pure deletion). */
  replace: string;
}

export interface TargetedDiff {
  patches: TargetedPatch[];
  added: number;
  removed: number;
  /** True when the before/after line multiset is identical (a pure reorder). */
  reorderOnly: boolean;
  changedLines: number;
}

/** A minimal, targeted-edit instruction for the fast model (English + Arabic). */
const QUICK_EDIT_SUFFIX = [
  "Quick-edit route: this is a narrow change. Make the smallest possible targeted edit — change only the named text or lines and leave everything else byte-for-byte identical. Do not reformat unrelated code, reorder unrelated blocks, or rewrite the file.",
  "مسار التحرير السريع: هذا تعديل ضيّق. أجرِ أصغر تعديل هدف ممكن — غيّر النص أو الأسطر المسماة فقط واترك كل ما عداها كما هو حرفيًا. لا تعيد تنسيق كود غير ذي صلة، ولا تعيد ترتيب مقاطع غير ذات صلة، ولا تعيد كتابة الملف.",
].join("\n\n");

const NARROW_PATTERN =
  /\b(?:rename|replac(?:e|ement|ing)|swap|switch|reorder|rearrange|relocat\w*|mov\w*|retitle|reword|rephrase|typo|spelling|wording|relabel)\b|fix (?:the )?(?:typo|spelling|wording|label|text|title|copy)|change (?:the )?(?:text|label|title|wording|copy)|(?:delete|remove|insert) (?:this|the|a|an)? ?(?:line|row)/i;

const NARROW_PATTERN_AR =
  /(?:استبدل|بدّل|اعد تسمية|أعد تسمية|إعادة تسمية|انقل|نقل|أعد ترتيب|اعد ترتيب|إعادة ترتيب|اصحح|صحح|خطأ|غيّر النص|غير النص|تغيير النص|العنوان|ترجم|أعد صياغة|اعد صياغة|حذف هذه السطر|أضف سطر|ادرج سطر)/;

const BIG_PATTERN =
  /\b(?:add|create|build|implement|introduce|refactor|redesign|restructur\w*|migrat\w*|architect\w*|write)\b|new (?:page|route|component|feature|file|module|screen|endpoint)/i;

const BIG_PATTERN_AR = /(?:أضف|اضف|أنشئ|انشئ|بناء|نفّذ|نفذ|ميزة|صفحة جديدة|مسار جديد|مكوّن جديد|إعادة هيكلة|ترحيل)/;

/** True when the scope carries enough evidence to classify on its own. */
function hasScopeData(scope: Partial<QuickEditScope>): boolean {
  return (
    scope.textOnly === true ||
    scope.reorderOnly === true ||
    scope.structural === true ||
    scope.behavioural === true ||
    scope.fileBoundary === true ||
    (typeof scope.changedLines === "number" && scope.changedLines > 0) ||
    (Array.isArray(scope.files) && scope.files.length > 0)
  );
}

function normalizeScope(scope: Partial<QuickEditScope>): QuickEditScope {
  return {
    files: scope.files ?? [],
    changedLines: Number.isFinite(scope.changedLines) ? Math.max(0, scope.changedLines ?? 0) : 0,
    textOnly: scope.textOnly === true,
    reorderOnly: scope.reorderOnly === true,
    structural: scope.structural === true,
    behavioural: scope.behavioural === true,
    fileBoundary: scope.fileBoundary === true,
  };
}

function base(reason: string, files: number, changedLines: number): QuickEditDecision {
  return { route: "base", reason, files, changedLines };
}

function quick(reason: string, files: number, changedLines: number): QuickEditDecision {
  return { route: "quick", reason, files, changedLines };
}

/**
 * Decide whether an edit is narrow enough for the fast model.
 *
 * Safety order: any behavioural, structural or file-boundary change, or an edit
 * that is simply too large, goes to the base model. A pure reorder or a
 * text-only change is quick. Ambiguous scopes stay on the base model.
 */
export function classifyQuickEdit(scope: QuickEditScope): QuickEditDecision {
  const files = scope.files.length;
  const changedLines = Math.max(0, scope.changedLines);

  if (scope.behavioural) return base("behavioural change", files, changedLines);
  if (scope.structural) return base("structural change", files, changedLines);
  if (scope.fileBoundary) return base("creates or deletes files", files, changedLines);
  if (changedLines > QUICK_EDIT_LIMITS.maxChangedLines) return base("too many changed lines", files, changedLines);
  if (files > QUICK_EDIT_LIMITS.maxFiles) return base("too many files", files, changedLines);
  if (scope.reorderOnly) return quick("reorders existing content only", files, changedLines);
  if (scope.textOnly) return quick("text-only change", files, changedLines);
  return base("edit scope is ambiguous", files, changedLines);
}

/** Classify from a short instruction when no measured scope is available. */
function classifyInstruction(instruction: string): QuickEditDecision {
  const text = instruction.trim();
  if (text.length === 0) return base("empty instruction", 0, 0);
  if (text.length > QUICK_EDIT_LIMITS.maxInstructionChars) return base("instruction is not a narrow edit", 0, 0);
  if (BIG_PATTERN.test(text) || BIG_PATTERN_AR.test(text)) return base("looks like a larger change", 0, 0);
  if (NARROW_PATTERN.test(text) || NARROW_PATTERN_AR.test(text)) return quick("narrow edit request", 0, 0);
  return base("no quick-edit signal", 0, 0);
}

/**
 * Classify an edit from a measured scope, or from a short instruction when no
 * scope is supplied. Prefer the scope whenever it carries evidence: it is the
 * precise signal; the instruction text is only a fallback heuristic.
 */
export function classifyEditRequest(instruction: string, scope?: Partial<QuickEditScope>): QuickEditDecision {
  if (scope && hasScopeData(scope)) return classifyQuickEdit(normalizeScope(scope));
  return classifyInstruction(instruction);
}

/**
 * The concrete model for a decision. Quick edits use the configured fast model
 * (the existing fallback/lite tier); everything else uses the base model.
 */
export function resolveQuickEditModel(
  cfg: Pick<Config, "model" | "fallbackModel">,
  decision?: Pick<QuickEditDecision, "route">,
): string {
  const base = (cfg.model ?? "").trim();
  if (!decision || decision.route !== "quick") return base || "unknown";
  const fast = (cfg.fallbackModel ?? "").trim();
  return fast || base || "unknown";
}

/** Full route plan: the model to run plus the suffix the fast model should get. */
export function planQuickEditRoute(
  cfg: Pick<Config, "model" | "fallbackModel">,
  instruction: string,
  scope?: Partial<QuickEditScope>,
): QuickEditRoute {
  const decision = classifyEditRequest(instruction, scope);
  return {
    decision,
    model: resolveQuickEditModel(cfg, decision),
    suffix: decision.route === "quick" ? QUICK_EDIT_SUFFIX : "",
  };
}

/** True when `text` contains Arabic or another right-to-left script. */
export function hasRtlScript(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
}

function normalizeLines(text: string): string[] {
  return text.replace(/\r\n|\r/g, "\n").split("\n");
}

function lineMultiset(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of normalizeLines(text)) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** True when `before` and `after` contain exactly the same lines in a new order. */
export function isReorderOnly(before: string, after: string): boolean {
  const a = normalizeLines(before);
  const b = normalizeLines(after);
  if (a.length !== b.length) return false;
  if (a.join("\n") === b.join("\n")) return false;
  const counts = lineMultiset(before);
  for (const line of b) {
    const remaining = counts.get(line) ?? 0;
    if (remaining === 0) return false;
    counts.set(line, remaining - 1);
  }
  return true;
}

/** Byte offset where each 0-based line starts. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** Slice the text covering 0-based lines [from, to) including their newlines. */
function sliceLines(text: string, starts: number[], from: number, to: number): string {
  const start = starts[from] ?? text.length;
  const end = to < starts.length ? starts[to] : text.length;
  return text.slice(start, end);
}

interface HunkShape {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  added: number;
  removed: number;
}

/**
 * Convert one diff hunk into a line-anchored targeted patch. Line terminators
 * are included in `find`/`replace`, so a find/replace applier reproduces `after`
 * exactly instead of leaving stray blank lines behind.
 */
function hunkToPatch(
  textA: string,
  startsA: number[],
  textB: string,
  startsB: number[],
  hunk: HunkShape,
): TargetedPatch {
  if (hunk.removed > 0) {
    return {
      start: hunk.oldStart,
      count: hunk.removed,
      find: sliceLines(textA, startsA, hunk.oldStart - 1, hunk.oldEnd),
      // A pure deletion reports the insertion point as newStart==newEnd, so the
      // replacement is empty; a true replacement slices the added lines.
      replace: hunk.added > 0 ? sliceLines(textB, startsB, hunk.newStart - 1, hunk.newEnd) : "",
    };
  }

  // Pure insertion: anchor on an existing line so `find` is non-empty and unique.
  if (hunk.oldStart <= 0) {
    // Insert before the first line.
    const find = sliceLines(textA, startsA, 0, 1);
    if (find === "") return { start: 1, count: 0, find: "", replace: textB };
    const insertedEnd = hunk.added < startsB.length ? startsB[hunk.added] : textB.length;
    return { start: 1, count: 1, find, replace: `${textB.slice(0, insertedEnd)}${find}` };
  }
  let anchor = Math.min(hunk.oldStart - 1, startsA.length - 1);
  let find = sliceLines(textA, startsA, anchor, anchor + 1);
  // A trailing empty line (from a final newline) has no text of its own; anchor
  // on the previous real line instead so the patch is non-empty.
  if (find === "" && anchor > 0) {
    anchor -= 1;
    find = sliceLines(textA, startsA, anchor, anchor + 1);
  }
  if (find === "") return { start: anchor + 1, count: 0, find: "", replace: textB };
  const insertedStart = anchor + 1 < startsB.length ? startsB[anchor + 1] : textB.length;
  const insertedEnd = anchor + 1 + hunk.added < startsB.length ? startsB[anchor + 1 + hunk.added] : textB.length;
  return { start: anchor + 1, count: 1, find, replace: `${find}${textB.slice(insertedStart, insertedEnd)}` };
}

/**
 * Turn a before/after pair into the smallest set of line-anchored patches.
 * Narrow edits stay targeted: only the changed lines appear in each patch, so
 * applying the patches cannot disturb the rest of the file.
 */
export function planTargetedDiff(before: string, after: string): TargetedDiff {
  const textA = before.replace(/\r\n|\r/g, "\n");
  const textB = after.replace(/\r\n|\r/g, "\n");
  const a = textA.split("\n");
  const b = textB.split("\n");
  const diff = diffLines(a, b);
  const startsA = lineStarts(textA);
  const startsB = lineStarts(textB);
  const patches = diff.hunks.map((hunk) => hunkToPatch(textA, startsA, textB, startsB, hunk));
  return {
    patches,
    added: diff.added,
    removed: diff.removed,
    reorderOnly: isReorderOnly(before, after),
    changedLines: diff.added + diff.removed,
  };
}
