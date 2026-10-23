/**
 * Unit tests for the effects round-trip planner
 * (packages/shared/src/effectsRoundTrip.ts).
 *
 * The planner is pure data + pure functions: it turns a Loam Video clip plus an
 * ask into a flat list of relay steps, and refuses (never guesses) when the
 * clip is missing or an engine lacks a command. These tests drive it with the
 * real pure code and mock only the relay that carries the steps out, so they
 * never touch the editors, the network or a task stream.
 *
 * The same planner runs on the Node side (the `video_studio` tool) and in the
 * browser panel, so a failure here is a product-wide failure, not a local one.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import {
  ASK_EFFECT_MAP,
  effectsProjectPathFor,
  isRoundTripPlanError,
  parseFilmState,
  planReopenEffects,
  planReturnToFilm,
  planRoundTrip,
  readEffectsProjectPath,
  resolveAskId,
  ROUND_TRIP_COMMAND_CANDIDATES,
  roundTripErrorResult,
  runRoundTrip,
  selectClip,
  selectPanelClip,
  toSeconds,
  type FilmClip,
  type FilmState,
  type RoundTripRelay,
  type RoundTripStep,
} from "../../../packages/shared/src/effectsRoundTrip.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Loam Video catalog: enough for the round trip's replace + import steps. */
const FILM_CATALOG = [
  "file.newProject",
  "importFiles",
  "timeline.replaceRange",
  "export",
];

/** Effects catalog: composition, the three asks, render, read and save. */
const EFFECTS_CATALOG = [
  "composition.new",
  "project.save",
  "transition.fade",
  "effect.blur",
  "text.animateIn",
  "renderQueue.render",
  "readFile",
];

/** A two-clip timeline; the round trip targets the second clip. */
const FILM_STATE: FilmState = {
  playheadSec: 30,
  selectedClipId: "clip_b",
  sequences: [
    {
      id: "v1",
      clips: [
        { id: "clip_a", source: "C:\\task\\intro.mp4", startSec: 0, endSec: 10, inSec: 0, outSec: 10 },
        {
          id: "clip_b",
          source: "C:\\task\\main.mp4",
          startSec: 10,
          endSec: 50,
          inSec: 2,
          outSec: 42,
          fps: 25,
          width: 1920,
          height: 1080,
        },
      ],
    },
  ],
};

const CLIP_B = FILM_STATE.sequences[0]!.clips[1]!;

interface Recorded {
  target: string;
  method: string;
  params: Record<string, unknown>;
}

/** Relay stub: records every step and answers readFile with a render path. */
class Relay implements RoundTripRelay {
  readonly calls: Recorded[] = [];
  failAt: { target: string; method: string; code: string; message: string } | null = null;

  async enqueue(
    taskId: string,
    target: "film" | "effects",
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    assert.equal(taskId, "task_1");
    this.calls.push({ target, method, params });
    if (this.failAt && this.failAt.target === target && this.failAt.method === method) {
      throw Object.assign(new Error(this.failAt.message), { code: this.failAt.code });
    }
    if (method === "readFile") return { path: "C:\\task\\effects\\main-render.mp4" };
    return { ok: true };
  }
}

/** Plan a transition round trip on clip_b. */
function plan(kind: "transition" | "effect" | "animate_text" = "transition") {
  return planRoundTrip({
    state: FILM_STATE,
    clipId: "clip_b",
    kind,
    effectsCatalog: EFFECTS_CATALOG,
    filmCatalog: FILM_CATALOG,
    projectPath: "effects/main.ecproj",
  });
}

// ---------------------------------------------------------------------------
// Ask -> command id mapping
// ---------------------------------------------------------------------------

describe("effects round trip: ask mapping", () => {
  it("resolves each ask to the first catalog id the engine exposes", () => {
    assert.equal(resolveAskId(EFFECTS_CATALOG, "transition"), "transition.fade");
    assert.equal(resolveAskId(EFFECTS_CATALOG, "effect"), "effect.blur");
    assert.equal(resolveAskId(EFFECTS_CATALOG, "animate_text"), "text.animateIn");
  });

  it("skips an id the engine does not expose and takes the next candidate", () => {
    // A build that renamed the fade command must still find the dissolve one
    // rather than refusing the ask outright.
    const renamed = EFFECTS_CATALOG.filter((id) => id !== "transition.fade").concat("transition.dissolve");
    assert.equal(resolveAskId(renamed, "transition"), "transition.dissolve");
  });

  it("returns null when the engine lacks the ask entirely", () => {
    assert.equal(resolveAskId(["renderQueue.render", "readFile"], "transition"), null);
  });

  it("keeps every ask's candidate list auditable in code", () => {
    // The mapping is the contract with the engine: it must stay explicit and
    // non-empty, and the order is the preference order.
    for (const kind of ["transition", "effect", "animate_text"] as const) {
      const candidates = ASK_EFFECT_MAP[kind];
      assert.ok(candidates.length > 0, `${kind} must list candidates`);
      assert.equal(new Set(candidates).size, candidates.length, `${kind} candidates must be unique`);
    }
  });
});

// ---------------------------------------------------------------------------
// Reading the clip out of the state
// ---------------------------------------------------------------------------

describe("effects round trip: clip selection", () => {
  it("selects by clip id and inherits the track it sits on", () => {
    const clip = selectClip(FILM_STATE, "clip_b", null);
    assert.equal(clip?.id, "clip_b");
    assert.equal(clip?.trackId, "v1");
  });

  it("refuses a clip id that is not on the timeline", () => {
    // A mistyped id must not silently fall through to the playhead: the round
    // trip overwrites the clip's range in place, so a wrong target is data loss.
    assert.equal(selectClip(FILM_STATE, "clip_zzz", null), null);
  });

  it("falls back to the clip under a time when no id is given", () => {
    assert.equal(selectClip(FILM_STATE, null, 30)?.id, "clip_b");
    assert.equal(selectClip(FILM_STATE, null, 5)?.id, "clip_a");
  });

  it("refuses a time that is not inside any clip", () => {
    assert.equal(selectClip(FILM_STATE, null, 999), null);
  });

  it("prefers the selection over the playhead for a panel action", () => {
    assert.equal(selectPanelClip(FILM_STATE)?.id, "clip_b");
    // With no selection the playhead decides.
    const noSelection: FilmState = { ...FILM_STATE, selectedClipId: undefined };
    assert.equal(selectPanelClip(noSelection)?.id, "clip_b");
    const playhead5: FilmState = { ...FILM_STATE, selectedClipId: undefined, playheadSec: 5 };
    assert.equal(selectPanelClip(playhead5)?.id, "clip_a");
  });
});

describe("effects round trip: state parsing", () => {
  it("reads a nested clip entry and its source media", () => {
    const state = parseFilmState({
      sequences: [
        {
          id: "v1",
          clips: [
            {
              id: "clip_x",
              clip: { id: "clip_x", source: "C:\\task\\a.mp4" },
              startSec: 4,
              endSec: 12,
              inSec: 1,
              outSec: 9,
            },
          ],
        },
      ],
      playheadSec: 6,
    });
    const clip = state.sequences[0]!.clips[0]!;
    assert.equal(clip.id, "clip_x");
    assert.equal(clip.source, "C:\\task\\a.mp4");
    assert.equal(clip.startSec, 4);
    assert.equal(clip.endSec, 12);
    assert.equal(clip.inSec, 1);
    assert.equal(clip.outSec, 9);
    assert.equal(clip.trackId, "v1");
    assert.equal(state.playheadSec, 6);
  });

  it("reads the selection from several shapes editors report it in", () => {
    assert.equal(parseFilmState({ sequences: [], selectedClipId: "c1" }).selectedClipId, "c1");
    assert.equal(parseFilmState({ sequences: [], selection: { clipId: "c2" } }).selectedClipId, "c2");
    assert.equal(parseFilmState({ sequences: [], selection: "c3" }).selectedClipId, "c3");
    assert.equal(parseFilmState({ sequences: [] }).selectedClipId, undefined);
  });

  it("accepts a flat clip list by giving it a synthetic track", () => {
    const state = parseFilmState({
      tracks: [{ clips: [{ id: "flat_1", source: "a.mp4", startSec: 0, endSec: 5 }] }],
    });
    const clip = state.sequences[0]!.clips[0]!;
    assert.equal(clip.id, "flat_1");
    assert.equal(clip.trackId, "track_0");
  });

  it("tolerates timecode strings in the inspect() result", () => {
    const state = parseFilmState({
      sequences: [{ id: "v1", clips: [{ id: "c", source: "a.mp4", startSec: "0:05", endSec: "0:10" }] }],
    });
    assert.equal(state.sequences[0]!.clips[0]!.startSec, 5);
    assert.equal(state.sequences[0]!.clips[0]!.endSec, 10);
  });
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

describe("effects round trip: planning", () => {
  it("builds the full sequence: effects in, film replace out", () => {
    const result = plan();
    assert.ok(!isRoundTripPlanError(result));
    const targets = result.steps.map((s) => `${s.target}:${s.method}`);
    assert.deepEqual(targets, [
      "effects:addFile",
      "effects:execute", // composition.new
      "effects:execute", // transition.fade
      "effects:execute", // project.save
      "effects:execute", // renderQueue.render
      "effects:readFile",
      "film:importFiles",
      "film:execute", // timeline.replaceRange
    ]);
  });

  it("hands the clip's source media and in/out to the effects engine", () => {
    const result = plan();
    assert.ok(!isRoundTripPlanError(result));
    const addFile = result.steps[0]!;
    assert.deepEqual(addFile.params, { path: CLIP_B.source, inSec: 2, outSec: 42 });
  });

  it("matches the composition to the clip's size, fps and duration", () => {
    const result = plan();
    assert.ok(!isRoundTripPlanError(result));
    const comp = result.steps[1]!;
    assert.deepEqual(comp.params, {
      command: "composition.new",
      params: { width: 1920, height: 1080, fps: 25, durationSec: 40 },
    });
  });

  it("forwards the user's params to the resolved ask command", () => {
    const result = planRoundTrip({
      state: FILM_STATE,
      clipId: "clip_b",
      kind: "effect",
      params: { amount: 12 },
      effectsCatalog: EFFECTS_CATALOG,
      filmCatalog: FILM_CATALOG,
    });
    assert.ok(!isRoundTripPlanError(result));
    const ask = result.steps.find((s) => s.method === "execute" && s.params.command === "effect.blur");
    assert.deepEqual(ask?.params, { command: "effect.blur", params: { amount: 12 } });
  });

  it("omits the composition step when the engine has no such command", () => {
    const result = planRoundTrip({
      state: FILM_STATE,
      clipId: "clip_b",
      kind: "transition",
      effectsCatalog: EFFECTS_CATALOG.filter((id) => id !== "composition.new"),
      filmCatalog: FILM_CATALOG,
    });
    assert.ok(!isRoundTripPlanError(result));
    assert.equal(result.steps.filter((s) => s.params.command === "composition.new").length, 0);
  });

  it("saves the project under a path derived from the clip", () => {
    const result = planRoundTrip({
      state: FILM_STATE,
      clipId: "clip_b",
      kind: "transition",
      effectsCatalog: EFFECTS_CATALOG,
      filmCatalog: FILM_CATALOG,
    });
    assert.ok(!isRoundTripPlanError(result));
    // The path is derived, not supplied, so the file that is saved and the
    // path that is returned are the same by construction.
    assert.equal(result.projectPath, "effects/main.ecproj");
    const save = result.steps.find((s) => s.params.command === "project.save");
    assert.deepEqual(save?.params, { command: "project.save", params: { path: "effects/main.ecproj" } });
  });

  it("omits the save step when the engine has no save command", () => {
    const result = planRoundTrip({
      state: FILM_STATE,
      clipId: "clip_b",
      kind: "transition",
      effectsCatalog: EFFECTS_CATALOG.filter((id) => id !== "project.save"),
      filmCatalog: FILM_CATALOG,
    });
    assert.ok(!isRoundTripPlanError(result));
    // An engine that cannot save still round-trips; only the reopen link is lost.
    assert.equal(result.steps.filter((s) => s.params.command === "project.save").length, 0);
  });

  it("replaces the original range on the clip's own track", () => {
    const result = plan();
    assert.ok(!isRoundTripPlanError(result));
    const replace = result.steps.at(-1)!;
    assert.deepEqual(replace.params, {
      command: "timeline.replaceRange",
      params: { clipId: "clip_b", trackId: "v1", fromSec: 10, toSec: 50 },
    });
  });

  it("refuses when the named clip is not on the timeline", () => {
    const result = planRoundTrip({
      state: FILM_STATE,
      clipId: "nope",
      kind: "transition",
      effectsCatalog: EFFECTS_CATALOG,
      filmCatalog: FILM_CATALOG,
    });
    assert.ok(isRoundTripPlanError(result));
    assert.match(result.error, /no Loam Video clip matches clip "nope"/);
  });

  it("refuses when the effects engine lacks the ask, naming what it looked for", () => {
    const result = planRoundTrip({
      state: FILM_STATE,
      clipId: "clip_b",
      kind: "transition",
      effectsCatalog: ["renderQueue.render", "readFile"],
      filmCatalog: FILM_CATALOG,
    });
    assert.ok(isRoundTripPlanError(result));
    assert.match(result.error, /does not expose a command for "transition"/);
    assert.match(result.error, /transition\.fade/);
  });

  it("refuses when the film side lacks the replace command", () => {
    // The replace command lives on the Loam Video side, so an effects-only
    // catalog must not be able to satisfy it.
    const result = planRoundTrip({
      state: FILM_STATE,
      clipId: "clip_b",
      kind: "transition",
      effectsCatalog: EFFECTS_CATALOG,
      filmCatalog: ["file.newProject", "export"],
    });
    assert.ok(isRoundTripPlanError(result));
    assert.match(result.error, /missing timeline\.replaceRange/);
  });

  it("reports every missing command, not just the first", () => {
    // The ask must be resolvable first, or the planner reports the ask and
    // never reaches the engine commands the sequence needs.
    const result = planRoundTrip({
      state: FILM_STATE,
      clipId: "clip_b",
      kind: "transition",
      effectsCatalog: ["transition.fade"],
      filmCatalog: [],
    });
    assert.ok(isRoundTripPlanError(result));
    assert.match(result.error, /readFile/);
    assert.match(result.error, /renderQueue\.render/);
    assert.match(result.error, /timeline\.replaceRange/);
    assert.match(result.error, /importFiles/);
  });
});

// ---------------------------------------------------------------------------
// Executing over the relay
// ---------------------------------------------------------------------------

describe("effects round trip: execution", () => {
  it("runs every step in order and reports success", async () => {
    const relay = new Relay();
    const result = plan();
    assert.ok(!isRoundTripPlanError(result));
    const outcome = await runRoundTrip(relay, "task_1", result);
    assert.equal(outcome.ok, true);
    assert.equal(relay.calls.length, result.steps.length);
    assert.equal(outcome.clipId, "clip_b");
    // The rendered file is read back from the effects engine's readFile step.
    assert.equal(outcome.outputPath, "C:\\task\\effects\\main-render.mp4");
  });

  it("stops at the first failure and keeps the relay's error code", async () => {
    const relay = new Relay();
    relay.failAt = { target: "effects", method: "readFile", code: "COMMAND_REJECTED", message: "no render" };
    const result = plan();
    assert.ok(!isRoundTripPlanError(result));
    const outcome = await runRoundTrip(relay, "task_1", result);
    assert.equal(outcome.ok, false);
    const failed = outcome.steps.find((s) => !s.ok);
    assert.equal(failed?.code, "COMMAND_REJECTED");
    // Steps after the failure never run.
    assert.equal(relay.calls.length, result.steps.indexOf(result.steps.find((s) => s.method === "readFile")!) + 1);
  });

  it("maps the relay codes to the tool's structured envelope", () => {
    const rejected = roundTripErrorResult(
      Object.assign(new Error("nope"), { code: "COMMAND_REJECTED" }),
      "clip_b",
    );
    assert.equal(rejected.reason, "command_rejected");
    assert.equal(rejected.clipId, "clip_b");

    const panel = roundTripErrorResult(Object.assign(new Error("none"), { code: "PANEL_NOT_OPEN" }));
    assert.equal(panel.reason, "panel_not_open");
    // An unreachable panel is not an engine refusal.
    assert.notEqual(panel.reason, "command_rejected");

    const other = roundTripErrorResult(new Error("socket closed"));
    assert.equal(other.reason, "bridge_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Reopening a stored project ("Open in effects")
// ---------------------------------------------------------------------------

describe("effects round trip: reopen", () => {
  it("plans openProject then inspect for a stored project", () => {
    assert.deepEqual(planReopenEffects("effects/main.ecproj"), [
      { target: "effects", method: "openProject", params: { path: "effects/main.ecproj" } },
      { target: "effects", method: "inspect", params: {} },
    ]);
  });

  it("plans a return that reads the render and replaces the range", () => {
    const steps = planReturnToFilm("effects/main.ecproj", FILM_STATE, FILM_CATALOG);
    assert.ok(!isRoundTripPlanError(steps));
    assert.deepEqual(steps[0], { target: "effects", method: "readFile", params: { path: "effects/main.ecproj" } });
    // The return carries the same replace the forward trip uses, plus the
    // original range so the engine replaces exactly the clip's span.
    assert.deepEqual(steps[1], {
      target: "film",
      method: "execute",
      params: {
        command: "timeline.replaceRange",
        params: { clipId: "clip_b", trackId: "v1", fromSec: 10, toSec: 50 },
      },
    });
  });

  it("refuses a return when the film side cannot replace the range", () => {
    const steps = planReturnToFilm("effects/main.ecproj", FILM_STATE, ["file.newProject"]);
    assert.ok(isRoundTripPlanError(steps));
    assert.match(steps.error, /does not expose/);
  });

  it("refuses a return when no clip is selected", () => {
    const empty: FilmState = { ...FILM_STATE, selectedClipId: undefined, playheadSec: 999 };
    const steps = planReturnToFilm("effects/main.ecproj", empty, FILM_CATALOG);
    assert.ok(isRoundTripPlanError(steps));
    assert.match(steps.error, /no Loam Video clip is selected/);
  });

  it("reads the project path from the engine's inspect() result", () => {
    assert.equal(readEffectsProjectPath({ projectPath: "a.ecproj" }), "a.ecproj");
    assert.equal(readEffectsProjectPath({ path: "b.ecproj" }), "b.ecproj");
    assert.equal(readEffectsProjectPath("c.ecproj"), undefined);
    assert.equal(readEffectsProjectPath(null), undefined);
  });

  it("derives a stable .ecproj path from the clip's source", () => {
    assert.equal(effectsProjectPathFor(CLIP_B), "effects/main.ecproj");
    assert.equal(effectsProjectPathFor(CLIP_B, "C:\\task"), "C:\\task/effects/main.ecproj");
    assert.equal(effectsProjectPathFor(CLIP_B, "C:\\task\\"), "C:\\task/effects/main.ecproj");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("effects round trip: helpers", () => {
  it("parses seconds and timecode the way the agent tools do", () => {
    assert.equal(toSeconds(90), 90);
    assert.equal(toSeconds("1:30"), 90);
    assert.equal(toSeconds("2 min"), 120);
    assert.equal(toSeconds("1.5 sec"), 1.5);
    assert.equal(toSeconds("nope"), null);
    assert.equal(toSeconds(undefined), null);
  });

  it("keeps the round-trip command candidates explicit", () => {
    // These are the engine ids the planner resolves against; keeping them in one
    // auditable table is what lets a renamed engine command degrade to a message.
    assert.ok(ROUND_TRIP_COMMAND_CANDIDATES.replaceRange.includes("timeline.replaceRange"));
    assert.ok(ROUND_TRIP_COMMAND_CANDIDATES.render.includes("renderQueue.render"));
    assert.ok(ROUND_TRIP_COMMAND_CANDIDATES.readFile.includes("readFile"));
    assert.ok(ROUND_TRIP_COMMAND_CANDIDATES.saveProject.length > 0);
  });

  it("types a plan error distinctly from a plan", () => {
    const ok = plan();
    assert.equal(isRoundTripPlanError(ok), false);
    const bad = planRoundTrip({
      state: FILM_STATE,
      clipId: "missing",
      kind: "transition",
      effectsCatalog: EFFECTS_CATALOG,
      filmCatalog: FILM_CATALOG,
    });
    assert.equal(isRoundTripPlanError(bad), true);
  });
});

// A clip-shaped literal keeps the fixtures honest about the interface.
const _clipShape: FilmClip = CLIP_B;
void _clipShape;
const _stepShape: RoundTripStep = { target: "effects", method: "addFile", params: {} };
void _stepShape;
