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
let relay: MockRelay;

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
    const degraded = JSON.parse(
      (await tool().run({ action: "effect_basic", name: "glitch" }, ctx())).content,
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
