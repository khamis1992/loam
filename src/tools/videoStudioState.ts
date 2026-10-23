/**
 * Loam Video Studio state sync (fc-05).
 *
 * The `video_studio` agent tool drives the live timeline through the fc-02
 * relay. Because the user can edit the same timeline by hand in the Workspace
 * panel, the agent must never rebuild the project from memory: before every
 * command it reads the live state, compares it with the last state it saw, and
 * reports a manual-edit notice when they differ.
 *
 * This module owns that contract:
 *  - {@link summarizeProjectState} turns the editor's loose `inspect` payload
 *    into a compact, accurate timeline summary (clips with track/start/end and
 *    source in-out, text layers, audio clips, transitions, effects, duration,
 *    playhead, selection).
 *  - {@link hashProjectState} fingerprints that summary, so a change is
 *    detected without storing the whole project.
 *  - {@link diffProjectStates} / {@link formatStateDiff} describe what changed
 *    (added / removed / moved clips, text/audio/transition/effect changes).
 *  - {@link VideoStudioStateTracker} keeps the last state the agent saw per task
 *    and produces the manual-edit notice.
 *  - {@link VideoStudioProjectStore} persists the project (as reported by the
 *    bridge) into the task's files, debounced, so a reload can restore it.
 *
 * The editor's `inspect` payload shape is engine-defined and not guaranteed, so
 * every extractor is defensive: unknown shapes degrade to an empty (or partial)
 * summary instead of throwing, and only the fields the summary needs are
 * fingerprinted so unrelated editor internals never look like a manual edit.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { taskPath } from "../server/taskWorkspace.js";

// ---------------------------------------------------------------------------
// Compact timeline summary
// ---------------------------------------------------------------------------

/** One clip on the timeline, normalised from the editor's loose shape. */
export interface VideoStudioClipSummary {
  id: string;
  trackId: string;
  /** Track kind when the editor reports it: video / audio / text / "". */
  trackKind: string;
  /** Timeline range in seconds. */
  startSec: number | null;
  endSec: number | null;
  /** Source (media file) range in seconds. */
  sourceInSec: number | null;
  sourceOutSec: number | null;
  name: string;
  /** Present only for text/graphics layers. */
  text: string | null;
  /** Present when the clip carries a transition. */
  transition: string | null;
  effects: string[];
}

/** One track on the timeline. */
export interface VideoStudioTrackSummary {
  id: string;
  kind: string;
  clipCount: number;
}

/** Compact, accurate timeline summary handed to the model in every result. */
export interface VideoStudioStateSummary {
  durationSec: number | null;
  playheadSec: number | null;
  selection: string[];
  tracks: VideoStudioTrackSummary[];
  clips: VideoStudioClipSummary[];
  textLayers: VideoStudioClipSummary[];
  audioClips: VideoStudioClipSummary[];
  transitions: string[];
  effects: string[];
}

// ---------------------------------------------------------------------------
// Defensive readers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Read seconds from a number or a `HH:MM:SS` / `MM:SS` timecode string. */
function readTime(value: unknown): number | null {
  const numeric = readNumber(value);
  if (numeric !== null) return numeric;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parts = value.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const segments = parts.map((part) => Number(part));
  if (segments.some((segment) => !Number.isFinite(segment))) return null;
  const [hoursOrMinutes = 0, minutesOrSeconds = 0, maybeSeconds = 0] = segments as number[];
  return parts.length === 2
    ? hoursOrMinutes * 60 + minutesOrSeconds
    : hoursOrMinutes * 3600 + minutesOrSeconds * 60 + maybeSeconds;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function firstTime(source: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = readTime(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = readString(source[key]);
    if (value !== null) return value;
  }
  return null;
}

/** Read an effects list from an array, a name map or a single string. */
function readEffects(source: Record<string, unknown>): string[] {
  const raw = source["effects"] ?? source["effect"];
  const out: string[] = [];
  const push = (name: string | null): void => {
    if (name && !out.includes(name)) out.push(name);
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string") push(entry);
      else push(firstString(asRecord(entry) ?? {}, ["name", "id", "type", "effect"]));
    }
  } else if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === false || value === null || value === undefined) continue;
      push(key);
    }
  } else if (typeof raw === "string") {
    push(raw);
  }
  return out;
}

/** Read the current selection (array of ids or {id} objects). */
function readSelection(source: Record<string, unknown>): string[] {
  const raw = source["selection"] ?? source["selectedClipIds"] ?? source["selected"];
  const out: string[] = [];
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
    else {
      const id = firstString(asRecord(entry) ?? {}, ["id", "clipId"]);
      if (id) out.push(id);
    }
  }
  return out;
}

/** Normalise one clip entry. Clips without an id cannot be tracked for moves. */
function summarizeClip(raw: unknown, fallbackTrackId: string): VideoStudioClipSummary | null {
  const source = asRecord(raw);
  if (!source) return null;
  const id = firstString(source, ["id", "clipId", "uid", "guid"]);
  if (!id) return null;
  const trackKind = firstString(source, ["trackKind", "kind", "type"]) ?? "";
  const text = firstString(source, ["text", "content", "title"]);
  const transition = firstString(source, ["transition", "transitionType", "transitionId"]);
  return {
    id,
    trackId: firstString(source, ["trackId", "track"]) ?? fallbackTrackId,
    trackKind,
    startSec: firstTime(source, ["startSec", "start", "timelineStartSec", "inSec"]),
    endSec: firstTime(source, ["endSec", "end", "timelineEndSec", "outSec"]),
    sourceInSec: firstTime(source, ["sourceInSec", "sourceIn", "srcInSec", "inPointSec"]),
    sourceOutSec: firstTime(source, ["sourceOutSec", "sourceOut", "srcOutSec", "outPointSec"]),
    name: firstString(source, ["name", "label", "sourceName", "file"]) ?? "",
    text,
    transition,
    effects: readEffects(source),
  };
}

/**
 * Build the compact timeline summary from the editor's `inspect` payload.
 * Never throws: an unrecognisable payload yields an empty summary.
 */
export function summarizeProjectState(raw: unknown): VideoStudioStateSummary {
  let root = asRecord(raw) ?? {};
  // Some builds nest the timeline under `project` / `state`.
  const nested = asRecord(root["project"]) ?? asRecord(root["state"]);
  if (nested && (Array.isArray(nested["sequences"]) || Array.isArray(nested["tracks"]) || Array.isArray(nested["clips"]))) {
    root = { ...root, ...nested };
  }

  const clips: VideoStudioClipSummary[] = [];
  const tracks: VideoStudioTrackSummary[] = [];

  const trackLists: unknown[] = [];
  for (const sequence of Array.isArray(root["sequences"]) ? root["sequences"] : []) {
    const record = asRecord(sequence);
    if (record && Array.isArray(record["tracks"])) trackLists.push(...(record["tracks"] as unknown[]));
  }
  if (Array.isArray(root["tracks"])) trackLists.push(...(root["tracks"] as unknown[]));

  if (trackLists.length === 0 && Array.isArray(root["clips"])) {
    for (const entry of root["clips"] as unknown[]) {
      const clip = summarizeClip(entry, "");
      if (clip) clips.push(clip);
    }
  }

  for (const entry of trackLists) {
    const track = asRecord(entry);
    if (!track) continue;
    const trackId = firstString(track, ["id", "trackId"]) ?? "";
    const trackKind = firstString(track, ["kind", "type"]) ?? "";
    const trackClips = Array.isArray(track["clips"]) ? track["clips"] : [];
    let clipCount = 0;
    for (const clipRaw of trackClips) {
      const clip = summarizeClip(clipRaw, trackId);
      if (!clip) continue;
      // A clip usually does not repeat the track's kind; inherit it so the
      // text/audio buckets below are accurate.
      if (!clip.trackKind) clip.trackKind = trackKind;
      clips.push(clip);
      clipCount += 1;
    }
    tracks.push({ id: trackId, kind: trackKind, clipCount });
  }

  const durationSec =
    firstTime(root, ["durationSec", "duration", "totalDurationSec", "sequenceDurationSec"]) ??
    (clips.length > 0 ? Math.max(...clips.map((clip) => clip.endSec ?? 0)) : null);

  const transitions: string[] = [];
  const effects: string[] = [];
  for (const clip of clips) {
    if (clip.transition && !transitions.includes(clip.transition)) transitions.push(clip.transition);
    for (const effect of clip.effects) if (!effects.includes(effect)) effects.push(effect);
  }

  return {
    durationSec,
    playheadSec: firstTime(root, ["playheadSec", "playhead", "currentTimeSec", "timeSec"]),
    selection: readSelection(root),
    tracks,
    clips,
    textLayers: clips.filter((clip) => clip.trackKind === "text" || clip.text !== null),
    audioClips: clips.filter((clip) => clip.trackKind === "audio"),
    transitions,
    effects,
  };
}

// ---------------------------------------------------------------------------
// Fingerprint + diff
// ---------------------------------------------------------------------------

/** Canonical JSON (sorted keys, no undefined) used for fingerprints. */
function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

/** Stable 16-char fingerprint of a summary (sha256 of its canonical form). */
export function hashProjectState(summary: VideoStudioStateSummary): string {
  return crypto.createHash("sha256").update(stableStringify(summary)).digest("hex").slice(0, 16);
}

/** A clip that changed track and/or position between two summaries. */
export interface VideoStudioMovedClip {
  clip: VideoStudioClipSummary;
  fromStartSec: number | null;
  fromTrackId: string;
  toStartSec: number | null;
  toTrackId: string;
}

/** What changed between two timeline summaries. */
export interface VideoStudioStateDiff {
  added: VideoStudioClipSummary[];
  removed: VideoStudioClipSummary[];
  moved: VideoStudioMovedClip[];
  addedText: string[];
  removedText: string[];
  addedAudio: string[];
  removedAudio: string[];
  addedTransitions: string[];
  removedTransitions: string[];
  addedEffects: string[];
  removedEffects: string[];
  playheadChanged: boolean;
  durationChanged: boolean;
}

function diffNamed(prev: readonly string[], next: readonly string[]): { added: string[]; removed: string[] } {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  return {
    added: next.filter((name) => !prevSet.has(name)),
    removed: prev.filter((name) => !nextSet.has(name)),
  };
}

/** Diff two summaries, reporting added / removed / moved clips and more. */
export function diffProjectStates(prev: VideoStudioStateSummary, next: VideoStudioStateSummary): VideoStudioStateDiff {
  const prevClips = new Map(prev.clips.map((clip) => [clip.id, clip]));
  const nextClips = new Map(next.clips.map((clip) => [clip.id, clip]));

  const added: VideoStudioClipSummary[] = [];
  const removed: VideoStudioClipSummary[] = [];
  const moved: VideoStudioMovedClip[] = [];

  for (const [id, clip] of nextClips) {
    const before = prevClips.get(id);
    if (!before) {
      added.push(clip);
      continue;
    }
    if (before.startSec !== clip.startSec || before.trackId !== clip.trackId) {
      moved.push({
        clip,
        fromStartSec: before.startSec,
        fromTrackId: before.trackId,
        toStartSec: clip.startSec,
        toTrackId: clip.trackId,
      });
    }
  }
  for (const [id, clip] of prevClips) {
    if (!nextClips.has(id)) removed.push(clip);
  }

  const text = diffNamed(
    prev.textLayers.map((clip) => clip.text ?? clip.id),
    next.textLayers.map((clip) => clip.text ?? clip.id),
  );
  const audio = diffNamed(
    prev.audioClips.map((clip) => clip.name || clip.id),
    next.audioClips.map((clip) => clip.name || clip.id),
  );
  const transitions = diffNamed(prev.transitions, next.transitions);
  const effects = diffNamed(prev.effects, next.effects);

  return {
    added,
    removed,
    moved,
    addedText: text.added,
    removedText: text.removed,
    addedAudio: audio.added,
    removedAudio: audio.removed,
    addedTransitions: transitions.added,
    removedTransitions: transitions.removed,
    addedEffects: effects.added,
    removedEffects: effects.removed,
    playheadChanged: prev.playheadSec !== next.playheadSec,
    durationChanged: prev.durationSec !== next.durationSec,
  };
}

function describeClip(clip: VideoStudioClipSummary): string {
  const kind = clip.trackKind || "clip";
  const range = `${clip.startSec ?? "?"}-${clip.endSec ?? "?"}s`;
  const source = clip.sourceInSec !== null && clip.sourceOutSec !== null ? ` src ${clip.sourceInSec}-${clip.sourceOutSec}s` : "";
  const name = clip.name ? ` ${clip.name}` : "";
  return ` (${kind} ${range}${source}${name})`;
}

/**
 * Compact human-readable diff for the manual-edit notice: one token per change,
 * prefixed with `+` (added), `-` (removed) or `~` (moved / adjusted).
 */
export function formatStateDiff(diff: VideoStudioStateDiff): string {
  const parts: string[] = [];
  for (const clip of diff.added) parts.push(`+clip ${clip.id}${describeClip(clip)}`);
  for (const clip of diff.removed) parts.push(`-clip ${clip.id}${describeClip(clip)}`);
  for (const move of diff.moved) {
    parts.push(`~clip ${move.clip.id} ${move.fromStartSec ?? "?"}s->${move.toStartSec ?? "?"}s`);
  }
  for (const text of diff.addedText) parts.push(`+text ${JSON.stringify(text)}`);
  for (const text of diff.removedText) parts.push(`-text ${JSON.stringify(text)}`);
  for (const audio of diff.addedAudio) parts.push(`+audio ${audio}`);
  for (const audio of diff.removedAudio) parts.push(`-audio ${audio}`);
  for (const transition of diff.addedTransitions) parts.push(`+transition ${transition}`);
  for (const transition of diff.removedTransitions) parts.push(`-transition ${transition}`);
  for (const effect of diff.addedEffects) parts.push(`+effect ${effect}`);
  for (const effect of diff.removedEffects) parts.push(`-effect ${effect}`);
  if (diff.playheadChanged) parts.push("~playhead");
  if (diff.durationChanged) parts.push("~duration");
  return parts.length > 0 ? parts.join(" ") : "no clip changes";
}

// ---------------------------------------------------------------------------
// Per-task tracker (manual-edit detection)
// ---------------------------------------------------------------------------

/** A state observation returned to the agent: fingerprint, summary, notice. */
export interface VideoStudioStateSnapshot {
  hash: string;
  summary: VideoStudioStateSummary;
  /** True when the state differs from the last state this task was seen with. */
  changed: boolean;
  /** Notice to prepend to the tool result when {@link changed} is true. */
  notice: string | null;
}

/** True when a summary carries no timeline content at all. */
function isEmptySummary(summary: VideoStudioStateSummary): boolean {
  return summary.tracks.length === 0 && summary.clips.length === 0;
}

/**
 * Keeps the last state the agent saw per task. Call {@link observe} before every
 * command: when the state changed since the previous observation, the snapshot
 * carries a manual-edit notice built from the diff.
 *
 * Change detection is a pure function of what this tracker has itself observed:
 * an unknown baseline (no previous observation, or a previous observation with
 * no timeline content) is never reported as a manual edit, and an empty read is
 * never taken as the new baseline. That keeps a transient/unsupported editor
 * response from producing a false "you changed something" notice or masking the
 * next real change.
 */
export class VideoStudioStateTracker {
  /** The last non-empty summary observed per task, the baseline for changes. */
  private readonly last = new Map<string, { hash: string; summary: VideoStudioStateSummary }>();

  /** Observe a raw state payload and return the fingerprint/summary/notice. */
  observe(taskId: string, rawState: unknown): VideoStudioStateSnapshot {
    const summary = summarizeProjectState(rawState);
    const hash = hashProjectState(summary);

    // An empty read is not a state: report it, but never adopt it as the
    // baseline (which would make the next real state look like a wholesale edit).
    const empty = isEmptySummary(summary);
    const previous = this.last.get(taskId);
    const comparable = !empty && previous !== undefined;
    const changed = comparable && previous!.hash !== hash;
    const notice = changed
      ? `User edited the timeline manually since your last action: ${formatStateDiff(diffProjectStates(previous!.summary, summary))}`
      : null;
    if (!empty) this.last.set(taskId, { hash, summary });

    return { hash, summary, changed, notice };
  }

  /** Fingerprint of the last observed state, or null when none was observed. */
  lastHash(taskId: string): string | null {
    return this.last.get(taskId)?.hash ?? null;
  }

  /** Forget a task (e.g. when the task ends). */
  forget(taskId: string): void {
    this.last.delete(taskId);
  }
}

// ---------------------------------------------------------------------------
// Debounced project persistence
// ---------------------------------------------------------------------------

/** Task-workspace file that stores the project between reloads. */
export const VIDEO_STUDIO_PROJECT_FILE = path.join("loam-video", "project.json");

export interface VideoStudioProjectStoreOptions {
  /** Debounce window in milliseconds (default 500). */
  debounceMs?: number;
}

/** The project payload persisted per task (raw editor state + its summary). */
export interface VideoStudioPersistedProject {
  /** Raw `inspect` payload, exactly what the editor expects back on restore. */
  project: unknown;
  /** Compact timeline summary derived from {@link project}. */
  summary: VideoStudioStateSummary;
  /** ISO timestamp of the write, or null for older files. */
  savedAt: string | null;
}

interface PendingWrite {
  workspace: string;
  raw: unknown;
  normalized: VideoStudioStateSummary;
  timer: NodeJS.Timeout;
}

/**
 * Persists the project (the bridge's `inspect` payload) into the task's files,
 * debounced. Writes are best-effort: a filesystem failure must never break an
 * agent command, it is swallowed silently.
 *
 * Each write stores the raw `inspect` payload (what the editor expects back) plus
 * the compact summary derived from it, so a reload can read the timeline without
 * re-deriving it.
 */
export class VideoStudioProjectStore {
  private readonly debounceMs: number;
  private readonly pending = new Map<string, PendingWrite>();

  constructor(options: VideoStudioProjectStoreOptions = {}) {
    this.debounceMs = options.debounceMs ?? 500;
  }

  /**
   * Schedule a debounced write for a task (resets the timer on each change).
   * `summary` is the compact form of `rawProject`; it is stored alongside so a
   * reload can read the timeline without re-deriving it.
   */
  schedule(taskId: string, workspace: string, rawProject: unknown, summary?: VideoStudioStateSummary): void {
    const existing = this.pending.get(taskId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const current = this.pending.get(taskId);
      this.pending.delete(taskId);
      if (current) void this.write(current.workspace, current.raw, current.normalized);
    }, this.debounceMs);
    timer.unref?.();
    this.pending.set(taskId, {
      workspace,
      raw: rawProject,
      normalized: summary ?? summarizeProjectState(rawProject),
      timer,
    });
  }

  /** Flush a task (or every pending task) immediately. */
  async flush(taskId?: string): Promise<void> {
    const ids = taskId ? [taskId] : [...this.pending.keys()];
    for (const id of ids) {
      const current = this.pending.get(id);
      if (!current) continue;
      clearTimeout(current.timer);
      this.pending.delete(id);
      await this.write(current.workspace, current.raw, current.normalized);
    }
  }

  /** Drop a pending write without writing it. */
  forget(taskId: string): void {
    const current = this.pending.get(taskId);
    if (current) clearTimeout(current.timer);
    this.pending.delete(taskId);
  }

  /** The persisted payload for a task, or null when none was stored. */
  load(taskId: string, workspace: string): VideoStudioPersistedProject | null {
    void taskId;
    try {
      const file = taskPath(workspace, VIDEO_STUDIO_PROJECT_FILE);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<VideoStudioPersistedProject> | null;
      if (!parsed || typeof parsed !== "object" || !parsed.project) return null;
      return {
        project: parsed.project,
        summary: parsed.summary ?? summarizeProjectState(parsed.project),
        savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : null,
      };
    } catch {
      return null;
    }
  }

  /** True when a persisted project exists for the task. */
  has(taskId: string, workspace: string): boolean {
    return this.load(taskId, workspace) !== null;
  }

  private async write(workspace: string, raw: unknown, summary: VideoStudioStateSummary): Promise<void> {
    try {
      const dir = taskPath(workspace, "loam-video");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "project.json");
      const tmp = `${file}.tmp`;
      const payload: VideoStudioPersistedProject = {
        project: raw,
        summary,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, file);
    } catch {
      /* persistence is best-effort; never break an agent command */
    }
  }
}

/** Shared store for the running server (one per process). */
export const videoStudioProjectStore = new VideoStudioProjectStore();
