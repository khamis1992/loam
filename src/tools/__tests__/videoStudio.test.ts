/**
 * Unit tests for the `video_studio` agent tool (src/tools/videoStudio.ts).
 *
 * The relay is mocked, so these tests never touch the editor, the network or a
 * real task stream: they assert the exact command sequence each action produces
 * and the fallback path when the Loam Video dist is missing.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { ToolContext } from "../../tools/registry.js";
import type { VideoStudioRelayLike, VideoStudioStep } from "../../tools/videoStudio.js";

interface Dispatched {
  taskId: string;
  target: string;
  method: string;
  params: Record<string, unknown>;
}

/** Raw `inspect` payload the mock editor answers with (fc-05 state read). */
const EMPTY_PROJECT = { sequences: [{ id: "seq1", tracks: [], clips: [] }], playheadSec: 0 };

/** In-memory relay: records every dispatch and answers from a command catalog. */
class MockRelay implements VideoStudioRelayLike {
  readonly dispatched: Dispatched[] = [];
  commands: unknown = [];
  failWith: { code: string; message: string } | null = null;
  /** When set, every `inspect` returns this payload (defaults to an empty timeline). */
  project: unknown = EMPTY_PROJECT;

  async enqueue(taskId: string, target: "film" | "effects", method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.dispatched.push({ taskId, target, method, params });
    if (this.failWith) throw Object.assign(new Error(this.failWith.message), { code: this.failWith.code });
    if (method === "commands") return this.commands;
    if (method === "inspect") return this.project;
    if (method === "importFiles") return { imported: 1 };
    if (method === "importUrl") return { imported: 1 };
    return { ok: true };
  }
}

let root = "";
let ws = "";
let relay: MockRelay | RoundTripRelay;

const CATALOG = [
  "file.newProject",
  "file.newSequence",
  "timeline.razor",
  "timeline.trim",
  "timeline.delete",
  "timeline.split",
  "sequence.move",
  "sequence.reorder",
  "clip.speed",
  "graphics.addText",
  "audio.add",
  "sequence.applyVideoTransition",
  "effects.apply",
  "edit.undo",
  "export",
];

const { createVideoStudioTools, isFilmcraftDistInstalled, closeMatches, resolveCommandId, toCommandIdList, toSeconds, toSecondsArray } = await import(
  "../../tools/videoStudio.js"
);

const { VideoStudioRouter } = await import("../../tools/videoStudioRouter.js");

function ctx(): ToolContext {
  return { cfg: {} as never, workspace: ws, emit: () => undefined, taskId: "task_1" } as never;
}

function tool(): ReturnType<typeof createVideoStudioTools>[number] {
  return createVideoStudioTools({ relay, root })[0]!;
}

function allDispatched(): VideoStudioStep[] {
  return relay.dispatched.map((d) => ({ method: d.method as VideoStudioStep["method"], params: d.params }));
}

/** Work steps only: the catalog read that precedes every execute is filtered out. */
function commandsDispatched(): VideoStudioStep[] {
  return allDispatched().filter((s) => s.method !== "commands" && s.method !== "inspect");
}

function lastExecuteCommand(): { command: string; params: Record<string, unknown> } {
  const step = commandsDispatched().at(-1)!;
  return step.params as { command: string; params: Record<string, unknown> };
}

/**
 * Relay that answers the whole export flow: a catalog with the real export id,
 * an execute result carrying the produced path, a finished job and the bytes.
 */
class ExportMockRelay extends MockRelay {
  readFileValue: unknown = Buffer.from("fake-mp4-bytes");

  override async enqueue(
    taskId: string,
    target: "film" | "effects",
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    this.dispatched.push({ taskId, target, method, params });
    if (this.failWith) throw Object.assign(new Error(this.failWith.message), { code: this.failWith.code });
    if (method === "commands") return this.commands;
    if (method === "readFile") return this.readFileValue;
    if (method === "execute") {
      const command = (params as { command?: string }).command;
      if (command === "jobs.poll") return { job: { status: "done", progress: 1, path: "/exports/loam-cut.mp4" } };
      return { path: "/exports/loam-cut.mp4", job: { status: "done", progress: 1 } };
    }
    return { ok: true };
  }
}

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("video_studio availability + fallback", () => {
  it("reports the dist as missing when index.html is absent", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-root-"));
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-ws-"));
    assert.equal(isFilmcraftDistInstalled(root), false);
    relay = new MockRelay();
    const res = await tool().run({ action: "state" }, ctx());
    assert.equal(res.ok, false);
    const parsed = JSON.parse(res.content) as { fallback: string; reason: string };
    assert.equal(parsed.fallback, "video_edit");
    assert.equal(parsed.reason, "loam_video_dist_missing");
    // The fallback must not dispatch anything to the panel.
    assert.deepEqual(relay.dispatched, []);
  });

  it("reports the routing decision even when the call fails before any command runs", async () => {
    // The tool description promises "Every result carries a `routing` object", and
    // the model reads it to say which engine was chosen. The early returns (missing
    // dist, panel not open, relay failure) used to drop it, so a failed call told
    // the user nothing about the engine.
    root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-root-"));
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-ws-"));
    relay = new MockRelay();

    const missing = JSON.parse((await tool().run({ action: "state" }, ctx())).content) as {
      routing?: { route: string; target: string; degraded: boolean; note: string };
    };
    assert.ok(missing.routing, "the dist-missing result must still carry routing");
    assert.equal(missing.routing!.route, "film");
    assert.equal(missing.routing!.target, "film");
    assert.equal(missing.routing!.degraded, false);
    assert.ok(missing.routing!.note.length > 0);

    // A panel that never attaches must also report the routing it chose.
    fs.mkdirSync(path.join(root, "electron", "filmcraft", "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "electron", "filmcraft", "dist", "index.html"), "<html></html>");
    relay = new MockRelay();
    relay.failWith = { code: "PANEL_NOT_OPEN", message: "no panel" };
    const panel = JSON.parse((await tool().run({ action: "cut", atSec: 5 }, ctx())).content) as {
      reason: string;
      routing?: { route: string; target: string; degraded: boolean };
    };
    assert.equal(panel.reason, "panel_not_open");
    assert.ok(panel.routing, "the panel_not_open result must still carry routing");
    assert.equal(panel.routing!.route, "film");
    assert.equal(panel.routing!.target, "film");
    assert.equal(panel.routing!.degraded, false);

    // And a degraded effects request must say so on the failure envelope too.
    relay = new MockRelay();
    relay.failWith = { code: "PANEL_NOT_OPEN", message: "no panel" };
    // Inject the router so the result does not depend on whether the effects
    // engine happens to be installed on the machine running the test.
    const noEffects = createVideoStudioTools({
      relay,
      root,
      router: new VideoStudioRouter({ root, effectsAvailable: false }),
    })[0]!;
    const degraded = JSON.parse(
      (await noEffects.run({ action: "effect_basic", name: "glitch" }, ctx())).content,
    ) as { routing?: { route: string; target: string; degraded: boolean; reason?: string } };
    assert.ok(degraded.routing, "a degraded request must report its routing even when it fails");
    assert.equal(degraded.routing!.route, "effects");
    assert.equal(degraded.routing!.target, "film");
    assert.equal(degraded.routing!.degraded, true);
    assert.equal(degraded.routing!.reason, "effects_backend_unavailable");
  });

  it("reports the dist as installed when index.html exists", () => {
    fs.mkdirSync(path.join(root, "electron", "filmcraft", "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "electron", "filmcraft", "dist", "index.html"), "<html></html>");
    assert.equal(isFilmcraftDistInstalled(root), true);
  });
});

describe("video_studio actions produce the expected command sequence", () => {
  it("open resolves the catalog and answers without guessing a command id", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run({ action: "open" }, ctx());
    assert.equal(res.ok, true, res.content);
    // The catalog read plus the fc-05 timeline read before and after it.
    assert.deepEqual(allDispatched().filter((s) => s.method === "commands"), [{ method: "commands", params: {} }]);
    assert.deepEqual(allDispatched().map((s) => s.method), ["inspect", "commands", "inspect"]);
    const parsed = JSON.parse(res.content) as { available: boolean; commands: unknown[] };
    assert.equal(parsed.available, true);
    assert.equal(parsed.commands.length, CATALOG.length);
  });

  it("state reads the project via inspect (no catalog needed)", async () => {
    relay = new MockRelay();
    const res = await tool().run({ action: "state" }, ctx());
    assert.equal(res.ok, true, res.content);
    // The tool reads the live timeline before acting, so `state` is one inspect.
    assert.deepEqual(allDispatched(), [{ method: "inspect", params: {} }]);
  });

  it("add_audio imports from a url then places it on the audio track", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run(
      { action: "add_audio", url: "https://example.com/track.mp3", atSec: 12, gain: 0.5, trackId: "a1" },
      ctx(),
    );
    const steps = commandsDispatched();
    assert.equal(steps[0]!.method, "importUrl");
    assert.deepEqual(steps[0]!.params, { url: "https://example.com/track.mp3" });
    assert.deepEqual(steps[1], {
      method: "execute",
      params: { command: "audio.add", params: { atSec: 12, gain: 0.5, trackId: "a1" } },
    });
  });

  it("add_audio refuses when neither url nor path is given", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run({ action: "add_audio" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /requires "url" or "path"/);
  });

  it("import dispatches importUrl for a url and importFiles for a task file", async () => {
    relay = new MockRelay();
    await tool().run({ action: "import", url: "https://example.com/clip.mp4" }, ctx());
    assert.deepEqual(commandsDispatched(), [{ method: "importUrl", params: { url: "https://example.com/clip.mp4" } }]);

    relay = new MockRelay();
    fs.writeFileSync(path.join(ws, "clip.mp4"), "video");
    await tool().run({ action: "import", path: "clip.mp4" }, ctx());
    assert.deepEqual(commandsDispatched(), [
      { method: "importFiles", params: { files: [path.join(ws, "clip.mp4")] } },
    ]);
  });

  it("import refuses a missing task file", async () => {
    relay = new MockRelay();
    const res = await tool().run({ action: "import", path: "nope.mp4" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /not found in the task workspace/);
    assert.deepEqual(commandsDispatched(), []);
  });

  it("cut resolves timeline.razor and accepts seconds and timecode", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run({ action: "cut", atSec: "0:30" }, ctx());
    assert.deepEqual(commandsDispatched(), [
      { method: "execute", params: { command: "timeline.razor", params: { atSec: 30 } } },
    ]);

    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run({ action: "cut", atSec: [1, 2.5, "00:00:04"] }, ctx());
    assert.deepEqual(commandsDispatched().map((s) => (s.params as { params: { atSec: number } }).params.atSec), [1, 2.5, 4]);
  });

  it("trim resolves timeline.trim from a range", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run({ action: "trim", fromSec: 10, toSec: "0:50" }, ctx());
    assert.deepEqual(commandsDispatched(), [
      { method: "execute", params: { command: "timeline.trim", params: { fromSec: 10, toSec: 50 } } },
    ]);
  });

  it("trim accepts the from/to time aliases as well as fromSec/toSec", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run({ action: "trim", from: "0:10", to: "1:30" }, ctx());
    assert.deepEqual(commandsDispatched(), [
      { method: "execute", params: { command: "timeline.trim", params: { fromSec: 10, toSec: 90 } } },
    ]);
  });

  it("cut and split accept the at alias for atSec", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run({ action: "cut", at: "0:05" }, ctx());
    await tool().run({ action: "split", at: 12 }, ctx());
    const steps = commandsDispatched();
    assert.deepEqual(steps[0], { method: "execute", params: { command: "timeline.razor", params: { atSec: 5 } } });
    assert.deepEqual(steps[1], { method: "execute", params: { command: "timeline.split", params: { atSec: 12 } } });
  });

  it("trim rejects an empty range", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run({ action: "trim", fromSec: 10, toSec: 5 }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /empty/);
  });

  it("delete passes ripple through when requested", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run({ action: "delete", fromSec: 20, toSec: 30, ripple: true }, ctx());
    assert.deepEqual(commandsDispatched(), [
      { method: "execute", params: { command: "timeline.delete", params: { fromSec: 20, toSec: 30, ripple: true } } },
    ]);
  });

  it("split resolves timeline.split", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run({ action: "split", atSec: 12 }, ctx());
    assert.deepEqual(commandsDispatched(), [
      { method: "execute", params: { command: "timeline.split", params: { atSec: 12 } } },
    ]);
  });

  it("move and reorder resolve sequence.move / sequence.reorder", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run({ action: "move", clipId: "clip_1", toIndex: 2 }, ctx());
    assert.deepEqual(commandsDispatched(), [
      { method: "execute", params: { command: "sequence.move", params: { clipId: "clip_1", toIndex: 2 } } },
    ]);

    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run({ action: "reorder", order: [2, 1, 3] }, ctx());
    assert.deepEqual(commandsDispatched(), [
      { method: "execute", params: { command: "sequence.reorder", params: { order: [2, 1, 3] } } },
    ]);
  });

  it("reorder refuses anything that is not a full 1-based permutation", async () => {
    // A permutation is exactly 1..n, each index once: a duplicate, a gap or a
    // 0-based list would silently reorder the wrong clips, so it is refused
    // before the command is sent.
    for (const order of [[1, 1, 2], [0, 1, 2], [1, 1], [1, 2, 4], [1.5, 2], "2,1"]) {
      relay = new MockRelay();
      relay.commands = CATALOG;
      const res = await tool().run({ action: "reorder", order }, ctx());
      assert.equal(res.ok, false, `order ${JSON.stringify(order)} should be refused`);
      assert.match(res.content, /permutation|requires order|must be integers/);
      assert.deepEqual(commandsDispatched(), [], `order ${JSON.stringify(order)} must not dispatch`);
    }
  });

  it("speed resolves clip.speed", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run({ action: "speed", clipId: "clip_1", rate: 2 }, ctx());
    assert.deepEqual(commandsDispatched(), [
      { method: "execute", params: { command: "clip.speed", params: { clipId: "clip_1", rate: 2 } } },
    ]);
  });

  it("add_text resolves graphics.addText with position/size/color/time range", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run(
      { action: "add_text", text: "Loam", atSec: 3, durationSec: "0:04", position: "bottom", size: 48, color: "#ffffff" },
      ctx(),
    );
    assert.deepEqual(commandsDispatched(), [
      {
        method: "execute",
        params: {
          command: "graphics.addText",
          params: { text: "Loam", atSec: 3, durationSec: 4, position: "bottom", size: 48, color: "#ffffff" },
        },
      },
    ]);
  });

  it("music imports the audio file then places it on the audio track", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    fs.writeFileSync(path.join(ws, "music.mp3"), "audio");
    await tool().run({ action: "music", path: "music.mp3", atSec: 0, gain: 0.8, fadeInSec: 1 }, ctx());
    const steps = commandsDispatched();
    assert.equal(steps[0]!.method, "importFiles");
    assert.deepEqual(steps[1], {
      method: "execute",
      params: { command: "audio.add", params: { atSec: 0, gain: 0.8, fadeInSec: 1 } },
    });
  });

  it("transition_basic resolves the FilmCraft-native video transition", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run({ action: "transition_basic", atSec: 5, type: "fade", durationSec: 1 }, ctx());
    assert.deepEqual(commandsDispatched(), [
      {
        method: "execute",
        params: { command: "sequence.applyVideoTransition", params: { atSec: 5, type: "fade", durationSec: 1 } },
      },
    ]);
  });

  it("effect_basic resolves effects.apply", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run({ action: "effect_basic", name: "blur", params: { amount: 12 } }, ctx());
    assert.deepEqual(commandsDispatched(), [
      { method: "execute", params: { command: "effects.apply", params: { name: "blur", amount: 12 } } },
    ]);
  });

  it("effect_basic keeps the positional name and drops a params.name override", async () => {
    // A free-form `params.name` would silently swap the effect the action was
    // asked to apply, so the positional `name` must win.
    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run({ action: "effect_basic", name: "glow", params: { intensity: 0.5, name: "OVERRIDE" } }, ctx());
    assert.deepEqual(commandsDispatched(), [
      { method: "execute", params: { command: "effects.apply", params: { name: "glow", intensity: 0.5 } } },
    ]);
  });

  it("undo resolves edit.undo", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run({ action: "undo" }, ctx());
    assert.deepEqual(commandsDispatched(), [
      { method: "execute", params: { command: "edit.undo", params: {} } },
    ]);
  });

  it("raw executes a catalog command id and forwards params", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    await tool().run({ action: "raw", command: "export", params: { format: "mp4" } }, ctx());
    assert.deepEqual(commandsDispatched(), [
      { method: "execute", params: { command: "export", params: { format: "mp4" } } },
    ]);
  });

  it("raw rejects an unknown command id with close matches", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run({ action: "raw", command: "timeline.razro" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /unknown Loam Video command "timeline\.razro"/);
    assert.match(res.content, /timeline\.razor/);
    assert.deepEqual(commandsDispatched(), []);
  });

  it("rejects an unknown action", async () => {
    relay = new MockRelay();
    const res = await tool().run({ action: "teleport" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /action must be one of/);
  });

  it("reports a clear message when the editor lacks a needed command", async () => {
    relay = new MockRelay();
    relay.commands = ["file.newProject", "export"];
    const res = await tool().run({ action: "cut", atSec: 5 }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /does not expose/);
    assert.match(res.content, /Available commands/);
  });

  it("reports PANEL_NOT_OPEN as a retry instead of a fallback", async () => {
    relay = new MockRelay();
    relay.failWith = { code: "PANEL_NOT_OPEN", message: "no panel" };
    const res = await tool().run({ action: "state" }, ctx());
    assert.equal(res.ok, false);
    const parsed = JSON.parse(res.content) as { retry: boolean; reason: string; fallback?: string };
    assert.equal(parsed.reason, "panel_not_open");
    assert.equal(parsed.retry, true);
    assert.equal(parsed.fallback, undefined);
  });

  it("falls back to video_edit when the bridge fails", async () => {
    relay = new MockRelay();
    relay.failWith = { code: "TIMEOUT", message: "timed out" };
    const res = await tool().run({ action: "state" }, ctx());
    assert.equal(res.ok, false);
    const parsed = JSON.parse(res.content) as { fallback: string; reason: string };
    assert.equal(parsed.fallback, "video_edit");
    assert.equal(parsed.reason, "bridge_unavailable");
  });

  it("falls back to video_edit when the task is cancelled mid-command", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    relay.failWith = { code: "CANCELLED", message: "task stopped" };
    const res = await tool().run({ action: "cut", atSec: 5 }, ctx());
    assert.equal(res.ok, false);
    const parsed = JSON.parse(res.content) as { fallback: string; reason: string };
    assert.equal(parsed.fallback, "video_edit");
    assert.equal(parsed.reason, "cancelled");
  });

  it("keeps the video_edit fallback for a rejected command but reports the editor's own error", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    relay.failWith = { code: "COMMAND_REJECTED", message: "unsupported transition type: bogus" };
    const res = await tool().run({ action: "transition_basic", atSec: 5, type: "bogus" }, ctx());
    assert.equal(res.ok, false);
    const parsed = JSON.parse(res.content) as { fallback: string; reason: string; message: string; hint: string };
    assert.equal(parsed.reason, "command_rejected");
    assert.equal(parsed.fallback, "video_edit");
    assert.match(parsed.message, /unsupported transition type: bogus/);
    assert.match(parsed.hint, /fix the command/);
  });

  it("falls back to video_edit for a transport error that carries no relay code", async () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    relay.failWith = { code: "", message: "socket closed" };
    const res = await tool().run({ action: "cut", atSec: 5 }, ctx());
    assert.equal(res.ok, false);
    const parsed = JSON.parse(res.content) as { fallback: string; reason: string; message: string };
    assert.equal(parsed.fallback, "video_edit");
    assert.equal(parsed.reason, "bridge_unavailable");
    assert.match(parsed.message, /socket closed/);
  });
});

describe("video_studio branding", () => {
  // The prompt-side branding contract lives in videoPrompt.test.ts. This one covers
  // the other half: the JSON the tool hands back is read by the model and often
  // relayed to the user, so an upstream project name must never appear as a bare
  // word there. A real filesystem path is allowed, because the agent needs the
  // location to fix the install and a path is a fact rather than a product name.
  const UPSTREAM_NAMES = ["filmcraft", "effectcraft", "artcraft"];

  /** Drop path-like tokens so a legitimate directory name is not counted as a leak. */
  function stripPaths(text: string): string {
    return text.replace(/[^\s"'`,)\]]*[\\/][^\s"'`,)\]]*/g, "<path>");
  }

  /** A local root carrying the vendored dist, so the shared `root` fixture stays intact. */
  function withDist(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-brand-"));
    fs.mkdirSync(path.join(dir, "electron", "filmcraft", "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "electron", "filmcraft", "dist", "index.html"), "<html></html>");
    return dir;
  }

  function brandTool(brandRoot: string): ReturnType<typeof createVideoStudioTools>[number] {
    return createVideoStudioTools({ relay, root: brandRoot })[0]!;
  }

  it("never names an upstream project in a result the model reads", async () => {
    const brandRoot = withDist();
    const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-nodist-"));
    const brandWs = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-brand-ws-"));
    const brandCtx = { cfg: {} as never, workspace: brandWs, emit: () => undefined, taskId: "task_1" } as never;
    const contents: string[] = [];

    // dist missing
    relay = new MockRelay();
    contents.push((await brandTool(missingRoot).run({ action: "state" }, brandCtx)).content);

    // panel not open, bridge failure, rejected command, cancelled
    for (const failWith of [
      { code: "PANEL_NOT_OPEN", message: "no panel" },
      { code: "TIMEOUT", message: "timed out" },
      { code: "COMMAND_REJECTED", message: "bad clip" },
      { code: "CANCELLED", message: "task stopped" },
    ]) {
      relay = new MockRelay();
      relay.commands = CATALOG;
      relay.failWith = failWith;
      contents.push((await brandTool(brandRoot).run({ action: "cut", atSec: 5 }, brandCtx)).content);
    }

    // missing command, unknown action, success
    relay = new MockRelay();
    relay.commands = ["file.newProject", "export"];
    contents.push((await brandTool(brandRoot).run({ action: "cut", atSec: 5 }, brandCtx)).content);
    relay = new MockRelay();
    contents.push((await brandTool(brandRoot).run({ action: "teleport" }, brandCtx)).content);
    relay = new MockRelay();
    relay.commands = CATALOG;
    contents.push((await brandTool(brandRoot).run({ action: "split", atSec: 8 }, brandCtx)).content);

    try {
      for (const content of contents) {
        const text = stripPaths(content).toLowerCase();
        for (const name of UPSTREAM_NAMES) {
          assert.ok(!text.includes(name), `upstream name "${name}" leaked into a tool result: ${content}`);
        }
      }
    } finally {
      for (const dir of [brandRoot, missingRoot, brandWs]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  });

  it("keeps the reason codes brand-neutral", async () => {
    // The dist-missing reason used to be spelled with an upstream project name.
    const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-nodist-"));
    const brandWs = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-brand-ws-"));
    const brandCtx = { cfg: {} as never, workspace: brandWs, emit: () => undefined, taskId: "task_1" } as never;
    try {
      relay = new MockRelay();
      const parsed = JSON.parse((await brandTool(missingRoot).run({ action: "state" }, brandCtx)).content) as { reason: string };
      for (const name of UPSTREAM_NAMES) {
        assert.ok(!parsed.reason.includes(name), `reason "${parsed.reason}" names an upstream project`);
      }
    } finally {
      for (const dir of [missingRoot, brandWs]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  });
});

describe("video_studio helpers", () => {
  it("toSeconds accepts seconds and timecode", () => {
    assert.equal(toSeconds(90), 90);
    assert.equal(toSeconds("1:30"), 90);
    // The shared grammar drops a trailing fractional part on timecode.
    assert.equal(toSeconds("00:01:30.500"), 90);
    assert.equal(toSeconds("nope"), null);
    assert.equal(toSeconds(undefined), null);
  });

  it("toSecondsArray accepts a single time or a list", () => {
    assert.deepEqual(toSecondsArray(1), [1]);
    assert.deepEqual(toSecondsArray(["1:00", 2]), [60, 2]);
    assert.equal(toSecondsArray([]), null);
    assert.equal(toSecondsArray(["1:00", "bad"]), null);
  });

  it("resolveCommandId picks the first exposed candidate", () => {
    assert.equal(resolveCommandId(["sequence.razor", "timeline.razor"], ["timeline.razor", "sequence.razor"]), "timeline.razor");
    assert.equal(resolveCommandId(["sequence.razor"], ["timeline.razor", "sequence.razor"]), "sequence.razor");
    assert.equal(resolveCommandId(["export"], ["timeline.razor"]), null);
  });

  it("toCommandIdList reads strings and {id} objects", () => {
    assert.deepEqual(toCommandIdList(["a.b", { id: "c.d" }, { nope: 1 }, 7]), ["a.b", "c.d"]);
    assert.deepEqual(toCommandIdList("not-a-list"), []);
  });

  it("closeMatches ranks the nearest ids first", () => {
    const matches = closeMatches(["timeline.razor", "timeline.trim", "export"], "timeline.razro");
    assert.equal(matches[0], "timeline.razor");
    assert.deepEqual(closeMatches(["export"], "completely-different"), []);
  });

  it("lastExecuteCommand exposes the resolved command for assertions", () => {
    relay = new MockRelay();
    relay.commands = CATALOG;
    return tool()
      .run({ action: "split", atSec: 8 }, ctx())
      .then(() => {
        assert.deepEqual(lastExecuteCommand(), { command: "timeline.split", params: { atSec: 8 } });
      });
  });
});

/**
 * fc-06: the `export` action. It is the one action that is not a plain step
 * list: it is delegated to the shared export service, which resolves the real
 * export command id, waits for the render, reads the bytes back and writes the
 * file into the task workspace. These tests cover the tool's own part of that
 * contract: validation before any editor call, the resolved command id, the
 * saved file, and the fallback when the render fails.
 */
describe("video_studio export action", () => {
  it("renders the timeline and saves the file into the task workspace", async () => {
    fs.rmSync(path.join(ws, "exports"), { recursive: true, force: true });
    const exportRelay = new ExportMockRelay();
    exportRelay.commands = ["file.exportMedia", ...CATALOG];
    relay = exportRelay;

    const res = await tool().run({ action: "export", format: "mp4", name: "loam-cut", quality: "high" }, ctx());
    assert.equal(res.ok, true, res.content);

    const parsed = JSON.parse(res.content) as {
      action: string;
      ok: boolean;
      path: string;
      name: string;
      mime: string;
      bytes: number;
      command: string;
    };
    assert.equal(parsed.action, "export");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "file.exportMedia");
    assert.equal(parsed.path, "exports/loam-cut.mp4");
    assert.equal(parsed.name, "loam-cut.mp4");
    assert.equal(parsed.mime, "video/mp4");
    assert.equal(parsed.bytes, Buffer.from("fake-mp4-bytes").length);

    // The file really landed in the task workspace, written atomically.
    const saved = path.join(ws, "exports", "loam-cut.mp4");
    assert.equal(fs.existsSync(saved), true);
    assert.equal(fs.readFileSync(saved, "utf8"), "fake-mp4-bytes");
    assert.deepEqual(fs.readdirSync(path.dirname(saved)).filter((entry) => entry.endsWith(".tmp")), []);

    // The export id is resolved from the live catalog, never guessed: the
    // execute step that drives the render carries the resolved id.
    const executed = allDispatched().filter((step) => step.method === "execute");
    assert.equal(executed.length > 0, true);
    assert.deepEqual(executed[0]!.params, {
      command: "file.exportMedia",
      params: { path: "/exports/loam-cut.mp4", range: "", wait: true, targetKbps: 12_000 },
    });
  });

  it("refuses an unknown quality before touching the editor", async () => {
    relay = new ExportMockRelay();
    relay.commands = ["file.exportMedia", ...CATALOG];
    const res = await tool().run({ action: "export", quality: "ultra" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /quality must be one of/);
    assert.deepEqual(relay.dispatched, []);
  });

  it("refuses an unknown range before touching the editor", async () => {
    relay = new ExportMockRelay();
    relay.commands = ["file.exportMedia", ...CATALOG];
    const res = await tool().run({ action: "export", range: "half" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /range must be one of/);
    assert.deepEqual(relay.dispatched, []);
  });

  it("falls back to video_edit when the editor exposes no export command", async () => {
    fs.rmSync(path.join(ws, "exports"), { recursive: true, force: true });
    relay = new ExportMockRelay();
    relay.commands = CATALOG.filter((id) => id !== "export");
    const res = await tool().run({ action: "export" }, ctx());
    assert.equal(res.ok, false);
    const parsed = JSON.parse(res.content) as { fallback: string; reason: string };
    assert.equal(parsed.fallback, "video_edit");
    assert.equal(parsed.reason, "export_failed");
    // Nothing was written when the render could not even start.
    assert.equal(fs.existsSync(path.join(ws, "exports")), false);
  });

  it("falls back to video_edit when the editor produces no bytes", async () => {
    fs.rmSync(path.join(ws, "exports"), { recursive: true, force: true });
    const empty = new ExportMockRelay();
    empty.commands = ["file.exportMedia", ...CATALOG];
    empty.readFileValue = "";
    relay = empty;
    const res = await tool().run({ action: "export" }, ctx());
    assert.equal(res.ok, false);
    const parsed = JSON.parse(res.content) as { fallback: string; reason: string };
    assert.equal(parsed.fallback, "video_edit");
    assert.equal(parsed.reason, "export_failed");
    assert.equal(fs.existsSync(path.join(ws, "exports")), false);
  });

  it("keeps one shared definition of the export command ids", async () => {
    const { VIDEO_STUDIO_EXPORT_COMMAND_CANDIDATES } = await import("../../tools/videoStudio.js");
    assert.deepEqual([...VIDEO_STUDIO_EXPORT_COMMAND_CANDIDATES], ["file.exportMedia", "file.export", "export.quick", "export"]);
    // The service must resolve exactly the same ids as the tool.
    const service = await import("../../server/videoStudioExport.js");
    assert.deepEqual([...service.VIDEO_STUDIO_EXPORT_COMMAND_CANDIDATES], [...VIDEO_STUDIO_EXPORT_COMMAND_CANDIDATES]);
    // Regression guard for the fc-06 TDZ crash: the service must not declare
    // its own copy of the table. If it ever does, the two halves can silently
    // resolve different ids (and importing the tool from the service would throw
    // a temporal-dead-zone ReferenceError). Identity proves one definition.
    assert.equal(service.VIDEO_STUDIO_EXPORT_COMMAND_CANDIDATES, VIDEO_STUDIO_EXPORT_COMMAND_CANDIDATES);
  });
});

// ---------------------------------------------------------------------------
// fc-09: the effects round trip
// ---------------------------------------------------------------------------

/** Film side of the round trip: the replace command lives here. */
const FILM_ROUND_TRIP_CATALOG = ["file.newProject", "importFiles", "timeline.replaceRange", "export"];

/** Effects side: the transition / effect / text asks plus render + readFile. */
const EFFECTS_CATALOG = [
  "composition.new",
  "transition.fade",
  "effect.blur",
  "text.animateIn",
  "renderQueue.render",
  "readFile",
];

/** A two-clip timeline; the round trip targets the second clip. */
const FILM_STATE = {
  playheadSec: 30,
  sequences: [
    {
      id: "v1",
      clips: [
        { id: "clip_a", source: "C:\\task\\intro.mp4", startSec: 0, endSec: 10, inSec: 0, outSec: 10 },
        { id: "clip_b", source: "C:\\task\\main.mp4", startSec: 10, endSec: 50, inSec: 2, outSec: 42, fps: 25, width: 1920, height: 1080 },
      ],
    },
  ],
};

/** Target-aware relay: the film and effects engines answer differently. */
class RoundTripRelay implements VideoStudioRelayLike {
  readonly dispatched: Dispatched[] = [];
  effectsCommands: unknown = EFFECTS_CATALOG;
  filmCommands: unknown = FILM_ROUND_TRIP_CATALOG;
  filmState: unknown = FILM_STATE;
  renderOutput = "C:\\task\\effects\\main-render.mp4";
  /** Fail only when the dispatch matches, so a mid-sequence failure is testable. */
  failWhen: { target: string; method: string; code: string; message: string } | null = null;

  async enqueue(
    taskId: string,
    target: "film" | "effects",
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    this.dispatched.push({ taskId, target, method, params });
    const fail = this.failWhen;
    if (fail && fail.target === target && fail.method === method) {
      throw Object.assign(new Error(fail.message), { code: fail.code });
    }
    if (method === "commands") return target === "effects" ? this.effectsCommands : this.filmCommands;
    if (method === "inspect") return this.filmState;
    if (method === "readFile") return { path: this.renderOutput };
    return { ok: true };
  }

  /** Work steps only: the catalog/inspect reads that precede a round trip. */
  workSteps(): Dispatched[] {
    return this.dispatched.filter((d) => d.method !== "commands" && d.method !== "inspect");
  }
}

/** Install the effects engine so the round trip is considered available. */
function installEffectcraftDist(): void {
  fs.mkdirSync(path.join(root, "electron", "effectcraft", "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "electron", "effectcraft", "dist", "index.html"), "<html></html>");
}

describe("video_studio effects round trip (fc-09)", () => {
  it("reports effects_dist_missing and points at the editor-native actions", async () => {
    // The dist is gitignored, so its absence is a normal state: the agent must
    // be told to use transition_basic / effect_basic instead of the round trip.
    fs.rmSync(path.join(root, "electron", "effectcraft"), { recursive: true, force: true });
    relay = new RoundTripRelay();
    const res = await tool().run({ action: "transition", clipId: "clip_b", type: "fade" }, ctx());
    assert.equal(res.ok, false);
    const parsed = JSON.parse(res.content) as { reason: string; hint: string; message: string };
    assert.equal(parsed.reason, "effects_dist_missing");
    assert.match(parsed.hint, /transition_basic/);
    assert.match(parsed.hint, /effect_basic/);
    // Nothing is dispatched to a backend that is not installed.
    assert.deepEqual(relay.dispatched, []);
  });

  it("round-trips a clip through both engines and replaces the range in place", async () => {
    installEffectcraftDist();
    relay = new RoundTripRelay();
    const res = await tool().run({ action: "transition", clipId: "clip_b", type: "fade" }, ctx());
    assert.equal(res.ok, true);

    // The full sequence: hand the media to the effects engine, build a matching
    // composition, apply the ask, render, read it back, import it and replace
    // the original range on the same track.
    assert.deepEqual(relay.workSteps(), [
      { taskId: "task_1", target: "effects", method: "addFile", params: { path: "C:\\task\\main.mp4", inSec: 2, outSec: 42 } },
      {
        taskId: "task_1",
        target: "effects",
        method: "execute",
        params: { command: "composition.new", params: { width: 1920, height: 1080, fps: 25, durationSec: 40 } },
      },
      { taskId: "task_1", target: "effects", method: "execute", params: { command: "transition.fade", params: { type: "fade" } } },
      { taskId: "task_1", target: "effects", method: "execute", params: { command: "renderQueue.render", params: { format: "mp4" } } },
      { taskId: "task_1", target: "effects", method: "readFile", params: {} },
      { taskId: "task_1", target: "film", method: "importFiles", params: {} },
      {
        taskId: "task_1",
        target: "film",
        method: "execute",
        params: { command: "timeline.replaceRange", params: { clipId: "clip_b", trackId: "v1", fromSec: 10, toSec: 50 } },
      },
    ]);

    const parsed = JSON.parse(res.content) as {
      action: string;
      clipId: string;
      outputPath: string;
      projectPath: string;
      steps: Array<{ target: string; method: string; ok: boolean }>;
      hint: string;
    };
    assert.equal(parsed.clipId, "clip_b");
    assert.equal(parsed.outputPath, "C:\\task\\effects\\main-render.mp4");
    assert.equal(parsed.projectPath, `${ws}/effects/main.ecproj`);
    assert.equal(parsed.steps.length, 7);
    assert.match(parsed.hint, /open_effects/);
    // The neighbours are never named, so their positions cannot shift.
    assert.ok(!JSON.stringify(relay.workSteps()).includes("clip_a"));
  });

  it("picks the clip under the playhead when no clipId is given", async () => {
    installEffectcraftDist();
    relay = new RoundTripRelay();
    const res = await tool().run({ action: "effect", atSec: 30, name: "glow" }, ctx());
    assert.equal(res.ok, true);
    const parsed = JSON.parse(res.content) as { clipId: string };
    assert.equal(parsed.clipId, "clip_b");
    assert.deepEqual(relay.workSteps().at(-1)!.params, {
      command: "timeline.replaceRange",
      params: { clipId: "clip_b", trackId: "v1", fromSec: 10, toSec: 50 },
    });
  });

  it("resolves each ask against the live effects catalog", async () => {
    installEffectcraftDist();
    for (const [action, extra, expected] of [
      ["transition", { type: "fade" }, { command: "transition.fade", params: { type: "fade" } }],
      ["effect", { name: "blur" }, { command: "effect.blur", params: { name: "blur" } }],
      ["animate_text", { text: "Hello" }, { command: "text.animateIn", params: { text: "Hello" } }],
    ] as const) {
      relay = new RoundTripRelay();
      const res = await tool().run({ action, clipId: "clip_b", ...extra }, ctx());
      assert.equal(res.ok, true, `${action} should succeed`);
      // The ask is the third work step: after addFile and composition.new.
      assert.deepEqual(relay.workSteps()[2]!.params, expected, action);
    }
  });

  it("refuses when the named clip is not on the timeline", async () => {
    installEffectcraftDist();
    relay = new RoundTripRelay();
    const res = await tool().run({ action: "transition", clipId: "nope", type: "fade" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /no Loam Video clip matches/);
    // The plan is refused before anything reaches an engine.
    assert.deepEqual(relay.workSteps(), []);
  });

  it("refuses when the effects engine lacks the ask", async () => {
    installEffectcraftDist();
    relay = new RoundTripRelay();
    relay.effectsCommands = ["renderQueue.render", "readFile"];
    const res = await tool().run({ action: "animate_text", clipId: "clip_b", text: "Hi" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /does not expose a command for "animate_text"/);
    assert.deepEqual(relay.workSteps(), []);
  });

  it("reports panel_not_open rather than flattening it into a command rejection", async () => {
    installEffectcraftDist();
    relay = new RoundTripRelay();
    relay.failWhen = { target: "effects", method: "addFile", code: "PANEL_NOT_OPEN", message: "no panel" };
    const res = await tool().run({ action: "transition", clipId: "clip_b", type: "fade" }, ctx());
    assert.equal(res.ok, false);
    const parsed = JSON.parse(res.content) as { ok: boolean; reason: string; clipId: string };
    assert.equal(parsed.reason, "panel_not_open");
    assert.equal(parsed.clipId, "clip_b");
  });

  it("reports command_rejected and leaves the timeline untouched when the engine refuses", async () => {
    installEffectcraftDist();
    relay = new RoundTripRelay();
    relay.failWhen = { target: "effects", method: "execute", code: "COMMAND_REJECTED", message: "unsupported transition" };
    const res = await tool().run({ action: "transition", clipId: "clip_b", type: "fade" }, ctx());
    assert.equal(res.ok, false);
    const parsed = JSON.parse(res.content) as { reason: string; message: string };
    assert.equal(parsed.reason, "command_rejected");
    assert.match(parsed.message, /unsupported transition/);
    // The film side is never reached, so the clip keeps its original media.
    assert.equal(relay.dispatched.filter((d) => d.target === "film" && d.method !== "commands" && d.method !== "inspect").length, 0);
  });

  it("effects_status reports availability and the resolved asks", async () => {
    installEffectcraftDist();
    relay = new RoundTripRelay();
    const res = await tool().run({ action: "effects_status" }, ctx());
    assert.equal(res.ok, true);
    const parsed = JSON.parse(res.content) as {
      available: boolean;
      commands: string[];
      supportedAsks: Array<{ ask: string; command: string | null }>;
    };
    assert.equal(parsed.available, true);
    assert.deepEqual(parsed.commands, EFFECTS_CATALOG);
    assert.deepEqual(parsed.supportedAsks, [
      { ask: "transition", command: "transition.fade" },
      { ask: "effect", command: "effect.blur" },
      { ask: "animate_text", command: "text.animateIn" },
    ]);
    // Reporting status must not touch the timeline.
    assert.equal(relay.dispatched.filter((d) => d.target === "film").length, 0);
  });

  it("effects_status reports an engine that exposes no commands", async () => {
    installEffectcraftDist();
    relay = new RoundTripRelay();
    relay.effectsCommands = [];
    const res = await tool().run({ action: "effects_status" }, ctx());
    assert.equal(res.ok, true);
    const parsed = JSON.parse(res.content) as { available: boolean; supportedAsks: Array<{ command: string | null }> };
    assert.equal(parsed.available, false);
    assert.deepEqual(parsed.supportedAsks.map((a) => a.command), [null, null, null]);
  });

  it("open_effects requires a project path and then reopens it", async () => {
    installEffectcraftDist();
    relay = new RoundTripRelay();
    const missing = await tool().run({ action: "open_effects" }, ctx());
    assert.equal(missing.ok, false);
    assert.match(missing.content, /open_effects requires projectPath/);
    assert.deepEqual(relay.dispatched, []);

    relay = new RoundTripRelay();
    const res = await tool().run({ action: "open_effects", projectPath: "C:\\task\\effects\\main.ecproj" }, ctx());
    assert.equal(res.ok, true);
    assert.deepEqual(
      relay.dispatched.map((d) => ({ target: d.target, method: d.method, params: d.params })),
      [
        { target: "effects", method: "openProject", params: { path: "C:\\task\\effects\\main.ecproj" } },
        { target: "effects", method: "inspect", params: {} },
      ],
    );
    const parsed = JSON.parse(res.content) as { projectPath: string };
    assert.equal(parsed.projectPath, "C:\\task\\effects\\main.ecproj");
  });

  it("does not read the film catalog twice for a round trip", async () => {
    installEffectcraftDist();
    relay = new RoundTripRelay();
    await tool().run({ action: "transition", clipId: "clip_b", type: "fade" }, ctx());
    // Routing happens before the generic catalog read, so each engine is asked
    // for its command list exactly once.
    assert.equal(relay.dispatched.filter((d) => d.method === "commands" && d.target === "film").length, 1);
    assert.equal(relay.dispatched.filter((d) => d.method === "commands" && d.target === "effects").length, 1);
    assert.equal(relay.dispatched.filter((d) => d.method === "inspect").length, 1);
  });
});
