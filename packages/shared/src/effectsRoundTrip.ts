/**
 * Effects round-trip: send a Loam Video clip to the "Loam Effects" engine and put
 * the rendered result back on the same track (fc-09).
 *
 * Loam ships one product with two engines. Loam Video owns the timeline: cuts,
 * trims, arrangement, music and audio. Loam Effects is the hidden backend for
 * transitions, effects and text/motion animation. This module owns the round
 * trip between them:
 *
 *   1. take the clip on the Loam Video timeline (by clipId, or the range the
 *      agent named) and read its source media plus in/out;
 *   2. hand that media to the effects engine, build a composition that matches
 *      the clip's size/fps/duration, place the layer, apply the requested
 *      transition / effect / text animation, save the project, render it and
 *      read the output;
 *   3. bring the rendered file back into Loam Video and replace the original
 *      range on the same track, leaving neighbouring clips untouched.
 *
 * Every command id is resolved against the engine's own `commands()` catalog at
 * runtime and never guessed, and a request is mapped to engine ids through the
 * table in {@link ASK_EFFECT_MAP} so a renamed engine command degrades to a
 * clear message instead of a silent no-op.
 *
 * The round trip is expressed as a flat list of relay steps (film/effects
 * alternating), so the `video_studio` tool and the panel's "Open in effects"
 * button drive the SAME sequence. This module is pure data + pure functions (no
 * bridge, no React, no Node built-ins), which is what lets it live in the shared
 * package and be unit-tested with two mocked engines.
 */

// ---------------------------------------------------------------------------
// Ask mapping (what the user asked for -> engine ids)
// ---------------------------------------------------------------------------

/** The three asks the effects backend can answer. */
export type EffectsAskKind = "transition" | "effect" | "animate_text";

/**
 * Engine ids for each common ask, most-likely-first. Resolved against the live
 * effects `commands()` catalog at runtime; the first id the engine actually
 * exposes wins. Kept in code (and tested) so the mapping is auditable.
 */
export const ASK_EFFECT_MAP: Record<EffectsAskKind, string[]> = {
  transition: [
    "transition.fade",
    "transition.crossDissolve",
    "transition.dissolve",
    "transition.wipe",
    "transition.slide",
    "transition.zoom",
    "transitions.apply",
    "effect.transition",
  ],
  effect: [
    "effect.blur",
    "effect.glow",
    "effect.colorLook",
    "effect.color",
    "effect.shake",
    "effects.apply",
    "effect.apply",
  ],
  animate_text: [
    "text.animateIn",
    "text.animateOut",
    "text.typewriter",
    "text.animate",
    "animation.text",
    "text.add",
    "graphics.addText",
  ],
};

/** Human-readable names for each ask, used in messages (never upstream names). */
export const ASK_EFFECT_LABELS: Record<EffectsAskKind, string[]> = {
  transition: ["fade", "cross dissolve", "dissolve", "wipe", "slide", "zoom"],
  effect: ["blur", "glow", "color look", "color", "shake"],
  animate_text: ["animate in", "animate out", "typewriter", "animate"],
};

/** Resolve the engine command id for an ask, or null when the engine lacks it. */
export function resolveAskId(catalog: readonly string[], kind: EffectsAskKind): string | null {
  return resolveCommandId(catalog, ASK_EFFECT_MAP[kind]);
}

// ---------------------------------------------------------------------------
// Time + command-id helpers
//
// Deliberately self-contained: this module is imported by the Node agent tools
// and by the browser panel, so it may not reach into either side's utilities.
// ---------------------------------------------------------------------------

/**
 * Parse one timestamp token: `90`, `90s`, `1:30`, `1:02:03`, `2 min`, `1.5 sec`.
 * The grammar matches the agent tools' `toSeconds` so both halves of the product
 * read a timestamp identically.
 */
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

/** Accept a number of seconds or a timecode string; null when unparseable. */
export function toSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return parseTimeToken(value.trim());
  return null;
}

/** First candidate the catalog actually exposes, or null. */
export function resolveCommandId(catalog: readonly string[], candidates: readonly string[]): string | null {
  const available = new Set(catalog);
  for (const candidate of candidates) if (available.has(candidate)) return candidate;
  return null;
}

/** Read a trimmed string field, or "" when absent. */
export function readArg(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Read a finite number field, or undefined when absent/unparseable. */
export function readNum(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Reading the clip out of the Loam Video state
// ---------------------------------------------------------------------------

/** A track as the editor reports it (loose shape; ids are checked at runtime). */
export interface FilmTrack {
  id: string;
  clips: FilmClip[];
}

/** A clip on the timeline, with its source media and in/out points. */
export interface FilmClip {
  id: string;
  /** Source media path the editor knows the clip by. */
  source: string;
  /** Track the clip sits on, when the editor reports one. */
  trackId?: string;
  /** Clip start on the timeline, seconds. */
  startSec: number;
  /** Clip end on the timeline, seconds. */
  endSec: number;
  /** In-point inside the source media, seconds. */
  inSec: number;
  /** Out-point inside the source media, seconds. */
  outSec: number;
  /** Source frame rate when the editor reports one. */
  fps?: number;
  /** Source dimensions when the editor reports them. */
  width?: number;
  height?: number;
}

/** A Loam Video project state, normalised from the editor's `inspect()` result. */
export interface FilmState {
  sequences: FilmTrack[];
  playheadSec: number;
  /** The clip the user selected in the panel, when the editor reports one. */
  selectedClipId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readSeconds(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = toSeconds(value.trim());
      if (parsed !== null) return parsed;
    }
  }
  return undefined;
}

/** Normalise one clip entry from the editor's inspect() output. */
function readClip(raw: unknown): FilmClip | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const nested = asRecord(rec.clip) ?? asRecord(rec.source) ?? rec;
  const id = typeof rec.id === "string" ? rec.id : typeof nested.id === "string" ? nested.id : undefined;
  if (!id) return null;
  const source =
    (typeof rec.source === "string" ? rec.source : undefined) ??
    (typeof rec.path === "string" ? rec.path : undefined) ??
    (typeof rec.file === "string" ? rec.file : undefined) ??
    (typeof nested.source === "string" ? nested.source : undefined) ??
    (typeof nested.path === "string" ? nested.path : undefined) ??
    id;
  const startSec = readSeconds(rec, ["startSec", "start", "inSec", "in"]) ?? 0;
  const endSec = readSeconds(rec, ["endSec", "end", "outSec", "out"]) ?? startSec;
  return {
    id,
    source,
    trackId: typeof rec.trackId === "string" ? rec.trackId : undefined,
    startSec,
    endSec,
    inSec: readSeconds(rec, ["inSec", "sourceInSec", "sourceIn", "trimIn"]) ?? 0,
    outSec: readSeconds(rec, ["outSec", "sourceOutSec", "sourceOut", "trimOut"]) ?? endSec - startSec,
    fps: typeof rec.fps === "number" ? rec.fps : undefined,
    width: typeof rec.width === "number" ? rec.width : undefined,
    height: typeof rec.height === "number" ? rec.height : undefined,
  };
}

/** The selected clip id, from the several shapes editors report it in. */
function readSelectedClipId(rec: Record<string, unknown> | null): string | undefined {
  if (!rec) return undefined;
  for (const key of ["selectedClipId", "selectionClipId", "activeClipId"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const key of ["selection", "selectedClip"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    const nested = asRecord(value);
    const id = nested?.["clipId"] ?? nested?.["id"];
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return undefined;
}

/** Normalise the editor's inspect() result into tracks of clips. */
export function parseFilmState(raw: unknown): FilmState {
  const rec = asRecord(raw);
  const sequencesRaw = (rec?.sequences ?? rec?.sequence ?? rec?.tracks ?? []) as unknown;
  const list = Array.isArray(sequencesRaw) ? sequencesRaw : [];
  const tracks: FilmTrack[] = [];
  for (const entry of list) {
    const seq = asRecord(entry);
    if (!seq) continue;
    const clipsRaw = (seq.clips ?? seq.items ?? []) as unknown;
    const clips: FilmClip[] = [];
    for (const clipRaw of Array.isArray(clipsRaw) ? clipsRaw : []) {
      const clip = readClip(clipRaw);
      if (clip) clips.push(clip);
    }
    // Some builds report a flat clip list with the track id on each clip; give
    // those a synthetic track so they are still addressable.
    const id = typeof seq.id === "string" ? seq.id : `track_${tracks.length}`;
    tracks.push({ id, clips: clips.map((clip) => ({ ...clip, trackId: clip.trackId ?? id })) });
  }
  const playheadSec = readSeconds(rec ?? {}, ["playheadSec", "playhead", "currentSec", "positionSec"]) ?? 0;
  return { sequences: tracks, playheadSec, selectedClipId: readSelectedClipId(rec) };
}

/** The clip a round trip should act on: by id, else the clip under a time. */
export function selectClip(state: FilmState, clipId: string | null, atSec: number | null): FilmClip | null {
  // The track a clip sits on is part of the answer: the round trip replaces the
  // range on that same track, so a clip that arrived without one inherits the
  // track it was found on.
  const on = (track: FilmTrack, clip: FilmClip): FilmClip => ({ ...clip, trackId: clip.trackId ?? track.id });
  // A named clip id is authoritative. When the agent names a clip that is not on
  // the timeline we refuse instead of quietly acting on whatever sits under the
  // playhead, because the round trip overwrites the clip's range in place.
  if (clipId) {
    for (const track of state.sequences) {
      const found = track.clips.find((clip) => clip.id === clipId);
      if (found) return on(track, found);
    }
    return null;
  }
  if (atSec !== null) {
    for (const track of state.sequences) {
      const found = track.clips.find((clip) => atSec >= clip.startSec && atSec < clip.endSec);
      if (found) return on(track, found);
    }
  }
  return null;
}

/** The clip a panel action should act on: the selection, else the playhead. */
export function selectPanelClip(state: FilmState): FilmClip | null {
  return selectClip(state, state.selectedClipId ?? null, state.playheadSec);
}

// ---------------------------------------------------------------------------
// Planning the round trip
// ---------------------------------------------------------------------------

/**
 * Engine methods the round trip uses, most-likely-first. Real ids are resolved
 * against each engine's own `commands()` catalog at runtime.
 */
export const ROUND_TRIP_COMMAND_CANDIDATES = {
  /** Replace the clip's range on the same track with the rendered output. */
  replaceRange: [
    "timeline.replaceRange",
    "sequence.replaceRange",
    "clip.replaceRange",
    "timeline.replaceClip",
    "sequence.replaceClip",
    "edit.replaceRange",
  ],
  /** Read a rendered file back from the effects engine. */
  readFile: ["readFile", "file.read", "files.read"],
  /** Render the current composition through the render queue. */
  render: ["renderQueue.render", "render", "renderQueue.renderAll"],
  /** Import a rendered file into the timeline as a clip. */
  importFiles: ["importFiles", "sequence.addClip", "timeline.addClip"],
  /** Create the effects composition that matches the clip. */
  newComposition: ["composition.new", "comp.new", "composition.create"],
  /** Save the effects project so it can be reopened from the panel. */
  saveProject: ["project.save", "project.saveAs", "file.save", "saveProject"],
} as const;

/** One relay step of the round trip. */
export interface RoundTripStep {
  /** Which engine executes the step. */
  target: "film" | "effects";
  method: string;
  params: Record<string, unknown>;
}

export interface RoundTripPlan {
  /** The clip that was taken from the timeline. */
  clip: FilmClip;
  /** The `.ecproj` the sequence saved, or null when it could not name one. */
  projectPath: string | null;
  steps: RoundTripStep[];
}

export interface RoundTripPlanError {
  error: string;
}

export interface PlanRoundTripInput {
  /** Normalised Loam Video state (from inspect()). */
  state: FilmState;
  /** Clip id the agent named, or null to pick by time. */
  clipId?: string | null;
  /** Timeline position (seconds/timecode) when no clipId was given. */
  atSec?: unknown;
  /** What to apply in the effects engine. */
  kind: EffectsAskKind;
  /** Free-form parameters forwarded to the engine command. */
  params?: Record<string, unknown>;
  /**
   * Where to store the effects project. When the engine exposes a save command
   * the round trip saves it, which is what makes the returned `projectPath`
   * reopenable by "Open in effects".
   */
  projectPath?: string | null;
  /** Task workspace the project path is relative to, when it is not absolute. */
  workspace?: string;
  /** Effects command catalog (ids from commands()). */
  effectsCatalog: readonly string[];
  /** Loam Video command catalog (ids from commands()). */
  filmCatalog: readonly string[];
}

/**
 * Build the full round-trip command sequence. Refuses (never guesses) when the
 * selected clip cannot be found or either engine lacks a command the sequence
 * needs, so the caller gets an actionable message instead of a silent no-op.
 */
export function planRoundTrip(input: PlanRoundTripInput): RoundTripPlan | RoundTripPlanError {
  const clip = selectClip(input.state, input.clipId ?? null, toSeconds(input.atSec ?? null));
  if (!clip) {
    const wanted = input.clipId ? `clip "${input.clipId}"` : `a clip at ${String(input.atSec ?? "?")}`;
    return {
      error: `no Loam Video clip matches ${wanted} in the current project; read the state action first`,
    };
  }

  const askId = resolveAskId(input.effectsCatalog, input.kind);
  if (!askId) {
    return {
      error:
        `the Loam Effects engine does not expose a command for "${input.kind}" ` +
        `(looked for: ${ASK_EFFECT_MAP[input.kind].join(", ")}).` +
        ` Available effects commands: ${describeCatalog(input.effectsCatalog)}.`,
    };
  }

  const readFileId = resolveCommandId(input.effectsCatalog, ROUND_TRIP_COMMAND_CANDIDATES.readFile);
  const renderId = resolveCommandId(input.effectsCatalog, ROUND_TRIP_COMMAND_CANDIDATES.render);
  // The replace command lives on the Loam Video side, so it must come from the
  // film catalog, never the effects one.
  const replaceId = resolveCommandId(input.filmCatalog, ROUND_TRIP_COMMAND_CANDIDATES.replaceRange);
  const importId = resolveCommandId(input.filmCatalog, ROUND_TRIP_COMMAND_CANDIDATES.importFiles);
  if (!readFileId || !renderId || !replaceId || !importId) {
    const missing = [
      !readFileId ? "readFile" : null,
      !renderId ? "renderQueue.render" : null,
      !replaceId ? "timeline.replaceRange" : null,
      !importId ? "importFiles" : null,
    ].filter((entry): entry is string => entry !== null);
    return {
      error:
        `the Loam Video / Loam Effects engines cannot run this round trip: missing ` +
        `${missing.join(", ")}.` +
        ` Effects commands: ${describeCatalog(input.effectsCatalog)}.` +
        ` Loam Video commands: ${describeCatalog(input.filmCatalog)}.`,
    };
  }

  const compositionId = resolveCommandId(input.effectsCatalog, ROUND_TRIP_COMMAND_CANDIDATES.newComposition);
  // The project is saved mid-sequence so the returned path points at a file that
  // actually holds the applied effect; without a clip there is no stable name.
  const projectPath = effectsProjectPathFor(clip, input.workspace) ?? input.projectPath ?? null;
  const userParams =
    input.params && typeof input.params === "object" && !Array.isArray(input.params)
      ? (input.params as Record<string, unknown>)
      : {};

  const steps: RoundTripStep[] = [
    // 1. Effects: take the clip's source media plus its in/out points.
    {
      target: "effects",
      method: "addFile",
      params: { path: clip.source, inSec: clip.inSec, outSec: clip.outSec },
    },
  ];

  // 2. Effects: build a composition that matches the clip when the engine
  //    exposes one (older builds infer it from the imported media).
  if (compositionId) {
    steps.push({
      target: "effects",
      method: "execute",
      params: {
        command: compositionId,
        params: {
          width: clip.width ?? 1920,
          height: clip.height ?? 1080,
          fps: clip.fps ?? 30,
          durationSec: Math.max(0.001, clip.endSec - clip.startSec),
        },
      },
    });
  }

  // 3. Effects: apply the requested transition / effect / text animation.
  steps.push({
    target: "effects",
    method: "execute",
    params: { command: askId, params: userParams },
  });

  // 4. Effects: save the project so the .ecproj the caller links to actually
  //    holds the applied effect, which is what "Open in effects" reopens. An
  //    engine with no save command still round-trips; only the reopen link is
  //    lost.
  const saveId = resolveCommandId(input.effectsCatalog, ROUND_TRIP_COMMAND_CANDIDATES.saveProject);
  if (saveId && projectPath) {
    steps.push({
      target: "effects",
      method: "execute",
      params: { command: saveId, params: { path: projectPath } },
    });
  }

  // 5. Effects: render through the queue and read the output back.
  steps.push({
    target: "effects",
    method: "execute",
    params: { command: renderId, params: { format: "mp4" } },
  });
  steps.push({ target: "effects", method: readFileId, params: {} });

  // 6. Loam Video: bring the rendered file in and replace the original range on
  //    the same track, so neighbouring clips keep their positions.
  steps.push({ target: "film", method: importId, params: {} });
  steps.push({
    target: "film",
    method: "execute",
    params: {
      command: replaceId,
      params: {
        clipId: clip.id,
        trackId: clip.trackId ?? null,
        fromSec: clip.startSec,
        toSec: clip.endSec,
      },
    },
  });

  return { clip, projectPath, steps };
}

/** True when a plan or step sequence is the error variant. */
export function isRoundTripPlanError(
  value: RoundTripPlan | RoundTripStep[] | RoundTripPlanError,
): value is RoundTripPlanError {
  return "error" in value;
}

function describeCatalog(catalog: readonly string[]): string {
  return catalog.length > 0 ? catalog.slice(0, 40).join(", ") : "(engine returned no command list)";
}

// ---------------------------------------------------------------------------
// Executing the round trip over the relay
// ---------------------------------------------------------------------------

/** Minimal relay surface the round trip needs (satisfied by both hosts). */
export interface RoundTripRelay {
  enqueue(
    taskId: string,
    target: "film" | "effects",
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface RoundTripResult {
  ok: boolean;
  clipId: string;
  /** The rendered file the effects engine produced, when it got that far. */
  outputPath?: string;
  steps: Array<{ target: string; method: string; ok: boolean; result?: unknown; code?: string }>;
  error?: string;
}

/**
 * Run a planned round trip through the relay, one step at a time. Stops at the
 * first failure and reports the step that failed, so the caller can tell an
 * engine refusal (COMMAND_REJECTED) from an unreachable engine.
 */
export async function runRoundTrip(
  relay: RoundTripRelay,
  taskId: string,
  plan: RoundTripPlan,
): Promise<RoundTripResult> {
  const steps: RoundTripResult["steps"] = [];
  let outputPath: string | undefined;
  for (const step of plan.steps) {
    try {
      const value = await relay.enqueue(taskId, step.target, step.method, step.params);
      if (step.target === "effects" && step.method !== "execute") {
        const rec = asRecord(value);
        const path = rec && typeof rec.path === "string" ? rec.path : typeof value === "string" ? value : undefined;
        if (path) outputPath = path;
      }
      steps.push({ target: step.target, method: step.method, ok: true, result: value });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Keep the relay's own error code (COMMAND_REJECTED / PANEL_NOT_OPEN /
      // ...): the caller maps it to the tool's error envelope, so dropping it
      // would report an unreachable panel as an engine refusal.
      const code = (err as { code?: unknown } | null)?.code;
      steps.push({
        target: step.target,
        method: step.method,
        ok: false,
        code: typeof code === "string" ? code : undefined,
      });
      return { ok: false, clipId: plan.clip.id, outputPath, steps, error: detail };
    }
  }
  return { ok: true, clipId: plan.clip.id, outputPath, steps };
}

/**
 * Map a failed round trip to the same structured envelope the `video_studio`
 * tool uses, so the agent sees one consistent contract.
 */
export function roundTripErrorResult(
  err: unknown,
  clipId?: string,
): { ok: false; reason: string; message: string; clipId?: string } {
  const code = (err as { code?: unknown } | null)?.code;
  const detail = err instanceof Error ? err.message : String(err);
  if (code === "COMMAND_REJECTED") {
    return {
      ok: false,
      reason: "command_rejected",
      message: `The effects round trip was refused (${detail}).`,
      clipId,
    };
  }
  if (code === "PANEL_NOT_OPEN") {
    return {
      ok: false,
      reason: "panel_not_open",
      message: "No Loam Video panel is attached to this task yet.",
      clipId,
    };
  }
  return {
    ok: false,
    reason: "bridge_unavailable",
    message: `The effects round trip did not finish (${detail}).`,
    clipId,
  };
}

// ---------------------------------------------------------------------------
// Reopening a stored project ("Open in effects")
// ---------------------------------------------------------------------------

/**
 * Steps that reopen a previously saved `.ecproj` in the effects engine so the
 * user can keep editing it from the panel. The project path is stored in the
 * task's files, so a later "Open in effects" can bring it back.
 */
export function planReopenEffects(projectPath: string): RoundTripStep[] {
  return [
    { target: "effects", method: "openProject", params: { path: projectPath } },
    { target: "effects", method: "inspect", params: {} },
  ];
}

/**
 * Steps that send a rendered project back to Loam Video and replace the original
 * range, used when the user finishes in the effects panel.
 */
export function planReturnToFilm(
  projectPath: string,
  state: FilmState,
  filmCatalog: readonly string[],
  clipId?: string | null,
): RoundTripStep[] | RoundTripPlanError {
  const replaceId = resolveCommandId(filmCatalog, ROUND_TRIP_COMMAND_CANDIDATES.replaceRange);
  if (!replaceId) {
    return {
      error: `the Loam Video editor does not expose ${ROUND_TRIP_COMMAND_CANDIDATES.replaceRange.join(" or ")}`,
    };
  }
  // The panel may be acting on the selection or on a clip the agent named, so
  // resolve it the same way the round trip does rather than trusting a caller's
  // guess about which clip to put back.
  const clip = selectClip(state, clipId ?? null, null) ?? selectPanelClip(state);
  if (!clip) {
    return { error: "no Loam Video clip is selected to return to the timeline" };
  }
  return [
    { target: "effects", method: "readFile", params: { path: projectPath } },
    {
      target: "film",
      method: "execute",
      params: {
        command: replaceId,
        params: {
          clipId: clip.id,
          trackId: clip.trackId ?? null,
          fromSec: clip.startSec,
          toSec: clip.endSec,
        },
      },
    },
  ];
}

/** Read the project path the effects engine currently holds, when it reports one. */
export function readEffectsProjectPath(value: unknown): string | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  for (const key of ["projectPath", "path", "file", "project"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * The `.ecproj` name for a clip, stable enough to reuse across round trips.
 *
 * Returns null when the clip is unknown: a nameless project would be saved and
 * then linked to a path that cannot be resolved again, which is worse than
 * reporting that there is no clip to reopen.
 */
export function effectsProjectPathFor(clip: FilmClip | null, workspace?: string): string | null {
  if (!clip) return null;
  const base = clip.source.split(/[\\/]/).pop() ?? clip.id;
  const stem = base.replace(/\.[^.]+$/, "") || clip.id;
  const prefix = workspace ? `${workspace.replace(/[\\/]+$/, "")}/` : "";
  return `${prefix}effects/${stem}.ecproj`;
}
