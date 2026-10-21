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

describe("workspace video routes", () => {
  let tmpDir = "";
  let closeDb: () => void;
  let taskId = "";
  let workspace = "";
  let handler: (req: IncomingMessage, res: FakeResponse, p: string, ctx?: { workspace: string }) => Promise<boolean>;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-wsv-routes-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const db = await import("../db.js");
    closeDb = (await import("../sqliteStore.js")).closeDb;
    const task = db.createTask("video editor route test", "wsv");
    taskId = task.id;
    workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    db.setTaskWorkspace(taskId, workspace);
    handler = (await import("../routes/workspaceVideo.js")).handleWorkspaceVideoRoutes as unknown as typeof handler;
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("ignores unrelated paths", async () => {
    const res = new FakeResponse();
    const handled = await handler(fakeRequest("GET", "/api/other"), res, "/api/other", { workspace });
    assert.equal(handled, false);
  });

  it("saves and reads raw task files with a relative path", async () => {
    const put = new FakeResponse();
    const url = `/api/workspace/video/file?taskId=${taskId}&path=${encodeURIComponent("notes.txt")}`;
    assert.equal(await handler(fakeRequest("PUT", url, "hello"), put, "/api/workspace/video/file", { workspace }), true);
    assert.equal(put.status, 200);
    assert.equal(fs.readFileSync(path.join(workspace, "notes.txt"), "utf8"), "hello");

    const get = new FakeResponse();
    const flushed = new Promise<void>((resolve) => get.once("finish", () => resolve()));
    assert.equal(await handler(fakeRequest("GET", url), get, "/api/workspace/video/file", { workspace }), true);
    await flushed;
    assert.equal(get.status, 200);
    assert.equal(get.body().toString("utf8"), "hello");
  });

  it("rejects traversal and missing task files", async () => {
    const escape = new FakeResponse();
    const bad = `/api/workspace/video/file?taskId=${taskId}&path=${encodeURIComponent("../escape.mp4")}`;
    assert.equal(await handler(fakeRequest("GET", bad), escape, "/api/workspace/video/file", { workspace }), true);
    assert.equal(escape.status, 400);

    const missing = new FakeResponse();
    const url = `/api/workspace/video/hydrate?taskId=${taskId}&path=missing.mp4`;
    assert.equal(await handler(fakeRequest("GET", url), missing, "/api/workspace/video/hydrate", { workspace }), true);
    assert.equal(missing.status, 404);
  });

  it("rejects render without taskId/path and blocks cross-site mutations", async () => {
    const empty = new FakeResponse();
    assert.equal(await handler(fakeRequest("POST", "/api/workspace/video/render", {}), empty, "/api/workspace/video/render", { workspace }), true);
    assert.equal(empty.status, 400);

    const crossSite = new FakeResponse();
    const url = `/api/workspace/video/file?taskId=${taskId}&path=x.txt`;
    await handler(fakeRequest("PUT", url, "x", { origin: "https://evil.example" }), crossSite, "/api/workspace/video/file", { workspace });
    assert.equal(crossSite.status, 403);
  });
});
