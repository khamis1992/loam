import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable, Writable } from "node:stream";
import { describe, it, before, after } from "node:test";
import type { IncomingMessage } from "node:http";

type Json = Record<string, unknown>;

interface LiveEventFrame {
  type: string;
  source?: string;
  data?: string | null;
  url?: string | null;
}

class FakeResponse extends Writable {
  status = 0;
  headers: Record<string, unknown> = {};
  chunks: Buffer[] = [];
  private _headers: Record<string, unknown> = {};

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.status = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }

  setHeader(name: string, value: unknown): this { this._headers[name.toLowerCase()] = value; return this; }
  getHeader(name: string): unknown { return this._headers[name.toLowerCase()]; }
  hasHeader(name: string): boolean { return name.toLowerCase() in this._headers; }
  _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  body(): Buffer { return Buffer.concat(this.chunks); }
  json(): Json { return JSON.parse(this.body().toString("utf8")) as Json; }
  events(): unknown[] {
    return this.body().toString("utf8").split("\n\n").filter((c) => c.startsWith("data: ")).map((c) =>
      JSON.parse(c.slice(6)) as unknown,
    );
  }
}

function fakeRequest(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []) as unknown as IncomingMessage;
  Object.assign(req, { method, url, headers: { host: "127.0.0.1:4321" } });
  return req;
}

interface ScreenLiveStub {
  running: boolean;
  latest(): { base64: string; mediaType: string; at: string; width: number; height: number; bytes: number; path: string; index: number } | null;
  status(): { running: boolean; fps: number; frames: number; subscribers: number; lastAt: string | null; width: number | null; height: number | null; bytes: number | null; lastError: string | null };
  start(fps?: number): void;
  stop(): void;
  subscribe(fn: (frame: unknown) => void): () => void;
}

describe("live view routes", () => {
  let tmpDir = "";
  let closeDb: () => void;
  let taskId = "";
  let handler: (req: IncomingMessage, res: FakeResponse, p: string, deps?: unknown) => Promise<boolean>;
  let framesMod: {
    publishBrowserFrame: (id: string, frame: { url: string; title?: string; jpegBase64?: string }) => boolean;
    resetBrowserFrames: () => void;
  };

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-liveview-routes-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    // `loadConfig()` mkdirs `workspace/` and `workspace/.screenshots/`; keep them
    // inside the temp dir rather than the repository tree.
    process.env.LOAM_ROOT = tmpDir;
    const db = await import("../db.js");
    closeDb = (await import("../sqliteStore.js")).closeDb;
    const task = db.createTask("live view route test", "lv");
    taskId = task.id;
    handler = (await import("../routes/liveView.js")).handleLiveViewRoutes as unknown as typeof handler;
    framesMod = (await import("../../tools/browserFrames.js")) as unknown as typeof framesMod;
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    framesMod.resetBrowserFrames();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("reports the feature flag: screen off without ScreenLive, browser always present", async () => {
    const res = new FakeResponse();
    const handled = await handler(fakeRequest("GET", `/api/live-view/status?taskId=${taskId}`), res, "/api/live-view/status");
    assert.ok(handled);
    assert.equal(res.status, 200);
    const body = res.json() as {
      available?: boolean;
      screen?: { available: boolean };
      browser?: { available: boolean; url: string | null };
    };
    assert.equal(body.screen?.available, false);
    assert.equal(body.browser?.available, true);
    assert.equal(body.available, true);
  });

  it("screen frame endpoint reports unavailable without ScreenLive", async () => {
    const res = new FakeResponse();
    const handled = await handler(
      fakeRequest("GET", `/api/live-view/frame?taskId=${taskId}&source=screen`),
      res,
      "/api/live-view/frame",
    );
    assert.ok(handled);
    assert.equal(res.status, 200);
    const body = res.json() as { source?: string; available?: boolean; frame?: unknown; error?: string };
    assert.equal(body.source, "screen");
    assert.equal(body.available, false);
    assert.equal(body.frame, null);
    assert.ok(body.error);
  });

  it("screen frame endpoint serves the latest frame once ScreenLive is provided", async () => {
    const stub: ScreenLiveStub = {
      running: false,
      latest() { return null; },
      status() {
        return { running: false, fps: 1, frames: 0, subscribers: 0, lastAt: null, width: null, height: null, bytes: null, lastError: null };
      },
      start(_fps?: number): void { /* noop */ },
      stop(): void { /* noop */ },
      subscribe(_fn: (frame: unknown) => void): () => void { return () => { /* noop */ }; },
    };
    const res = new FakeResponse();
    await handler(
      fakeRequest("GET", `/api/live-view/frame?taskId=${taskId}&source=screen`),
      res,
      "/api/live-view/frame",
      { screenLive: stub },
    );
    assert.equal(res.status, 200);
    assert.equal((res.json() as { available?: boolean }).available, true);
    assert.equal((res.json() as { frame?: unknown }).frame, null);
  });

  it("browser frame endpoint serves published task frames", async () => {
    const jpeg = Buffer.from("fakejpeg").toString("base64");
    framesMod.publishBrowserFrame(taskId, { url: "https://example.test/page", title: "Example", jpegBase64: jpeg });
    const res = new FakeResponse();
    await handler(
      fakeRequest("GET", `/api/live-view/frame?taskId=${taskId}&source=browser`),
      res,
      "/api/live-view/frame",
    );
    assert.equal(res.status, 200);
    const body = res.json() as { available?: boolean; frame?: { data?: string; url?: string; title?: string } | null };
    assert.equal(body.available, true);
    assert.equal(body.frame?.data, jpeg);
    assert.equal(body.frame?.url, "https://example.test/page");
    assert.equal(body.frame?.title, "Example");
  });

  it("stream endpoint pushes status + latest browser frames over SSE", async () => {
    const jpeg = Buffer.from("streamframe").toString("base64");
    framesMod.publishBrowserFrame(taskId, { url: "https://example.test/stream", jpegBase64: jpeg });
    const res = new FakeResponse();
    const req = fakeRequest("GET", `/api/live-view/stream?taskId=${taskId}&source=both`);
    const handled = await handler(req, res, "/api/live-view/stream");
    assert.ok(handled);
    assert.equal(res.status, 200);
    assert.match(String(res.headers["content-type"]), /text\/event-stream/);
    const events = res.events() as Array<LiveEventFrame>;
    assert.ok(events.some((e) => e.type === "status"));
    const frame = events.find((e) => e.type === "frame" && e.source === "browser");
    assert.ok(frame, "expected a browser frame event");
    assert.equal(frame.data, jpeg);
    // Clean up the handler's keepalive interval so the test process exits promptly.
    req.emit("close");
  });

  it("ignores non live-view paths", async () => {
    const res = new FakeResponse();
    const handled = await handler(fakeRequest("GET", "/api/browser/frame?taskId=x"), res, "/api/browser/frame");
    assert.equal(handled, false);
  });
});
