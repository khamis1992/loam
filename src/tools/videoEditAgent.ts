/**
 * Agentic text-driven video edit (V2, frontier gap).
 *
 * NOTICE: the edit-decision-list (EDL) driven timeline-editing design was
 * referenced from Rakazo (Apache-2.0) via the ArtCraft gap analysis. This is
 * an original clean-room TypeScript implementation; no ArtCraft brand,
 * assets, or code are used.
 *
 * Turns a natural-language instruction into an ordered EDL over a source
 * video: trim / split / delete / reorder / overlay-text, all timestamps in
 * seconds relative to the SOURCE (they never shift when earlier ops remove
 * material; segment indices for reorder reference the ranges that survive
 * all preceding ops). The same VideoEdl shape is consumed by the workspace
 * video panel (editing UI) and the separate workspace video render endpoint
 * (rendering happens there, never in this tool).
 *
 * Semantics the consumers must implement identically:
 *  - trim [from,to]: keep only the intersection of each surviving segment
 *    with [from,to]; segments fully outside are removed.
 *  - split atSec: cut every segment containing atSec into two.
 *  - delete [from,to]: subtract the range from every surviving segment.
 *  - reorder order: 1-based indices into the current segment list (after all
 *    preceding ops); must be a permutation of every segment; applied as-is.
 *  - overlay-text: draw `text` starting at atSec for durationSec (open-ended
 *    when omitted) at position top|center|bottom (default center).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ROOT } from "../config.js";
import { taskPath } from "../server/taskWorkspace.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";

// ---------------------------------------------------------------------------
// EDL data shape (shared contract with the UI video editor and render endpoint)
// ---------------------------------------------------------------------------

export interface TrimOp { id: string; op: "trim"; fromSec: number; toSec: number }
export interface SplitOp { id: string; op: "split"; atSec: number }
export interface DeleteOp { id: string; op: "delete"; fromSec: number; toSec: number }
export interface ReorderOp { id: string; op: "reorder"; order: number[] }
export interface OverlayTextOp {
  id: string;
  op: "overlay-text";
  text: string;
  atSec: number;
  durationSec?: number;
  position?: "top" | "center" | "bottom";
}
export type EdlOp = TrimOp | SplitOp | DeleteOp | ReorderOp | OverlayTextOp;

export interface VideoEdl {
  version: 1;
  source: { path: string; durationSec?: number };
  ops: EdlOp[];
  warnings: string[];
  summary?: { outputDurationSec: number; segmentCount: number };
  createdAt: string;
}

// ---------------------------------------------------------------------------
// TimelineService interface — the dependency this agent tool drives.
// The workspace video panel and render endpoint expose the same operations
// over HTTP; tests substitute an in-memory mock.
// ---------------------------------------------------------------------------

export interface VideoSourceInfo {
  /** Resolved source path (as given to the service). */
  path: string;
  /** Duration in seconds; undefined when the source could not be probed. */
  durationSec?: number;
}

export interface TimelineService {
  /** Verify the source exists and probe its duration (undefined when unknown). */
  inspectSource(taskId: string, workspace: string, sourcePath: string): Promise<VideoSourceInfo>;
  /** Most recently saved EDL for this task's workspace, or null. */
  loadLatestEdl(taskId: string, workspace: string): Promise<VideoEdl | null>;
  /** Persist an EDL; returns the workspace-relative file path written. */
  saveEdl(taskId: string, workspace: string, edl: VideoEdl): Promise<{ file: string }>;
}

// ---------------------------------------------------------------------------
// Segment projection (pure; consumers must mirror this to render/UI correctly)
// ---------------------------------------------------------------------------

export interface Segment { fromSec: number; toSec: number }

/** Apply trim/split/delete/reorder ops to a source of `durationSec`.
 *  overlay-text does not alter the segment list. Returns null when
 *  `durationSec` is unknown (segments cannot be projected). */
export function computeSegments(ops: EdlOp[], durationSec: number | undefined): Segment[] | null {
  if (durationSec === undefined || !Number.isFinite(durationSec) || durationSec <= 0) return null;
  let segs: Segment[] = [{ fromSec: 0, toSec: durationSec }];
  for (const op of ops) {
    if (op.op === "trim") {
      const next: Segment[] = [];
      for (const s of segs) {
        const from = Math.max(s.fromSec, op.fromSec);
        const to = Math.min(s.toSec, op.toSec);
        if (to - from > 1e-9) next.push({ fromSec: from, toSec: to });
      }
      segs = next;
    } else if (op.op === "split") {
      const next: Segment[] = [];
      for (const s of segs) {
        if (op.atSec > s.fromSec + 1e-9 && op.atSec < s.toSec - 1e-9) {
          next.push({ fromSec: s.fromSec, toSec: op.atSec }, { fromSec: op.atSec, toSec: s.toSec });
        } else {
          next.push(s);
        }
      }
      segs = next;
    } else if (op.op === "delete") {
      const next: Segment[] = [];
      for (const s of segs) {
        if (op.toSec <= s.fromSec + 1e-9 || op.fromSec >= s.toSec - 1e-9) { next.push(s); continue; }
        if (op.fromSec > s.fromSec + 1e-9) next.push({ fromSec: s.fromSec, toSec: op.fromSec });
        if (op.toSec < s.toSec - 1e-9) next.push({ fromSec: op.toSec, toSec: s.toSec });
      }
      segs = next;
    } else if (op.op === "reorder") {
      if (isPermutationOf(op.order, segs.length)) segs = op.order.map((i) => segs[i - 1]!);
    }
  }
  return segs;
}

function isPermutationOf(order: number[], n: number): boolean {
  if (order.length !== n) return false;
  const seen = new Set<number>();
  for (const i of order) {
    if (!Number.isInteger(i) || i < 1 || i > n || seen.has(i)) return false;
    seen.add(i);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Instruction → EDL compiler (pure, deterministic, no LLM)
// ---------------------------------------------------------------------------

export interface CompileInput {
  instruction: string;
  sourcePath: string;
  durationSec?: number;
  /** Ops from a previously saved EDL over the same source; new ops append. */
  previous?: VideoEdl | null;
}

const RESET_RE = /\b(reset|start over|from scratch|discard (?:the )?previous|clear (?:the )?(?:edl|edit list))\b/i;

/** Parse one timestamp token: `90`, `90s`, `1:30`, `1:02:03`, `2 min`, `1.5 sec`. */
export function parseTimeToken(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  const clock = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.\d+)?$/.exec(s);
  if (clock) {
    const h = clock[3] === undefined ? 0 : Number(clock[1]);
    const m = clock[3] === undefined ? Number(clock[1]) : Number(clock[2]);
    const sec = clock[3] === undefined ? Number(clock[2]) : Number(clock[3]);
    if (m > 59 || sec >= 60) return null;
    return h * 3600 + m * 60 + sec;
  }
  const numUnit = /^(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|min|mins|minutes?|s|sec|secs|second|seconds)?$/.exec(s);
  if (!numUnit) return null;
  const value = Number(numUnit[1]);
  const unit = numUnit[2];
  if (!Number.isFinite(value)) return null;
  if (unit && /^h/.test(unit)) return value * 3600;
  if (unit && /^m/.test(unit)) return value * 60;
  return value;
}

interface RangeResult { fromSec: number; toSec: number }

/** Extract a [from,to] range from a clause; undefined points fall back to
 *  open-ended (from X to end / 0 to X) or null when no range is present. */
function extractRange(clause: string, durationSec: number | undefined, warnings: string[]): RangeResult | null {
  const lc = clause.toLowerCase();
  const timeRe = String.raw`(\d{1,2}:\d{2}(?::\d{2})?|\d+(?:\.\d+)?(?:\s*(?:h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?))?`;
  const dash = "(?:-|–|—|~|to|until|till|through)";
  let m = new RegExp(String.raw`(?:from|between)\s+${timeRe}\s+(?:${dash}|and)\s+${timeRe}(?![\w:])`).exec(lc);
  if (m) return rangeFrom(parseTimeToken(m[1]!), parseTimeToken(m[2]!), warnings);
  m = new RegExp(String.raw`${timeRe}\s+(?:${dash})\s+${timeRe}(?![\w:])`).exec(lc);
  if (m) return rangeFrom(parseTimeToken(m[1]!), parseTimeToken(m[2]!), warnings);
  m = new RegExp(String.raw`${timeRe}\s*[-–—~]\s*${timeRe}(?![\w:])`).exec(lc);
  if (m) return rangeFrom(parseTimeToken(m[1]!), parseTimeToken(m[2]!), warnings);
  m = /(?:from|starting(?:\s+at)?|after)\s+([\d:.,\s\w]+?)(?:\s+(?:to|until|till|through)\s+the\s+end|\s+(?:onwards?|forward)|\s+to\s+end|\bend(?:ing)?\b|$)/.exec(lc);
  if (m && /(?:to|until|till|through)\s+the\s+end|onwards?|forward|to\s+end|\bend(?:ing)?\b/.test(m[0]!)) {
    const from = parseTimeToken(m[1]!.trim());
    if (from !== null && durationSec !== undefined) return { fromSec: clamp(from, durationSec, warnings), toSec: durationSec };
    if (from !== null) { warnings.push(`"${m[0].trim()}" needs a known video duration; skipped`); return null; }
  }
  m = new RegExp(String.raw`\b(?:first|opening)\s+${timeRe}(?![\w:])`).exec(lc);
  if (m && durationSec !== undefined) {
    const len = parseTimeToken(m[1]!);
    if (len !== null) return { fromSec: 0, toSec: clamp(len, durationSec, warnings) };
  }
  m = new RegExp(String.raw`\b(?:last|final|closing|ending)\s+${timeRe}(?![\w:])`).exec(lc);
  if (m && durationSec !== undefined) {
    const len = parseTimeToken(m[1]!);
    if (len !== null) return { fromSec: clamp(durationSec - len, durationSec, warnings), toSec: durationSec };
  }
  if (/\bfirst\s+\d|\blast\s+\d/.test(lc) && durationSec === undefined) {
    warnings.push(`"${clause.trim()}" needs a known video duration; skipped`);
  }
  return null;
}

function rangeFrom(from: number | null, to: number | null, warnings: string[]): RangeResult | null {
  if (from === null || to === null) return null;
  if (from >= to) { warnings.push(`ignored inverted range ${from}-${to}`); return null; }
  return { fromSec: from, toSec: to };
}

function clamp(t: number, durationSec: number, warnings: string[]): number {
  if (t < 0) { warnings.push(`negative timestamp -${t}s clamped to 0`); return 0; }
  if (t > durationSec) { warnings.push(`timestamp ${t}s beyond video end (${durationSec}s), clamped`); return durationSec; }
  return t;
}

/** "move segment 2 to position 1" → explicit reorder order [2,3,...,1,...]. */
function moveOrder(text: string, segmentCount: number): number[] | null {
  const m = /move\s+(?:segment|clip|part|piece)\s+(\d+)\s+(?:to|into)\s+(?:position|slot|#)?\s*(\d+)/i.exec(text);
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (segmentCount <= 0) return null;
  if (from < 1 || from > segmentCount || to < 1 || to > segmentCount) return null;
  const order = Array.from({ length: segmentCount }, (_, i) => i + 1);
  const [item] = order.splice(from - 1, 1);
  order.splice(to - 1, 0, item!);
  return order;
}

/** Split an instruction into op-sized clauses; clauses with no verb inherit
 *  the previous verb ("delete from 5 to 7 and from 10 to 12"). */
function splitClauses(instruction: string): string[] {
  const normalized = instruction
    .replace(/\s+(?:and\s+)?then\s+/gi, " ; ")
    .replace(/(\d)\s*,\s*(?=(?:and\s+)?\d)/g, "$1 $2") // keep "3, 1, 2" reorder lists in one clause
    .replace(/[.!?]+\s+/g, "; ")
    .replace(/\s*[.!?]+$/g, "");
  const out: string[] = [];
  for (const sentence of normalized.split(/[;\n]+/)) {
    for (const part of sentence.split(/,\s+(?:and\s+)?/i)) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

const VERB_KINDS = [
  { kind: "overlay" as const, re: /\b(text|caption|subtitle|title|watermark|overlay)\b|add\s+text/i },
  { kind: "reorder" as const, re: /\breorder\b|\brearrange\b|\bmove\s+(?:segment|clip|part|piece)\b/i },
  { kind: "split" as const, re: /\bsplit\b|\bcut\s+(?:it\s+)?at\b/i },
  { kind: "trim" as const, re: /\b(trim|crop|keep)\b/i },
  { kind: "delete" as const, re: /\b(delete|remove|drop|strip|cut)\b/i },
];

type VerbKind = "overlay" | "reorder" | "split" | "trim" | "delete";

function detectVerb(clause: string): VerbKind | null {
  for (const v of VERB_KINDS) if (v.re.test(clause)) return v.kind;
  return null;
}

const TEXT_QUOTE_RE = /["'“”‘’«](.+?)["'“”‘’»]/;
const TEXT_PLAIN_RE = /\b(?:text|caption|title|label)\s+(?:of\s+)?(?:is\s+)?([^,;]+?)(?=\s+(?:at|from|for|on|in|with|using)\b|$)/i;

function extractOverlayText(clause: string): string | null {
  const q = TEXT_QUOTE_RE.exec(clause);
  if (q) return q[1]!.trim();
  const p = TEXT_PLAIN_RE.exec(clause);
  if (p && p[1]!.trim()) return p[1]!.trim();
  return null;
}

function extractPosition(clause: string): "top" | "center" | "bottom" | undefined {
  const lc = clause.toLowerCase();
  if (/\b(top|upper)\b/.test(lc)) return "top";
  if (/\b(bottom|lower)\b/.test(lc)) return "bottom";
  if (/\b(middle|center)\b/.test(lc)) return "center";
  return undefined;
}

function extractDurationSec(clause: string): number | null {
  const timeRe = String.raw`(\d{1,2}:\d{2}(?::\d{2})?|\d+(?:\.\d+)?(?:\s*(?:h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?))?`;
  const m = new RegExp(String.raw`\bfor\s+${timeRe}(?![\w:])`).exec(clause.toLowerCase());
  return m ? parseTimeToken(m[1]!) : null;
}

function extractAtSec(clause: string, durationSec: number | undefined, warnings: string[]): number | null {
  const m = /\bat\s+(\d{1,2}:\d{2}(?::\d{2})?|\d+(?:\.\d+)?(?:\s*(?:h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?))?)/i.exec(clause);
  if (m) {
    const t = parseTimeToken(m[1]!);
    if (t !== null) return durationSec === undefined ? t : clamp(t, durationSec, warnings);
  }
  const from = /\bfrom\s+(\d{1,2}:\d{2}(?::\d{2})?|\d+(?:\.\d+)?(?:\s*(?:s(?:ec(?:ond)?s?)?)?))\b/i.exec(clause);
  if (from) {
    const t = parseTimeToken(from[1]!);
    if (t !== null) return durationSec === undefined ? t : clamp(t, durationSec, warnings);
  }
  return null;
}

/** Compile a natural-language instruction into a validated EDL. Pure: no fs,
 *  no network — inject `durationSec` from a TimelineService and test with mocks. */
export function compileEdl(input: CompileInput): VideoEdl {
  const warnings: string[] = [];
  const instruction = input.instruction ?? "";
  const durationSec = input.durationSec;
  let previous = input.previous ?? null;
  if (previous && RESET_RE.test(instruction)) {
    warnings.push("previous EDL discarded (reset requested)");
    previous = null;
  } else if (previous && previous.source.path !== input.sourcePath) {
    warnings.push("previous EDL was for a different source; starting fresh");
    previous = null;
  }
  const ops: EdlOp[] = (previous?.ops ?? []).map((op) => ({ ...op }));
  let lastVerb: VerbKind | null = null;

  for (const clause of splitClauses(instruction)) {
    const detected = detectVerb(clause);
    const verb = detected ?? lastVerb;
    if (verb === null) { warnings.push(`could not interpret: "${clause}"`); continue; }
    if (detected) lastVerb = detected;

    if (verb === "overlay") {
      const text = extractOverlayText(clause);
      if (!text) { warnings.push(`overlay-text needs quoted or plain text: "${clause}"`); continue; }
      const atSec = extractAtSec(clause, durationSec, warnings);
      if (atSec === null) { warnings.push(`overlay-text needs a timestamp ("at Xs"): "${clause}"`); continue; }
      const durationMs = extractDurationSec(clause);
      const op: OverlayTextOp = { id: "", op: "overlay-text", text, atSec };
      if (durationMs !== null) op.durationSec = durationSec === undefined ? durationMs : Math.min(durationMs, Math.max(0, durationSec - atSec));
      const pos = extractPosition(clause);
      if (pos) op.position = pos;
      ops.push(op);
      continue;
    }

    if (verb === "reorder") {
      const segments = computeSegments(ops, durationSec);
      if (!segments) { warnings.push(`reorder needs a known video duration: "${clause}"`); continue; }
      let order: number[] | null = null;
      const move = moveOrder(clause, segments.length);
      if (move) {
        order = move;
      } else {
        const idx = Array.from(clause.toLowerCase().matchAll(/(?:segment|clip|position|#)?\s*(\d+)/g))
          .map((m) => Number(m[1]))
          .filter((n) => n >= 1 && n <= segments.length);
        if (idx.length > 0) order = isPermutationOf(idx, segments.length) ? idx : null;
      }
      if (!order) { warnings.push(`reorder needs a full permutation of ${segments.length} segment(s): "${clause}"`); continue; }
      ops.push({ id: "", op: "reorder", order });
      continue;
    }

    if (verb === "split") {
      const at = extractAtSec(clause, durationSec, warnings);
      if (at === null) { warnings.push(`split needs a timestamp ("split at Xs"): "${clause}"`); continue; }
      if (at <= 0 || (durationSec !== undefined && at >= durationSec)) { warnings.push(`split at ${at}s is outside the video: "${clause}"`); continue; }
      ops.push({ id: "", op: "split", atSec: at });
      continue;
    }

    // trim and delete consume a range.
    const range = extractRange(clause, durationSec, warnings);
    if (!range) { warnings.push(`${verb} needs a range ("from X to Y", "X-Y", "first N seconds"): "${clause}"`); continue; }
    const fromSec = durationSec === undefined ? range.fromSec : clamp(range.fromSec, durationSec, warnings);
    const toSec = durationSec === undefined ? range.toSec : clamp(range.toSec, durationSec, warnings);
    if (toSec - fromSec <= 1e-9) { warnings.push(`${verb} range ${fromSec}-${toSec}s is empty: "${clause}"`); continue; }
    if (verb === "trim") ops.push({ id: "", op: "trim", fromSec, toSec });
    else ops.push({ id: "", op: "delete", fromSec, toSec });
  }

  ops.forEach((op, i) => { op.id = `op${i + 1}`; });
  const edl: VideoEdl = {
    version: 1,
    source: { path: input.sourcePath, ...(durationSec !== undefined ? { durationSec } : {}) },
    ops,
    warnings,
    createdAt: new Date().toISOString(),
  };
  const segments = computeSegments(ops, durationSec);
  if (segments && durationSec !== undefined) {
    edl.summary = {
      outputDurationSec: Math.round(segments.reduce((s, seg) => s + (seg.toSec - seg.fromSec), 0) * 1000) / 1000,
      segmentCount: segments.length,
    };
  }
  return edl;
}

// ---------------------------------------------------------------------------
// Default TimelineService: task workspace files + optional ffmpeg probe
// ---------------------------------------------------------------------------

const EDL_LATEST = "uploads/loam-video-edl-latest.json";

function ffmpegExecutable(): string {
  return path.join(ROOT, "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
}

/** Best-effort duration probe via `ffmpeg -i` stderr; undefined on any failure. */
function probeDuration(file: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const exe = ffmpegExecutable();
    if (!fs.existsSync(exe)) { resolve(undefined); return; }
    const child = spawn(exe, ["-hide_banner", "-i", file], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const done = (v: number | undefined) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => { child.kill(); done(undefined); }, 30000);
    child.stderr?.on("data", (d) => { stderr = (stderr + String(d)).slice(-12000); });
    child.once("error", () => { clearTimeout(timer); done(undefined); });
    child.once("exit", () => {
      clearTimeout(timer);
      const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      done(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined);
    });
  });
}

function atomicWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 1));
  fs.renameSync(temp, file);
}

function looksLikeEdl(v: unknown): v is VideoEdl {
  const e = v as VideoEdl | undefined;
  return !!e && e.version === 1 && Array.isArray(e.ops) && !!e.source && typeof e.source.path === "string";
}

export function createWorkspaceTimelineService(): TimelineService {
  return {
    async inspectSource(_taskId, workspace, sourcePath) {
      const file = taskPath(workspace, sourcePath);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new Error(`source video not found in the task workspace: ${sourcePath}`);
      }
      const durationSec = await probeDuration(file);
      return { path: sourcePath, ...(durationSec !== undefined ? { durationSec } : {}) };
    },
    async loadLatestEdl(_taskId, workspace) {
      try {
        const raw = JSON.parse(fs.readFileSync(taskPath(workspace, EDL_LATEST), "utf8")) as unknown;
        return looksLikeEdl(raw) ? raw : null;
      } catch {
        return null;
      }
    },
    async saveEdl(_taskId, workspace, edl) {
      const rel = `uploads/loam-video-edl-${Date.now()}-${randomUUID()}.json`;
      atomicWrite(taskPath(workspace, rel), edl);
      atomicWrite(taskPath(workspace, EDL_LATEST), edl);
      return { file: rel };
    },
  };
}

const defaultTimelineService = createWorkspaceTimelineService();

// ---------------------------------------------------------------------------
// Agent tool
// ---------------------------------------------------------------------------

export interface VideoEditToolOptions {
  timeline?: TimelineService;
}

export function createVideoEditTools(options: VideoEditToolOptions = {}): Tool[] {
  const timeline = options.timeline ?? defaultTimelineService;
  return [
    {
      name: "video_edit",
      description:
        "Apply a natural-language editing instruction to a source video in the task workspace and return the resulting edit-decision-list (EDL) as JSON: ordered ops (trim, split, delete, reorder, overlay-text) with source-relative timestamps in seconds. The EDL is saved into the task workspace for the workspace video panel (editing) and the video render endpoint (rendering); this tool never renders. Successive instructions on the same source append to the saved EDL; say 'reset' to start a new one. Example instruction: 'trim from 10s to 50s, delete 20-25, split at 0:35, move segment 2 to position 1, add text \"Loam\" at 3s for 4s at the bottom'.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task id (defaults to the current run task)" },
          path: { type: "string", description: "Source video path relative to the task workspace (e.g. assets/video.mp4)" },
          instruction: { type: "string", description: "Natural-language edit instruction; clauses separated by commas, 'and', 'then' or '.'" },
        },
        required: ["path", "instruction"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const taskId = str(args, "taskId", ctx.taskId ?? "");
        const sourcePath = str(args, "path").trim();
        const instruction = str(args, "instruction").trim();
        if (!sourcePath) return { ok: false, content: "video_edit requires path (source video in the task workspace)" };
        if (!instruction) return { ok: false, content: "video_edit requires a non-empty instruction" };
        try {
          const info = await timeline.inspectSource(taskId, ctx.workspace, sourcePath);
          const previous = await timeline.loadLatestEdl(taskId, ctx.workspace);
          const edl = compileEdl({ instruction, sourcePath, durationSec: info.durationSec, previous });
          const saved = await timeline.saveEdl(taskId, ctx.workspace, edl);
          const warn = edl.warnings.length > 0 ? ` warnings: ${edl.warnings.join(" | ")}` : "";
          return {
            ok: true,
            content: JSON.stringify({ savedTo: saved.file, edl, note: `${edl.ops.length} op(s) total; render via the workspace video render endpoint; editable in the workspace video panel.${warn}` }),
          };
        } catch (err) {
          return { ok: false, content: `video_edit failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  ];
}

export const VIDEO_EDIT_TOOL_NAMES = ["video_edit"];
