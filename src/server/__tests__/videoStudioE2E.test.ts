/**
 * fc-03 end-to-end: the real server, the real relay and the real tool.
 *
 * The unit tests inject a mock relay, so they cannot catch a mismatch between
 * the relay's SSE event shape and what the panel (and this test's fake panel)
 * expects, nor a wrong result-route contract. This test drives the whole loop
 * against a real HTTP server:
 *
 *   video_studio.run -> videoStudioRelay.enqueue -> SSE video_studio_command
 *     -> (fake panel) POST /api/tasks/:id/video-studio/result -> promise settles
 *     -> video_studio returns the panel's result
 *
 * The fake panel subscribes to the real task stream, answers `commands` with a
 * catalog and every other method with a value, exactly like the browser panel.
 */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

type Db = typeof import("../db.js");
type Tool = import("../../tools/registry.js").Tool;
type VideoStudioCommand = import("../videoStudioRelay.js").VideoStudioCommand;

const CATALOG = ["file.newProject", "timeline.razor", "sequence.applyVideoTransition", "export"];

interface StreamEvent {
  type: string;
  id?: string;
  target?: string;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * A fake editor panel: attaches to the task's SSE stream, runs each relayed
 * command through a small stand-in for the wasm editor, and posts the result
 * back to the real HTTP route (the same route the browser panel uses).
 *
 * `inspectProject` (optional) overrides the timeline returned for `inspect`,
 * so a test can simulate the user editing the timeline by hand.
 */
function attachPanel(
  base: string,
  taskId: string,
  log: StreamEvent[],
  inspectProject?: () => unknown,
): { stop: () => void; done: Promise<void>; ready: Promise<void> } {
  const controller = new AbortController();
  let resolveDone: () => void = () => undefined;
  let resolveReady: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const run = async () => {
    const res = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/stream`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    resolveReady();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        break; // aborted
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        sep = buffer.indexOf("\n\n");
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice("data: ".length)) as StreamEvent;
        if (event.type !== "video_studio_command" || typeof event.id !== "string") continue;
        log.push(event);
        const result = inspectProject && event.method === "inspect"
          ? { ok: true, result: inspectProject() }
          : runCommand(event);
        await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/video-studio/result`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: event.id, taskId, ...result }),
        });
      }
    }
    resolveDone();
  };
  void run().catch(() => resolveDone());
  return {
    stop: () => controller.abort(),
    done,
    ready,
  };
}

/** Wait until the real server reports a subscriber attached to the task. */
async function waitForAttached(taskId: string, timeoutMs = 5_000): Promise<void> {
  const { subscriberCount } = await import("../streams.js");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (subscriberCount(taskId) > 0) return;
    if (Date.now() > deadline) throw new Error(`no panel attached to ${taskId}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Wait until the real server reports no subscriber attached to the task. */
async function waitForDetached(taskId: string, timeoutMs = 5_000): Promise<void> {
  const { subscriberCount } = await import("../streams.js");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (subscriberCount(taskId) === 0) return;
    if (Date.now() > deadline) throw new Error(`panel still attached to ${taskId}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Stand-in for the wasm editor: answers the catalog and echoes other calls. */
function runCommand(event: StreamEvent): { ok: boolean; result?: unknown; error?: string } {
  if (event.method === "commands") return { ok: true, result: CATALOG.map((id) => ({ id })) };
  if (event.method === "inspect") return { ok: true, result: { sequences: [{ id: "seq1", tracks: [], clips: [] }], playheadSec: 0 } };
  if (event.method === "execute") {
    const command = event.params?.["command"];
    if (command === "sequence.applyVideoTransition") return { ok: false, error: "unsupported transition type: bogus" };
    return { ok: true, result: { command, applied: true } };
  }
  return { ok: true, result: { method: event.method } };
}

describe("video_studio end-to-end over the real server", () => {
  let tmpDir = "";
  let closeDb: () => void;
  let db: Db;
  let server: http.Server;
  let base = "";
  let taskId = "";
  let workspace = "";
  let tools: Tool[] = [];

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-e2e-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    process.env.MANUS_LOCAL_SKILLS_DIR = path.join(tmpDir, "skills");
    process.env.MANUS_LOCAL_EVALS_DIR = path.join(tmpDir, "evals");
    process.env.LOAM_AUTH_DISABLED = "true";
    workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const configFile = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({ workspace, memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false }, computerUse: { enabled: false }, mcpServers: {} }),
      "utf8",
    );
    process.env.LOAM_CONFIG = configFile;

    closeDb = (await import("../sqliteStore.js")).closeDb;
    db = await import("../db.js");
    const { loadConfig } = await import("../../config.js");
    const { OllamaClient } = await import("../../ollama.js");
    const { startServer } = await import("../http.js");
    const { videoStudioRelay } = await import("../videoStudioRelay.js");
    const { createVideoStudioTools } = await import("../../tools/videoStudio.js");

    const task = db.createTask("video studio e2e", "e2e");
    taskId = task.id;
    db.setTaskWorkspace(taskId, workspace);

    const cfg = loadConfig();
    cfg.server.host = "127.0.0.1";
    cfg.server.port = 0;
    server = await startServer({
      cfg,
      ollama: new OllamaClient("http://127.0.0.1:1"),
      runTask: async () => ({ taskId: "test", text: "" }),
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;

    // The real tool, wired to the real shared relay, with a stubbed dist probe
    // (electron/filmcraft/dist is not vendored in this worktree) and the real
    // workspace.
    tools = createVideoStudioTools({ relay: videoStudioRelay, root: tmpDir });
    fs.mkdirSync(path.join(tmpDir, "electron", "filmcraft", "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "electron", "filmcraft", "dist", "index.html"), "<html></html>");
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { closeDb(); } catch { /* already closed */ }
    for (const key of ["MANUS_LOCAL_DATA_DIR", "MANUS_LOCAL_SKILLS_DIR", "MANUS_LOCAL_EVALS_DIR", "LOAM_AUTH_DISABLED", "LOAM_CONFIG"]) {
      delete process.env[key];
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function ctx() {
    return { cfg: {} as never, workspace, emit: () => undefined, taskId } as never;
  }

  it("settles a cut through the real relay, SSE stream and result route", async () => {
    const log: StreamEvent[] = [];
    const panel = attachPanel(base, taskId, log);
    try {
      await panel.ready;
      await waitForAttached(taskId);
      const res = await tools[0]!.run({ action: "cut", atSec: 5 }, ctx());
      assert.equal(res.ok, true);
      const parsed = JSON.parse(res.content) as { action: string; steps: Array<{ method: string; ok: boolean; result: unknown }> };
      assert.equal(parsed.action, "cut");
      assert.equal(parsed.steps.length, 1);
      assert.equal(parsed.steps[0]!.method, "execute");
      assert.deepEqual(parsed.steps[0]!.result, { command: "timeline.razor", applied: true });

      // fc-05: the catalog read first, then the timeline read before the edit,
      // the resolved razor command, then the timeline read after it.
      const methods = log.map((e) => e.method);
      assert.deepEqual(methods, ["commands", "inspect", "execute", "inspect"]);
      assert.deepEqual(log[2]!.params, { command: "timeline.razor", params: { atSec: 5 } });
    } finally {
      panel.stop();
      await waitForDetached(taskId);
    }
  });

  it("reports a manual edit the user made between two commands", async () => {
    // fc-05: the panel reports a hand-edited timeline the second time around,
    // and the tool must prepend the manual-edit notice to the result.
    const log: StreamEvent[] = [];
    let inspects = 0;
    const panel = attachPanel(base, taskId, log, () => {
      inspects += 1;
      const tracks =
        inspects === 1
          ? [{ id: "v1", kind: "video", clips: [{ id: "clip_1", startSec: 0, endSec: 5 }] }]
          : [{ id: "v1", kind: "video", clips: [{ id: "clip_1", startSec: 3, endSec: 8 }] }];
      return { sequences: [{ id: "seq1", tracks }], playheadSec: 0 };
    });
    try {
      await panel.ready;
      await waitForAttached(taskId);
      const before = await tools[0]!.run({ action: "state" }, ctx());
      assert.equal(before.ok, true, before.content);
      assert.doesNotMatch(before.content, /User edited the timeline manually/);

      const moved = await tools[0]!.run({ action: "cut", atSec: 5 }, ctx());
      assert.equal(moved.ok, true, moved.content);
      assert.match(moved.content, /User edited the timeline manually since your last action/);
      assert.match(moved.content, /~clip clip_1 0s->3s/);
    } finally {
      panel.stop();
      await waitForDetached(taskId);
    }
  });

  it("surfaces an editor rejection as command_rejected through the real route", async () => {
    const log: StreamEvent[] = [];
    const panel = attachPanel(base, taskId, log);
    try {
      await panel.ready;
      await waitForAttached(taskId);
      const res = await tools[0]!.run({ action: "transition_basic", atSec: 5, type: "bogus" }, ctx());
      assert.equal(res.ok, false);
      const parsed = JSON.parse(res.content) as { reason: string; fallback: string; message: string };
      assert.equal(parsed.reason, "command_rejected");
      assert.equal(parsed.fallback, "video_edit");
      assert.match(parsed.message, /unsupported transition type: bogus/);
    } finally {
      panel.stop();
      await waitForDetached(taskId);
    }
  });

  it("reports PANEL_NOT_OPEN as a retry when no panel is attached", async () => {
    // A different task with no SSE subscriber: the relay rejects immediately
    // with PANEL_NOT_OPEN, which the tool must surface as a retry (not a
    // video_edit fallback). The same task would sit for the 120s timeout.
    const orphan = db.createTask("orphan", "orphan");
    const res = await tools[0]!.run({ action: "state", taskId: orphan.id }, ctx());
    assert.equal(res.ok, false);
    const parsed = JSON.parse(res.content) as { reason: string; retry: boolean; fallback?: string };
    assert.equal(parsed.reason, "panel_not_open");
    assert.equal(parsed.retry, true);
    assert.equal(parsed.fallback, undefined);
  });

  it("ignores a result whose taskId does not match the route", async () => {
    const log: StreamEvent[] = [];
    const panel = attachPanel(base, taskId, log);
    try {
      await panel.ready;
      await waitForAttached(taskId);
      const pending = tools[0]!.run({ action: "state" }, ctx());
      // Wait until the panel has received the command, then answer under a
      // foreign id.
      const deadline = Date.now() + 3_000;
      while (log.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      assert.equal(log.length, 1);
      const foreign = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/video-studio/result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "vs_nope", taskId: "task_someone_else", ok: true, result: 1 }),
      });
      assert.equal(foreign.status, 400);
      // The real panel answer still settles the call.
      const res = await pending;
      assert.equal(res.ok, true);
    } finally {
      panel.stop();
      await waitForDetached(taskId);
    }
  });
});
