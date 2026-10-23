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

/** In-memory relay: records every dispatch and answers from a command catalog. */
class MockRelay implements VideoStudioRelayLike {
  readonly dispatched: Dispatched[] = [];
  commands: unknown = [];
  failWith: { code: string; message: string } | null = null;

  async enqueue(taskId: string, target: "film" | "effects", method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.dispatched.push({ taskId, target, method, params });
    if (this.failWith) throw Object.assign(new Error(this.failWith.message), { code: this.failWith.code });
    if (method === "commands") return this.commands;
    if (method === "inspect") return { sequences: [{ id: "seq1", tracks: [], clips: [] }], playheadSec: 0 };
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
  return allDispatched().filter((s) => s.method !== "commands");
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
    assert.equal(parsed.reason, "filmcraft_dist_missing");
    // The fallback must not dispatch anything to the panel.
    assert.deepEqual(relay.dispatched, []);
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
    assert.deepEqual(allDispatched(), [{ method: "commands", params: {} }]);
    const parsed = JSON.parse(res.content) as { available: boolean; commands: unknown[] };
    assert.equal(parsed.available, true);
    assert.equal(parsed.commands.length, CATALOG.length);
  });

  it("state reads the project via inspect (no catalog needed)", async () => {
    relay = new MockRelay();
    const res = await tool().run({ action: "state" }, ctx());
    assert.equal(res.ok, true, res.content);
    assert.deepEqual(commandsDispatched(), [{ method: "inspect", params: {} }]);
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
  });
});
