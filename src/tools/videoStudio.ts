/**
 * `video_studio` agent tool — drives the vendored "Loam Video" editor.
 *
 * The editor is a wasm app embedded in the Workspace panel (iframe at
 * `loamfilm://app/index.html`, typed bridge `packages/web/src/lib/filmcraft.ts`).
 * Agent tools run in the Node server, so every action is sent through the
 * fc-02 command relay (`src/server/videoStudioRelay.ts`):
 *
 *   video_studio(action, …) -> relay.enqueue() -> SSE `video_studio_command`
 *     -> the attached panel executes it with its bridge
 *     -> POST /api/tasks/:id/video-studio/result -> settle the promise
 *
 * Design rules:
 *  - The tool never guesses an engine command id. Every mutating action first
 *    asks the editor for its real catalog (`commands()`) and resolves its
 *    command id against {@link VIDEO_STUDIO_COMMAND_CANDIDATES} at runtime, so
 *    a FilmCraft build that renamed a command degrades to a clear "use raw"
 *    message instead of a silent no-op.
 *  - `raw` is the escape hatch: it executes any command id, but only after
 *    validating it against the live catalog and reporting close matches when
 *    the id is unknown.
 *  - Time arguments accept seconds (`90`) or timecode (`1:30`,
 *    `00:01:30.500`) via the shared `parseTimeToken` grammar.
 *  - When the FilmCraft dist is missing or the bridge fails, the tool returns
 *    a structured fallback pointing the agent at `video_edit` (the EDL +
 *    ffmpeg path that needs no editor). A command the editor itself refuses is
 *    reported with `reason: "command_rejected"` and the editor's own error, so
 *    a bad command is never confused with an unreachable editor.
 *
 * The mapping table and the fallback contract are documented in
 * docs/filmcraft-integration.md.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import { taskPath } from "../server/taskWorkspace.js";
import { videoStudioRelay } from "../server/videoStudioRelay.js";
import { parseTimeToken } from "./videoEditAgent.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";
import {
  VideoStudioProjectStore,
  VideoStudioStateTracker,
  videoStudioProjectStore,
  type VideoStudioStateSummary,
} from "./videoStudioState.js";

// ---------------------------------------------------------------------------
// Relay contract (structural, so tests can inject a mock)
// ---------------------------------------------------------------------------

export type VideoStudioTarget = "film" | "effects";

/** Bridge methods the relay can dispatch (mirrors FilmcraftMethod). */
export type VideoStudioMethod =
  | "execute"
  | "commands"
  | "inspect"
  | "info"
  | "screenshot"
  | "importFiles"
  | "importUrl"
  | "openProject"
  | "readFile"
  | "files";

/** One relay dispatch: a bridge method plus its single argument object. */
export interface VideoStudioStep {
  method: VideoStudioMethod;
  params: Record<string, unknown>;
}

/** Minimal relay surface the tool needs (the real VideoStudioRelay satisfies it). */
export interface VideoStudioRelayLike {
  enqueue(
    taskId: string,
    target: VideoStudioTarget,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Availability + fallback
// ---------------------------------------------------------------------------

/** Tool the agent should use when the Loam Video editor cannot be driven. */
export const VIDEO_STUDIO_FALLBACK_TOOL = "video_edit";

export type VideoStudioFallbackReason =
  | "filmcraft_dist_missing"
  | "panel_not_open"
  | "bridge_unavailable"
  | "command_rejected"
  | "cancelled";

/** Absolute path of the vendored editor entry point. */
export function filmcraftDistDir(root: string = ROOT): string {
  return path.join(root, "electron", "filmcraft", "dist");
}

/** True when the vendored Loam Video dist is installed (index.html present). */
export function isFilmcraftDistInstalled(root: string = ROOT): boolean {
  return fs.existsSync(path.join(filmcraftDistDir(root), "index.html"));
}

// ---------------------------------------------------------------------------
// Action catalog
// ---------------------------------------------------------------------------

export const VIDEO_STUDIO_ACTIONS = [
  "open",
  "state",
  "import",
  "cut",
  "trim",
  "delete",
  "move",
  "reorder",
  "split",
  "speed",
  "add_text",
  "add_audio",
  "music",
  "transition_basic",
  "effect_basic",
  "undo",
  "raw",
] as const;

export type VideoStudioAction = (typeof VIDEO_STUDIO_ACTIONS)[number];

export function isVideoStudioAction(value: unknown): value is VideoStudioAction {
  return typeof value === "string" && (VIDEO_STUDIO_ACTIONS as readonly string[]).includes(value);
}

/**
 * Command ids the tool may issue, most-likely-first. Resolved against the live
 * `commands()` catalog at runtime; the first candidate the editor actually
 * exposes wins. Kept in code (and tested) so the mapping is auditable.
 */
export const VIDEO_STUDIO_COMMAND_CANDIDATES = {
  newProject: ["file.newProject"],
  newSequence: ["file.newSequence"],
  razor: ["timeline.razor", "sequence.razor", "edit.razor"],
  trim: ["timeline.trim", "sequence.trim", "clip.trim"],
  delete: ["timeline.delete", "sequence.delete", "edit.delete"],
  split: ["timeline.split", "sequence.split", "edit.split"],
  move: ["sequence.move", "timeline.move", "edit.move"],
  reorder: ["sequence.reorder", "sequence.move", "timeline.reorder"],
  speed: ["clip.speed", "sequence.speed", "timeline.speed"],
  addText: ["graphics.addText", "sequence.addText", "text.add", "title.add"],
  addAudio: ["audio.add", "sequence.addAudio", "audio.import"],
  applyVideoTransition: ["sequence.applyVideoTransition", "transition.applyVideo"],
  applyAudioTransition: ["sequence.applyAudioTransition", "transition.applyAudio"],
  effectApply: ["effects.apply", "effect.apply"],
  effectSetParam: ["effects.setParam", "effect.setParam"],
  undo: ["edit.undo", "history.undo", "undo"],
  export: ["export"],
} as const;

// ---------------------------------------------------------------------------
// Time parsing (seconds or timecode)
// ---------------------------------------------------------------------------

/** Accept a number of seconds or a timecode string; null when unparseable. */
export function toSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return parseTimeToken(value.trim());
  return null;
}

/** Accept one time or an array of times; null when any entry is unparseable. */
export function toSecondsArray(value: unknown): number[] | null {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) return null;
  const out: number[] = [];
  for (const entry of values) {
    const seconds = toSeconds(entry);
    if (seconds === null) return null;
    out.push(seconds);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Command-id resolution + close matches
// ---------------------------------------------------------------------------

/** First candidate the catalog actually exposes, or null. */
export function resolveCommandId(catalog: readonly string[], candidates: readonly string[]): string | null {
  const available = new Set(catalog);
  for (const candidate of candidates) if (available.has(candidate)) return candidate;
  return null;
}

function normalizeId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const curr = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[n]!;
}

/** Catalog ids closest to `id`, best first (empty when nothing is close). */
export function closeMatches(catalog: readonly string[], id: string, limit = 5): string[] {
  const target = normalizeId(id);
  if (!target) return [];
  const maxLen = Math.max(target.length, 1);
  return catalog
    .map((candidate) => {
      const normalized = normalizeId(candidate);
      const distance = levenshtein(target, normalized);
      const score = normalized === target ? 1 : 1 - distance / Math.max(maxLen, normalized.length);
      return { candidate, score };
    })
    .filter((entry) => entry.score > 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/** Extract the command-id list from a `commands()` result (strings or {id}). */
export function toCommandIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
    else if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
      const id = (entry as { id: string }).id.trim();
      if (id) out.push(id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Action → relay steps
// ---------------------------------------------------------------------------

interface BuiltAction {
  steps: VideoStudioStep[];
}
interface BuildError {
  error: string;
}
type BuildResult = BuiltAction | BuildError;

/** Wrap one engine command as a relay `execute` step. */
function execStep(id: string, params: Record<string, unknown> = {}): VideoStudioStep {
  return { method: "execute", params: { command: id, params } };
}

function unknownCommandMessage(
  action: string,
  catalog: readonly string[],
  candidates: readonly string[],
): string {
  const matches = closeMatches(catalog, candidates[0] ?? action).slice(0, 5);
  const available = catalog.length > 0 ? catalog.slice(0, 40).join(", ") : "(editor returned no command list)";
  return (
    `video_studio action "${action}" needs an editor command this Loam Video build does not expose ` +
    `(looked for: ${candidates.join(", ")}).` +
    (matches.length > 0 ? ` Close matches: ${matches.join(", ")}.` : "") +
    ` Available commands: ${available}. Use action "raw" with one of those ids.`
  );
}

/** Resolve a task-workspace file for import; null when missing or outside. */
function resolveImportFile(workspace: string, fileArg: string): string | null {
  try {
    const abs = taskPath(workspace, fileArg);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  } catch {
    /* fall through to null */
  }
  return null;
}

function optionalTime(params: Record<string, unknown>, key: string, value: unknown): void {
  const seconds = toSeconds(value);
  if (seconds !== null) params[key] = seconds;
}

function buildAction(
  action: VideoStudioAction,
  args: Record<string, unknown>,
  catalog: readonly string[],
  workspace: string,
): BuildResult {
  switch (action) {
    case "open":
      // Confirm the editor bridge is alive and hand back its command catalog.
      return { steps: [{ method: "commands", params: {} }] };

    case "state":
      // Read project / sequence / tracks / clips / playhead.
      return { steps: [{ method: "inspect", params: {} }] };

    case "import": {
      const url = str(args, "url").trim();
      const fileArg = str(args, "path").trim();
      if (url) return { steps: [{ method: "importUrl", params: { url } }] };
      if (fileArg) {
        const abs = resolveImportFile(workspace, fileArg);
        if (!abs) return { error: `import file not found in the task workspace: ${fileArg}` };
        return { steps: [{ method: "importFiles", params: { files: [abs] } }] };
      }
      return { error: 'import requires "url" (importUrl) or "path" (task file -> importFiles)' };
    }

    case "cut": {
      const times = toSecondsArray(args["atSec"] ?? args["at"]);
      if (!times) return { error: "cut requires atSec (seconds or timecode; an array cuts several points)" };
      const id = resolveCommandId(catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.razor);
      if (!id) return { error: unknownCommandMessage("cut", catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.razor) };
      return { steps: times.map((atSec) => execStep(id, { atSec })) };
    }

    case "trim": {
      const fromSec = toSeconds(args["fromSec"] ?? args["from"]);
      const toSec = toSeconds(args["toSec"] ?? args["to"]);
      if (fromSec === null || toSec === null) return { error: "trim requires fromSec and toSec (seconds or timecode)" };
      if (toSec <= fromSec) return { error: `trim range ${fromSec}-${toSec}s is empty` };
      const id = resolveCommandId(catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.trim);
      if (!id) return { error: unknownCommandMessage("trim", catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.trim) };
      return { steps: [execStep(id, { fromSec, toSec })] };
    }

    case "delete": {
      const fromSec = toSeconds(args["fromSec"] ?? args["from"]);
      const toSec = toSeconds(args["toSec"] ?? args["to"]);
      if (fromSec === null || toSec === null) return { error: "delete requires fromSec and toSec (seconds or timecode)" };
      if (toSec <= fromSec) return { error: `delete range ${fromSec}-${toSec}s is empty` };
      const id = resolveCommandId(catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.delete);
      if (!id) return { error: unknownCommandMessage("delete", catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.delete) };
      const params: Record<string, unknown> = { fromSec, toSec };
      if (args["ripple"] === true) params["ripple"] = true;
      return { steps: [execStep(id, params)] };
    }

    case "split": {
      const atSec = toSeconds(args["atSec"] ?? args["at"]);
      if (atSec === null) return { error: "split requires atSec (seconds or timecode)" };
      const id = resolveCommandId(catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.split);
      if (!id) return { error: unknownCommandMessage("split", catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.split) };
      return { steps: [execStep(id, { atSec })] };
    }

    case "move": {
      const clipId = str(args, "clipId").trim();
      if (!clipId) return { error: "move requires clipId" };
      const toIndex = num(args, "toIndex", Number.NaN);
      if (!Number.isFinite(toIndex)) return { error: "move requires toIndex (0-based target position)" };
      const id = resolveCommandId(catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.move);
      if (!id) return { error: unknownCommandMessage("move", catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.move) };
      return { steps: [execStep(id, { clipId, toIndex })] };
    }

    case "reorder": {
      const raw = args["order"];
      if (!Array.isArray(raw) || raw.length === 0) return { error: "reorder requires order (array of 1-based indices)" };
      const order = raw.map((entry) => (typeof entry === "number" ? entry : Number(entry)));
      if (order.some((entry) => !Number.isInteger(entry))) return { error: "reorder order must be integers" };
      // The editor applies `order` as a full 1-based permutation: exactly the
      // indices 1..n, each once. Anything else (duplicates, gaps, a 0-based or
      // short list) would silently reorder the wrong clips or be refused by the
      // engine, so refuse it here with a precise message instead.
      const seen = new Set<number>();
      for (const entry of order) {
        if (entry < 1 || entry > order.length || seen.has(entry)) {
          return { error: `reorder order must be a full 1-based permutation of 1..${order.length} (got ${JSON.stringify(order)})` };
        }
        seen.add(entry);
      }
      const id = resolveCommandId(catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.reorder);
      if (!id) return { error: unknownCommandMessage("reorder", catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.reorder) };
      return { steps: [execStep(id, { order })] };
    }

    case "speed": {
      const clipId = str(args, "clipId").trim();
      if (!clipId) return { error: "speed requires clipId" };
      const rate = num(args, "rate", Number.NaN);
      if (!Number.isFinite(rate) || rate <= 0) return { error: "speed requires a positive rate (1 = normal)" };
      const id = resolveCommandId(catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.speed);
      if (!id) return { error: unknownCommandMessage("speed", catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.speed) };
      return { steps: [execStep(id, { clipId, rate })] };
    }

    case "add_text": {
      const text = str(args, "text").trim();
      if (!text) return { error: "add_text requires text" };
      const atSec = toSeconds(args["atSec"] ?? args["at"]);
      if (atSec === null) return { error: "add_text requires atSec (seconds or timecode)" };
      const id = resolveCommandId(catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.addText);
      if (!id) return { error: unknownCommandMessage("add_text", catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.addText) };
      const params: Record<string, unknown> = { text, atSec };
      optionalTime(params, "durationSec", args["durationSec"]);
      const position = str(args, "position").trim();
      if (position) params["position"] = position;
      const size = num(args, "size", Number.NaN);
      if (Number.isFinite(size)) params["size"] = size;
      const color = str(args, "color").trim();
      if (color) params["color"] = color;
      return { steps: [execStep(id, params)] };
    }

    case "add_audio":
    case "music": {
      const url = str(args, "url").trim();
      const fileArg = str(args, "path").trim();
      const steps: VideoStudioStep[] = [];
      if (url) {
        steps.push({ method: "importUrl", params: { url } });
      } else if (fileArg) {
        const abs = resolveImportFile(workspace, fileArg);
        if (!abs) return { error: `add_audio file not found in the task workspace: ${fileArg}` };
        steps.push({ method: "importFiles", params: { files: [abs] } });
      } else {
        return { error: 'add_audio requires "url" or "path" (audio file in the task workspace)' };
      }
      const id = resolveCommandId(catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.addAudio);
      if (!id) return { error: unknownCommandMessage("add_audio", catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.addAudio) };
      const params: Record<string, unknown> = {};
      optionalTime(params, "atSec", args["atSec"]);
      const gain = num(args, "gain", Number.NaN);
      if (Number.isFinite(gain)) params["gain"] = gain;
      optionalTime(params, "fadeInSec", args["fadeInSec"]);
      optionalTime(params, "fadeOutSec", args["fadeOutSec"]);
      const trackId = str(args, "trackId").trim();
      if (trackId) params["trackId"] = trackId;
      steps.push(execStep(id, params));
      return { steps };
    }

    case "transition_basic": {
      const atSec = toSeconds(args["atSec"] ?? args["at"]);
      if (atSec === null) return { error: "transition_basic requires atSec (seconds or timecode)" };
      const params: Record<string, unknown> = { atSec };
      const type = str(args, "type").trim();
      if (type) params["type"] = type;
      optionalTime(params, "durationSec", args["durationSec"]);
      const trackId = str(args, "trackId").trim();
      if (trackId) params["trackId"] = trackId;
      const candidates = [
        ...VIDEO_STUDIO_COMMAND_CANDIDATES.applyVideoTransition,
        ...VIDEO_STUDIO_COMMAND_CANDIDATES.applyAudioTransition,
      ];
      const id =
        resolveCommandId(catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.applyVideoTransition) ??
        resolveCommandId(catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.applyAudioTransition);
      if (!id) return { error: unknownCommandMessage("transition_basic", catalog, candidates) };
      return { steps: [execStep(id, params)] };
    }

    case "effect_basic": {
      const name = str(args, "name").trim();
      if (!name) return { error: "effect_basic requires name (effect id)" };
      const id = resolveCommandId(catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.effectApply);
      if (!id) return { error: unknownCommandMessage("effect_basic", catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.effectApply) };
      const params: Record<string, unknown> = { name };
      const extra = args["params"];
      if (extra && typeof extra === "object" && !Array.isArray(extra)) {
        // Free-form effect parameters, but the positional `name` is the effect
        // id the action was asked to apply; a stray `params.name` would silently
        // swap the effect, so drop it instead of overriding.
        for (const [key, value] of Object.entries(extra as Record<string, unknown>)) {
          if (key === "name") continue;
          params[key] = value;
        }
      }
      return { steps: [execStep(id, params)] };
    }

    case "undo": {
      const id = resolveCommandId(catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.undo);
      if (!id) return { error: unknownCommandMessage("undo", catalog, VIDEO_STUDIO_COMMAND_CANDIDATES.undo) };
      return { steps: [execStep(id, {})] };
    }

    case "raw": {
      const command = str(args, "command").trim();
      if (!command) return { error: "raw requires a command id" };
      if (!catalog.includes(command)) {
        const matches = closeMatches(catalog, command);
        return {
          error:
            `unknown Loam Video command "${command}".` +
            (matches.length > 0 ? ` Close matches: ${matches.join(", ")}.` : "") +
            (catalog.length > 0 ? ` Available commands: ${catalog.join(", ")}.` : " The editor returned no command list."),
        };
      }
      const extra = args["params"];
      const params =
        extra && typeof extra === "object" && !Array.isArray(extra) ? (extra as Record<string, unknown>) : {};
      return { steps: [execStep(command, params)] };
    }

    default: {
      const exhaustive: never = action;
      return { error: `unknown video_studio action: ${String(exhaustive)}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Result envelopes
// ---------------------------------------------------------------------------

function fallbackResult(reason: VideoStudioFallbackReason, message: string, hint?: string): ToolResult {
  return {
    ok: false,
    content: JSON.stringify({
      ok: false,
      fallback: VIDEO_STUDIO_FALLBACK_TOOL,
      reason,
      message,
      hint: hint ?? `Use the ${VIDEO_STUDIO_FALLBACK_TOOL} tool instead: it compiles an edit-decision-list and renders via ffmpeg, so it needs neither the Loam Video dist nor the editor bridge.`,
    }),
  };
}

/** Map a relay failure to a retry hint (panel not open) or a video_edit fallback. */
function relayErrorResult(err: unknown): ToolResult {
  const code = (err as { code?: unknown } | null)?.code;
  const detail = err instanceof Error ? err.message : String(err);
  if (code === "PANEL_NOT_OPEN") {
    return {
      ok: false,
      content: JSON.stringify({
        ok: false,
        reason: "panel_not_open",
        retry: true,
        message:
          "No Loam Video panel is attached to this task yet. The Workspace panel opens automatically when video_studio runs; retry this action once it is open.",
      }),
    };
  }
  if (code === "CANCELLED") {
    return fallbackResult("cancelled", `The task stopped before the Loam Video command finished (${detail}).`);
  }
  // The panel reported a failed command. It uses the same ok:false channel both
  // when the editor refused a command (bad url, missing clip, unsupported
  // effect, ...) and when the editor API never loaded ("not ready or missing
  // method"), and it does not say which. The spec requires the video_edit
  // fallback whenever the bridge fails, so keep the fallback in both cases, but
  // classify the reason and keep the editor's own message so the failure is
  // never swallowed.
  if (code === "COMMAND_REJECTED") {
    return fallbackResult(
      "command_rejected",
      `The Loam Video editor refused the command (${detail}).`,
      `The panel executed the command but the editor rejected it, so retrying the same command will fail again: read the state action for the current clips/tracks, fix the command and retry video_studio. If the editor API itself did not load, use the ${VIDEO_STUDIO_FALLBACK_TOOL} tool instead (it compiles an edit-decision-list and renders via ffmpeg, so it needs no editor).`,
    );
  }
  return fallbackResult(
    "bridge_unavailable",
    `The Loam Video editor did not answer (${code ?? "error"}: ${detail}).`,
  );
}

// ---------------------------------------------------------------------------
// Agent tool
// ---------------------------------------------------------------------------

export interface VideoStudioToolOptions {
  /** Relay used to reach the editor panel; defaults to the shared server relay. */
  relay?: VideoStudioRelayLike;
  /** Repo root used for the dist check; defaults to ROOT. */
  root?: string;
  /** fc-05: per-task state tracker (manual-edit detection). Injectable for tests. */
  stateTracker?: VideoStudioStateTracker;
  /** fc-05: debounced project persistence into the task files. Injectable for tests. */
  projectStore?: VideoStudioProjectStore;
}

const TIME_SCHEMA = {
  type: ["number", "string"],
  description: "Seconds (90) or timecode (1:30, 00:01:30.500).",
} as const;

/**
 * Read the live timeline state from the editor (fc-05). Best-effort: a state
 * read must never break the command it precedes, so a relay failure here
 * returns undefined and the action proceeds without a summary.
 *
 * The read also (a) updates the per-task tracker, which reports a manual-edit
 * notice when the timeline differs from the state the agent last saw, and
 * (b) schedules a debounced persist of the raw project into the task files.
 */
async function readStudioState(
  taskId: string,
  relay: VideoStudioRelayLike,
  tracker: VideoStudioStateTracker,
  store: VideoStudioProjectStore,
  workspace: string,
): Promise<{ raw: unknown; summary: VideoStudioStateSummary; notice: string | null } | undefined> {
  let raw: unknown;
  try {
    raw = await relay.enqueue(taskId, "film", "inspect", {});
  } catch {
    return undefined;
  }
  const observation = tracker.observe(taskId, raw);
  try {
    store.schedule(taskId, workspace, raw, observation.summary);
  } catch {
    /* persistence is best-effort */
  }
  return { raw, summary: observation.summary, notice: observation.notice };
}

/**
 * Create the `video_studio` tool. The description is intentionally complete: it
 * is the model's only guide for driving the editor.
 */
export function createVideoStudioTools(options: VideoStudioToolOptions = {}): Tool[] {
  const relay = options.relay ?? videoStudioRelay;
  const root = options.root ?? ROOT;
  // fc-05: one tracker/store per tool instance, so change detection survives
  // across commands within a run. Tests inject their own to control the hash.
  const stateTracker = options.stateTracker ?? new VideoStudioStateTracker();
  const projectStore = options.projectStore ?? videoStudioProjectStore;

  return [
    {
      name: "video_studio",
      description:
        "Drive the Loam Video editor (the wasm timeline editor embedded in the Workspace panel) for the current task. " +
        "Every action is sent through the Video Studio relay to the attached editor panel, which applies it to the live timeline and returns the result. " +
        "Use this for direct, precise timeline work: open, state, import, cut, trim, delete, move, reorder, split, speed, add_text, add_audio (or music), transition_basic, effect_basic, undo and raw. " +
        "Always call state first to read the current project (sequences, tracks, clips, playhead) so manual edits made in the panel are never lost, then apply the edit. " +
        "Every result carries a compact timeline summary (tracks, clips with track/start/end and source in-out, text layers, audio clips, transitions, effects, duration, playhead, selection); when the timeline changed since your last action, a notice describing that change is prepended so you can adapt instead of repeating an edit the user already made. " +
        "Never rebuild the project from memory: every edit is an incremental command on the live project. " +
        "Timestamps accept seconds (90) or timecode (1:30, 00:01:30.500). " +
        "Mutating actions resolve their real engine command ids from the editor's own command list at runtime; raw executes any command id you name, but only after validating it against that list. " +
        "When the Loam Video dist is missing or the editor bridge fails, the tool returns a structured fallback telling you to use video_edit instead (an edit-decision-list rendered by ffmpeg, which needs no editor). " +
        "A command the editor refuses is reported with `reason: command_rejected` and the editor's own error, so a bad command is never confused with an unreachable editor.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: {
            type: "string",
            enum: [...VIDEO_STUDIO_ACTIONS],
            description:
              "open (confirm the editor is reachable and list its commands), state (read project/sequence/tracks/clips/playhead), " +
              "import (bring a task file or URL onto the timeline), cut (razor at one or more times), trim, delete (ripple optional), " +
              "move / reorder, split, speed, add_text (title/graphics layer), add_audio / music (audio file onto an audio track with gain/fade), " +
              "transition_basic (FilmCraft-native video/audio transition), effect_basic (effects.apply), undo, raw (any validated command id).",
          },
          taskId: { type: "string", description: "Task id (defaults to the current run task)." },
          url: { type: "string", description: "Media URL for import / add_audio." },
          path: { type: "string", description: "Task-workspace file path for import / add_audio." },
          atSec: { ...TIME_SCHEMA, description: "Cut/split/transition/effect position. For cut, an array cuts several points." },
          at: { ...TIME_SCHEMA, description: "Alias of atSec." },
          fromSec: { ...TIME_SCHEMA, description: "Range start for trim/delete." },
          toSec: { ...TIME_SCHEMA, description: "Range end for trim/delete." },
          from: { ...TIME_SCHEMA, description: "Alias of fromSec." },
          to: { ...TIME_SCHEMA, description: "Alias of toSec." },
          durationSec: { ...TIME_SCHEMA, description: "Duration for add_text / transition_basic." },
          ripple: { type: "boolean", description: "delete: close the gap left by the removed range." },
          clipId: { type: "string", description: "Target clip for move / speed." },
          trackId: { type: "string", description: "Target track for add_audio / transition_basic." },
          toIndex: { type: "number", description: "move: 0-based target position." },
          order: { type: "array", items: { type: "number" }, description: "reorder: 1-based indices, a full permutation." },
          rate: { type: "number", description: "speed: playback rate (1 = normal, 2 = double)." },
          text: { type: "string", description: "add_text: the text to place on the timeline." },
          position: { type: "string", enum: ["top", "center", "bottom"], description: "add_text: vertical placement." },
          size: { type: "number", description: "add_text: font size." },
          color: { type: "string", description: "add_text: text color (CSS value)." },
          gain: { type: "number", description: "add_audio: clip gain (1 = unchanged)." },
          fadeInSec: { ...TIME_SCHEMA, description: "add_audio: fade-in length." },
          fadeOutSec: { ...TIME_SCHEMA, description: "add_audio: fade-out length." },
          type: { type: "string", description: "transition_basic: transition type id." },
          name: { type: "string", description: "effect_basic: effect id." },
          params: { type: "object", description: "effect_basic / raw: extra engine parameters." },
          command: { type: "string", description: "raw: the engine command id to execute." },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const action = str(args, "action").trim();
        if (!isVideoStudioAction(action)) {
          return { ok: false, content: `video_studio action must be one of: ${VIDEO_STUDIO_ACTIONS.join(", ")}` };
        }
        const taskId = str(args, "taskId", ctx.taskId ?? "").trim();
        if (!taskId) return { ok: false, content: "video_studio requires a taskId (or a running task context)" };

        if (!isFilmcraftDistInstalled(root)) {
          return fallbackResult(
            "filmcraft_dist_missing",
            `The Loam Video dist is not installed (${filmcraftDistDir(root)}). Install it with the vendor script, then retry.`,
          );
        }

        // Only actions that issue engine commands need the live catalog.
        const needsCatalog = action !== "open" && action !== "state" && action !== "import";
        let catalog: string[] = [];
        if (needsCatalog) {
          try {
            catalog = toCommandIdList(await relay.enqueue(taskId, "film", "commands", {}));
          } catch (err) {
            return relayErrorResult(err);
          }
        }

        // fc-05: read the live timeline before acting. Manual edits the user
        // made in the panel are surfaced here, and the project is persisted so
        // a reload can restore it.
        const before = await readStudioState(taskId, relay, stateTracker, projectStore, ctx.workspace);

        const built = buildAction(action, args, catalog, ctx.workspace);
        if ("error" in built) return { ok: false, content: built.error };

        const results: Array<{ method: string; ok: boolean; result?: unknown }> = [];
        // `state` is itself a state read: reuse the pre-read so the result is a
        // single inspect round trip instead of two.
        const isStateRead = built.steps.length === 1 && built.steps[0]!.method === "inspect";
        if (isStateRead && before) {
          results.push({ method: "inspect", ok: true, result: before.raw });
        } else {
          for (const step of built.steps) {
            try {
              const value = await relay.enqueue(taskId, "film", step.method, step.params);
              results.push({ method: step.method, ok: true, result: value });
            } catch (err) {
              return relayErrorResult(err);
            }
          }
        }

        // fc-05: re-read after a mutating action so the next command's change
        // detection starts from the state the agent last saw (its own edit
        // included) and the result reports the timeline as it now stands.
        const after = isStateRead && before ? before : await readStudioState(taskId, relay, stateTracker, projectStore, ctx.workspace);
        const summary = (after ?? before)?.summary ?? null;
        const notice = before?.notice ?? null;

        const body =
          action === "open"
            ? { action, available: true, commands: results[0]?.result ?? [], summary, notice }
            : { action, steps: results, summary, notice };
        const json = JSON.stringify(body);
        return { ok: true, content: notice ? `${notice}\n${json}` : json };
      },
    },
  ];
}

export const VIDEO_STUDIO_TOOL_NAMES = ["video_studio"];
