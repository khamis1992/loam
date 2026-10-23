/**
 * fc-06 unit tests for the Loam Video export service
 * (src/server/videoStudioExport.ts).
 *
 * The relay is mocked, so these tests never touch the editor, the network or a
 * real task stream. They assert the whole flow: command-id resolution against
 * the live catalog, the render wait with progress, reading the bytes back, and
 * the atomic write into the task workspace — plus a clear error and NO file
 * when anything fails.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  buildExportParams,
  EXPORT_DIR,
  mimeForExport,
  normalizeExportBytes,
  normalizeExportFormat,
  outputPathFromResult,
  runVideoStudioExport,
  sanitizeExportName,
  VIDEO_STUDIO_EXPORT_COMMAND_CANDIDATES,
  type VideoStudioExportContext,
  type VideoStudioExportProgress,
  type VideoStudioExportRelay,
} from "../videoStudioExport.js";

interface Dispatched {
  method: string;
  params: Record<string, unknown>;
}

/**
 * In-memory relay: answers `commands` with a catalog, `execute` with a job that
 * finishes after N polls, and `readFile` with the bytes the editor produced.
 */
class MockRelay implements VideoStudioExportRelay {
  readonly dispatched: Dispatched[] = [];
  catalog: unknown = [];
  /** Number of polls before the job reports done (Infinity never finishes). */
  pollsUntilDone = 0;
  polls = 0;
  /** Queue-poll command id the editor exposes; defaults to `jobs.poll`. */
  jobCommand = "jobs.poll";
  readFileValue: unknown = Buffer.from("fake-mp4-bytes").toString("base64");
  failReadFile = false;
  failExecuteWith: Error | null = null;

  async enqueue(_taskId: string, _target: "film" | "effects", method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.dispatched.push({ method, params });
    if (method === "commands") return this.catalog;
    if (method === "execute") {
      if (this.failExecuteWith) throw this.failExecuteWith;
      const command = params["command"];
      if (command === this.jobCommand) {
        this.polls += 1;
        if (this.polls >= this.pollsUntilDone) {
          return { job: { status: "done", path: `${EXPORT_DIR}/loam-cut.mp4`, progress: 1 } };
        }
        return { job: { status: "running", progress: 0.4 } };
      }
      // The export command itself: returns a job that is still running.
      return { job: { status: "running", progress: 0.1, path: `${EXPORT_DIR}/loam-cut.mp4` } };
    }
    if (method === "readFile") {
      if (this.failReadFile) throw new Error("readFile boom");
      return this.readFileValue;
    }
    return { ok: true };
  }
}

let taskRoot = "";
let relay: MockRelay;

function context(overrides: Partial<VideoStudioExportContext> = {}) {
  return {
    taskId: "task_1",
    relay,
    taskRoot,
    ...overrides,
  } as VideoStudioExportContext;
}

function savedFile(name: string): string {
  return path.join(taskRoot, "exports", name);
}

function dispatchedFor(method: string): Dispatched[] {
  return relay.dispatched.filter((d) => d.method === method);
}

after(() => {
  try { fs.rmSync(taskRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("video studio export helpers", () => {
  it("normalises formats and aliases, defaulting to mp4", () => {
    assert.equal(normalizeExportFormat(undefined), "mp4");
    assert.equal(normalizeExportFormat(""), "mp4");
    assert.equal(normalizeExportFormat("MP4"), "mp4");
    assert.equal(normalizeExportFormat(".mov"), "mov");
    assert.equal(normalizeExportFormat("quicktime"), "mov");
    assert.equal(normalizeExportFormat("mpeg"), "mp3");
    assert.equal(normalizeExportFormat("wave"), "wav");
    assert.throws(() => normalizeExportFormat("xyz"), /Unsupported Loam Video export format "xyz"/);
  });

  it("maps names/formats to media types", () => {
    assert.equal(mimeForExport("out.mp4"), "video/mp4");
    assert.equal(mimeForExport("out.mov"), "video/quicktime");
    assert.equal(mimeForExport("out.webm"), "video/webm");
    assert.equal(mimeForExport("out.mkv"), "video/x-matroska");
    assert.equal(mimeForExport("out.wav"), "audio/wav");
    assert.equal(mimeForExport("out.mp3"), "audio/mpeg");
    assert.equal(mimeForExport("out.png"), "image/png");
    assert.equal(mimeForExport("out.bin"), "application/octet-stream");
  });

  it("sanitises names, keeps Arabic, forces the extension", () => {
    assert.equal(sanitizeExportName("my cut", "mp4"), "my-cut.mp4");
    assert.equal(sanitizeExportName("../../etc/passwd", "mp4"), "etc-passwd.mp4");
    assert.equal(sanitizeExportName("مقطع الفيديو", "mp4"), "مقطع-الفيديو.mp4");
    // Separators become dashes so the caller's word boundaries survive; the
    // remaining invalid characters (: * ?) are dropped.
    assert.equal(sanitizeExportName("a/b\\c:d*e?f", "mp4"), "a-b-cdef.mp4");
    assert.match(sanitizeExportName("   ", "mp4"), /^loam-video-.*\.mp4$/);
    assert.equal(sanitizeExportName("clip", "webm"), "clip.webm");
  });

  it("builds editor params without inventing settings keys", () => {
    const base = buildExportParams({}, `${EXPORT_DIR}/clip.mp4`);
    assert.deepEqual(base, { path: `${EXPORT_DIR}/clip.mp4`, range: "entire", wait: true });

    const custom = buildExportParams(
      { width: 1920, height: 1080, quality: "high", range: "custom", startSeconds: 1, endSeconds: 5 },
      `${EXPORT_DIR}/clip.mp4`,
    );
    assert.equal(custom["width"], 1920);
    assert.equal(custom["height"], 1080);
    assert.equal(custom["range"], "custom");
    assert.equal(custom["startSeconds"], 1);
    assert.equal(custom["endSeconds"], 5);
    // `quality` is expressed with the editor's own targetKbps key.
    assert.equal(custom["targetKbps"], 12_000);
    // A custom range must not silently drop the bounds.
    const noBounds = buildExportParams({ range: "custom" }, `${EXPORT_DIR}/clip.mp4`);
    assert.equal("startSeconds" in noBounds, false);
  });

  it("normalises every readFile byte shape", () => {
    const expected = Buffer.from([1, 2, 3]);
    assert.deepEqual(normalizeExportBytes(expected), expected);
    // A real readFile hands back a dedicated ArrayBuffer, and a wasm bridge may
    // hand back a view into a larger buffer, so both must yield exactly 3 bytes
    // (never the 8 KiB pool a small Buffer borrows).
    const exact = new ArrayBuffer(3);
    new Uint8Array(exact).set([1, 2, 3]);
    assert.deepEqual(normalizeExportBytes(exact), expected);
    const pooled = new Uint8Array(8);
    const view = pooled.subarray(2, 5);
    view.set([1, 2, 3]);
    assert.deepEqual(normalizeExportBytes(view), expected);
    assert.deepEqual(normalizeExportBytes(new Uint8Array(expected)), expected);
    assert.deepEqual(normalizeExportBytes(expected.toString("base64")), expected);
    assert.deepEqual(normalizeExportBytes(`data:video/mp4;base64,${expected.toString("base64")}`), expected);
    assert.deepEqual(normalizeExportBytes({ data: expected.toString("base64") }), expected);
    assert.deepEqual(normalizeExportBytes({ bytes: [1, 2, 3] }), expected);
    assert.deepEqual(normalizeExportBytes([1, 2, 3]), expected);
    assert.deepEqual(normalizeExportBytes({ 0: 1, 1: 2, 2: 3 }), expected);
    assert.throws(() => normalizeExportBytes(""), /empty file/);
    assert.throws(() => normalizeExportBytes(42), /unrecognised shape/);
  });

  it("pulls the output path out of nested results", () => {
    assert.equal(outputPathFromResult({ path: "/exports/a.mp4" }, "fb"), "/exports/a.mp4");
    assert.equal(outputPathFromResult({ job: { outputPath: "/exports/b.mp4" } }, "fb"), "/exports/b.mp4");
    assert.equal(outputPathFromResult({ jobs: [{ destination: "/exports/c.mp4" }] }, "fb"), "/exports/c.mp4");
    assert.equal(outputPathFromResult({}, "fallback.mp4"), "fallback.mp4");
  });
});

describe("runVideoStudioExport saves the rendered file", () => {
  it("resolves the real export id, waits for the job and writes into exports/", async () => {
    taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-export-"));
    relay = new MockRelay();
    relay.catalog = ["file.newProject", ...VIDEO_STUDIO_EXPORT_COMMAND_CANDIDATES, "jobs.poll"];
    relay.pollsUntilDone = 2;

    const stages: string[] = [];
    const result = await runVideoStudioExport(
      context({ options: { format: "mp4", name: "loam-cut" }, onProgress: (p) => stages.push(p.stage) }),
    );

    assert.deepEqual(result, {
      ok: true,
      path: "exports/loam-cut.mp4",
      name: "loam-cut.mp4",
      mime: "video/mp4",
      bytes: Buffer.from("fake-mp4-bytes").length,
      command: "file.exportMedia",
    });

    // The file is really on disk with the editor's bytes.
    const onDisk = fs.readFileSync(savedFile("loam-cut.mp4"), "utf8");
    assert.equal(onDisk, "fake-mp4-bytes");

    // The catalog was read first, then the resolved export command.
    const commands = dispatchedFor("commands");
    assert.equal(commands.length, 1);
    const executes = dispatchedFor("execute");
    assert.equal(executes[0]!["params"]["command"], "file.exportMedia");
    assert.deepEqual(executes[0]!["params"]["params"], {
      path: `${EXPORT_DIR}/loam-cut.mp4`,
      range: "entire",
      wait: true,
    });

    // Progress was reported in order.
    assert.deepEqual(stages, ["starting", "rendering", "rendering", "saving"]);
  });

  it("polls with the job command the editor actually exposes", async () => {
    taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-export-"));
    relay = new MockRelay();
    // The editor spells the queue poll `status.job.progress`, not `jobs.poll`.
    relay.catalog = ["file.exportMedia", "status.job.progress"];
    relay.jobCommand = "status.job.progress";
    relay.pollsUntilDone = 1;
    relay.readFileValue = Buffer.from("polled").toString("base64");

    const result = await runVideoStudioExport(context({ options: { format: "mp4", name: "polled" } }));
    assert.equal(result.ok, true);

    const polls = dispatchedFor("execute").filter((entry) => entry["params"]["command"] !== "file.exportMedia");
    assert.equal(polls.length, 1);
    assert.equal(polls[0]!["params"]["command"], "status.job.progress");
  });

  it("returns the editor's own output path and reports the saved name", async () => {
    taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-export-"));
    relay = new MockRelay();
    relay.catalog = ["export.quick"];
    relay.pollsUntilDone = 1;
    relay.readFileValue = Buffer.from("zzz").toString("base64");

    const result = await runVideoStudioExport(context({ options: { format: "webm" } }));
    assert.equal(result.ok, true);
    assert.equal(result.path, `exports/${result.name}`);
    assert.match(result.name, /\.webm$/);
    assert.equal(result.mime, "video/webm");
    assert.equal(result.command, "export.quick");
    assert.equal(fs.existsSync(path.join(taskRoot, "exports", result.name)), true);
  });

  it("falls back to a readFile params shape when the first call is refused", async () => {
    taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-export-"));
    relay = new MockRelay();
    relay.catalog = ["file.exportMedia"];
    relay.pollsUntilDone = 1;
    let readCalls = 0;
    relay.readFileValue = Buffer.from("ok").toString("base64");
    const original = relay.enqueue.bind(relay);
    relay.enqueue = async (taskId, target, method, params = {}) => {
      if (method === "readFile") {
        readCalls += 1;
        if (readCalls === 1) throw new Error("readFile boom");
      }
      return original(taskId, target, method, params);
    };

    const result = await runVideoStudioExport(context({}));
    assert.equal(result.ok, true);
    assert.equal(readCalls, 2);
  });
});

describe("runVideoStudioExport reports clear failures and writes nothing", () => {
  it("fails when the editor exposes no export command", async () => {
    taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-export-"));
    relay = new MockRelay();
    relay.catalog = ["file.newProject", "timeline.razor"];

    await assert.rejects(
      () => runVideoStudioExport(context({})),
      /exposes no export command[\s\S]*file\.exportMedia[\s\S]*Available commands/,
    );
    assert.equal(fs.existsSync(path.join(taskRoot, "exports")), false);
  });

  it("fails with the editor's own error when the render job fails", async () => {
    taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-export-"));
    relay = new MockRelay();
    relay.catalog = ["file.exportMedia"];
    relay.pollsUntilDone = 0;
    relay.readFileValue = "";
    // The first execute returns a job that is already failed.
    relay.failExecuteWith = null;
    const original = relay.enqueue.bind(relay);
    relay.enqueue = async (taskId, target, method, params = {}) => {
      if (method === "execute" && params["command"] !== "jobs.poll") {
        return { job: { status: "failed", error: "encoder crashed", path: `${EXPORT_DIR}/x.mp4` } };
      }
      return original(taskId, target, method, params);
    };

    await assert.rejects(() => runVideoStudioExport(context({})), /encoder crashed/);
    assert.equal(fs.existsSync(path.join(taskRoot, "exports")), false);
  });

  it("fails on an unrecognised byte shape and writes nothing", async () => {
    taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-export-"));
    relay = new MockRelay();
    relay.catalog = ["file.exportMedia"];
    relay.pollsUntilDone = 1;
    relay.readFileValue = 42;

    await assert.rejects(() => runVideoStudioExport(context({})), /unrecognised shape/);
    assert.equal(fs.existsSync(path.join(taskRoot, "exports")), false);
  });

  it("times out when the render never finishes", async () => {
    taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-export-"));
    relay = new MockRelay();
    relay.catalog = ["file.exportMedia"];
    relay.pollsUntilDone = Number.POSITIVE_INFINITY;

    let ticks = 0;
    await assert.rejects(
      () =>
        runVideoStudioExport(
          context({
            timeoutMs: 50,
            pollIntervalMs: 10,
            now: () => (ticks += 10),
            sleep: async () => {},
          }),
        ),
      /did not finish within/,
    );
    assert.equal(fs.existsSync(path.join(taskRoot, "exports")), false);
  });

  it("reports no file when the editor produced an empty export", async () => {
    taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-export-"));
    relay = new MockRelay();
    relay.catalog = ["file.exportMedia"];
    relay.pollsUntilDone = 1;
    relay.readFileValue = "";

    await assert.rejects(() => runVideoStudioExport(context({})), /empty file/);
    assert.equal(fs.existsSync(path.join(taskRoot, "exports")), false);
  });

  it("rejects an unsupported format before touching the editor", async () => {
    taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-export-"));
    relay = new MockRelay();
    relay.catalog = ["file.exportMedia"];

    await assert.rejects(() => runVideoStudioExport(context({ options: { format: "flv" } })), /Unsupported/);
    assert.equal(relay.dispatched.length, 0);
  });
});

describe("video studio export progress", () => {
  it("clamps progress into 0..1 and only carries it for rendering", async () => {
    taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-export-"));
    relay = new MockRelay();
    relay.catalog = ["file.exportMedia"];
    relay.pollsUntilDone = 1;

    const seen: VideoStudioExportProgress[] = [];
    await runVideoStudioExport(context({ onProgress: (p) => seen.push(p) }));
    assert.deepEqual(seen, [{ stage: "starting" }, { stage: "rendering", progress: 0.1 }, { stage: "saving" }]);
  });
});
