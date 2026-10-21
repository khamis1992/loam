// Focused route test for transcript editing: rearrange + delete edits resolve to
// an ordered assembly and (optionally) persist the render-ready timeline sidecar.
// Uses the real task db against a temp data dir — no STT server (transcribe not exercised).
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable, Writable } from "node:stream";
import { describe, it, before, after } from "node:test";
import type { IncomingMessage } from "node:http";

type Json = Record<string, unknown>;

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
}

function fakeRequest(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []) as unknown as IncomingMessage;
  Object.assign(req, {
    method,
    url,
    headers: { host: "127.0.0.1:4321", "content-type": "application/json", ...headers },
  });
  return req;
}

const TRANSCRIPT = {
  mediaPath: "assets/timeline/00000000-0000-0000-0000-000000000000.mp4",
  duration: 6,
  segments: [
    { start: 0, end: 2, text: "one" },
    { start: 2, end: 4, text: "two" },
    { start: 4, end: 6, text: "three" },
  ],
};

type Handler = (req: IncomingMessage, res: FakeResponse, p: string, ctx?: { workspace: string }) => Promise<boolean>;

describe("transcript editing routes", () => {
  let tmpDir = "";
  let closeDb: () => void;
  let taskId = "";
  let workspace = "";
  let handler: Handler;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-tscript-routes-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const db = await import("../db.js");
    closeDb = (await import("../sqliteStore.js")).closeDb;
    const task = db.createTask("transcript edit route test", "tscript-route");
    taskId = task.id;
    db.setTaskMode(taskId, "media");
    workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    db.setTaskWorkspace(taskId, workspace);
    handler = (await import("../routes/transcript.js")).handleTranscriptRoutes as unknown as Handler;
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("does not handle unrelated paths", async () => {
    const res = new FakeResponse();
    const handled = await handler(fakeRequest("GET", "/api/other"), res, "/api/other", { workspace });
    assert.equal(handled, false);
  });

  it("rejects non-media tasks", async () => {
    const db = await import("../db.js");
    const askTask = db.createTask("plain task", "tscript-ask");
    const res = new FakeResponse();
    await handler(
      fakeRequest("POST", "/api/creative/transcript-edit", { taskId: askTask.id, transcript: TRANSCRIPT, edit: { kind: "words", indices: [0] } }),
      res,
      "/api/creative/transcript-edit",
      { workspace },
    );
    assert.equal(res.status, 400);
    assert.match(String(res.json().error), /media task/);
  });

  it("rearranges sentences into an ordered assembly with a render-ready timeline", async () => {
    const res = new FakeResponse();
    await handler(
      fakeRequest("POST", "/api/creative/transcript-edit", { taskId, transcript: TRANSCRIPT, edit: { kind: "move-segments", indices: [2], target: 0 } }),
      res,
      "/api/creative/transcript-edit",
      { workspace },
    );
    assert.equal(res.status, 200);
    const json = res.json();
    assert.equal(json.removed, 0);
    assert.deepEqual(json.clips, [{ start: 4, end: 6 }, { start: 0, end: 4 }]);
    assert.equal(json.textAfter, "three one two");
    assert.equal((json.timeline as Json).sourceDuration, 6);
    const clips = (json.timeline as Json).clips as Json[];
    assert.deepEqual(clips, [{ id: "clip-1", in: 4, out: 6 }, { id: "clip-2", in: 0, out: 4 }]);
    assert.deepEqual((json.timeline as Json).overlays, []);
  });

  it("deletes words and keeps the cuts response fields", async () => {
    const res = new FakeResponse();
    await handler(
      fakeRequest("POST", "/api/creative/transcript-edit", { taskId, transcript: TRANSCRIPT, edit: { kind: "segments", indices: [1] } }),
      res,
      "/api/creative/transcript-edit",
      { workspace },
    );
    assert.equal(res.status, 200);
    const json = res.json();
    assert.equal(json.count, 1);
    assert.deepEqual(json.cuts, [{ start: 2, end: 4 }]);
    assert.deepEqual(json.keeps, [{ start: 0, end: 2 }, { start: 4, end: 6 }]);
    assert.equal(json.removed, 2);
    assert.equal(json.droppedClips, 0);
    const timeline = (json.timeline ?? {}) as Json;
    const tlClips = timeline.clips as Json[];
    assert.ok(Array.isArray(tlClips) && tlClips.length === 2);
  });

  it("saves the timeline EDL sidecar beside the media asset", async () => {
    const mediaRel = "assets/timeline/00000000-0000-0000-0000-000000000010.mp4";
    fs.mkdirSync(path.join(workspace, "assets", "timeline"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ...mediaRel.split("/")), "placeholder");
    const res = new FakeResponse();
    await handler(
      fakeRequest("POST", "/api/creative/transcript-edit", { taskId, path: mediaRel, save: true, transcript: TRANSCRIPT, edit: { kind: "segments", indices: [1] } }),
      res,
      "/api/creative/transcript-edit",
      { workspace },
    );
    assert.equal(res.status, 200);
    const json = res.json();
    assert.equal(json.savedTo, `${mediaRel}.edl.json`);
    const sidecar = JSON.parse(fs.readFileSync(path.join(workspace, ...(`${mediaRel}.edl.json`).split("/")), "utf8")) as Json;
    const clips = sidecar.clips as Json[];
    assert.deepEqual(clips, [{ id: "clip-1", in: 0, out: 2 }, { id: "clip-2", in: 4, out: 6 }]);
    assert.equal(sidecar.version, 1);
  });

  it("validates edit input and rejects unknown kinds and missing targets", async () => {
    const res1 = new FakeResponse();
    await handler(
      fakeRequest("POST", "/api/creative/transcript-edit", { taskId, transcript: TRANSCRIPT, edit: { kind: "rotate" } }),
      res1,
      "/api/creative/transcript-edit",
      { workspace },
    );
    assert.equal(res1.status, 400);
    const res2 = new FakeResponse();
    await handler(
      fakeRequest("POST", "/api/creative/transcript-edit", { taskId, transcript: TRANSCRIPT, edit: { kind: "move-segments", indices: [0] } }),
      res2,
      "/api/creative/transcript-edit",
      { workspace },
    );
    assert.equal(res2.status, 400);
    assert.match(String(res2.json().error), /move target/);
    const res3 = new FakeResponse();
    await handler(
      fakeRequest("POST", "/api/creative/transcript-edit", { taskId, transcript: TRANSCRIPT, edit: { kind: "words", indices: [] } }),
      res3,
      "/api/creative/transcript-edit",
      { workspace },
    );
    assert.equal(res3.status, 400);
  });
});
