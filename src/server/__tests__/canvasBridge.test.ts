/**
 * Neo N17: the external-agent canvas bridge.
 *
 * The bridge is a third surface onto the same run graph the in-app agent builds
 * (N1) and the web client reads (N2), so these tests pin the guarantees an
 * *external* session depends on:
 *   1. submit creates one canvas node per request and the node is visible on the
 *      canvas (`/nodes`) immediately, as `running`;
 *   2. `--parallel <n>` gives that agent its own cursor, so parallel agents never
 *      overwrite each other's node;
 *   3. batch accepts a fan-out, reports its rejects instead of failing, and each
 *      arm gets its own cursor;
 *   4. `--follow` blocks until the node settles, and the run engine's result lands
 *      in the node's `data.text` (or `data.error` on failure);
 *   5. the SSE stream opens with a snapshot and pushes one change per write;
 *   6. the WebSocket upgrade refuses a missing token and serves a live node change.
 *
 * The store is real (SQLite) behind a throwaway data directory, and the run engine
 * is the stub `globalThis.__loamRunTask` the app installs, so no network and no
 * model calls happen here.
 */
import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable, Writable, Duplex } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";
import type { IncomingMessage } from "node:http";

import { closeDb } from "../sqliteStore.js";
import { resetRunGraph, subscribeRunGraph } from "../../agent/runGraphAdapter.js";

const TOKEN = "test-token";

type Socket = typeof import("../bridge/canvasBridgeSocket.js");

type Json = Record<string, unknown>;

class FakeResponse extends Writable {
  status = 0;
  headers: Record<string, unknown> = {};
  private _headers: Record<string, unknown> = {};

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.status = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }

  setHeader(name: string, value: unknown): this {
    this._headers[name.toLowerCase()] = value;
    return this;
  }

  getHeader(name: string): unknown {
    return this._headers[name.toLowerCase()];
  }

  hasHeader(name: string): boolean {
    return name.toLowerCase() in this._headers;
  }

  _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.body.push(Buffer.from(chunk));
    callback();
  }

  body: Buffer[] = [];

  text(): string {
    return Buffer.concat(this.body).toString("utf8");
  }

  json(): Json {
    return JSON.parse(this.text()) as Json;
  }

  /** The SSE frames written so far, as parsed payloads. */
  frames(): Json[] {
    return this.text()
      .split("\n\n")
      .map((frame) => frame.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? "")
      .filter((payload) => payload.length > 0)
      .map((payload) => JSON.parse(payload) as Json);
  }
}

function fakeRequest(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []) as unknown as IncomingMessage;
  Object.assign(req, {
    method,
    url,
    headers: { host: "127.0.0.1:3939", "content-type": "application/json", ...headers },
  });
  return req;
}

type Handler = (
  req: IncomingMessage,
  res: FakeResponse,
  rawPath: string,
  ctx?: { enabled?: boolean },
) => Promise<boolean>;

const CANVAS = "task_bridge_acceptance";

let tmpDir = "";
let prevDataDir: string | undefined;
let handler: Handler;
let parentHandler: Handler;
let socket: Socket;

describe("canvas bridge (neo n17)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-canvas-bridge-"));
    prevDataDir = process.env.MANUS_LOCAL_DATA_DIR;
    process.env.MANUS_LOCAL_DATA_DIR = path.join(tmpDir, "data");
    process.env.LOAM_LOCAL_TOKEN_DIR = path.join(tmpDir, "auth");
    process.env.LOAM_AUTH_DISABLED = "true";
    fs.mkdirSync(process.env.LOAM_LOCAL_TOKEN_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.LOAM_LOCAL_TOKEN_DIR, ".loam-local-auth-token"), TOKEN, "utf8");
    const db = await import("../db.js");
    db.loadDb();
    const agents = await import("../agents.js");
    agents.createAgent({ name: "OpenCode", source: "canvasBridge" });
    socket = await import("../bridge/canvasBridgeSocket.js");
    handler = (await import("../routes/canvasBridge.js")).handleCanvasBridgeRoutes as unknown as Handler;
    parentHandler = (await import("../routes/canvasBridge.js")).handleCanvasBridgeParentRoutes as unknown as Handler;
  });

  after(async () => {
    delete process.env.LOAM_AUTH_DISABLED;
    if (prevDataDir === undefined) delete process.env.MANUS_LOCAL_DATA_DIR;
    else process.env.MANUS_LOCAL_DATA_DIR = prevDataDir;
    try {
      closeDb();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  beforeEach(async () => {
    closeDb();
    resetRunGraph();
    const db = await import("../db.js");
    db.loadDb();
    resetRunGraph();
  });

  it("ignores paths that are not bridge routes", async () => {
    const res = new FakeResponse();
    assert.equal(await handler(fakeRequest("GET", "/api/other"), res, "/api/other", {}), false);
  });

  it("answers 503 while the bridge is disabled instead of writing", async () => {
    const res = new FakeResponse();
    assert.equal(await handler(fakeRequest("GET", `/api/bridge/canvas/${CANVAS}/status`), res, `/api/bridge/canvas/${CANVAS}/status`, { enabled: false }), true);
    assert.equal(res.status, 503);
  });

  it("registers an identity and creates the canvas on demand", async () => {
    const res = new FakeResponse();
    assert.equal(
      await handler(fakeRequest("POST", "/api/bridge/canvas/identity", { canvasId: CANVAS, agentRef: "opencode" }), res, "/api/bridge/canvas/identity", {}),
      true,
    );
    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.canvasId, CANVAS);
    assert.equal(body.created, true, "an unknown canvas id is created, not rejected");
    assert.equal(body.agentName, "OpenCode", "a known agent ref resolves to that companion");
    assert.equal((body.cursors as string[]).length, 1);
  });

  it("submits a prompt, shows the node on the canvas live, and finishes it with the run text", async () => {
    // The run engine the app installs; the bridge must work without one too.
    const previous = (globalThis as { __loamRunTask?: unknown }).__loamRunTask;
    (globalThis as { __loamRunTask?: unknown }).__loamRunTask = async () => ({ taskId: CANVAS, text: "bridge finished" });
    try {
      const submitted = new FakeResponse();
      assert.equal(
        await handler(
          fakeRequest("POST", "/api/bridge/canvas/submit", { canvasId: CANVAS, agentRef: "opencode", prompt: "Summarise the report" }),
          submitted,
          "/api/bridge/canvas/submit",
          {},
        ),
        true,
      );
      assert.equal(submitted.status, 202);
      const accepted = submitted.json();
      assert.equal(accepted.canvasId, CANVAS);
      assert.equal(accepted.status, "running");
      const nodeId = accepted.nodeId as string;
      assert.ok(nodeId, "the reply names the node the agent just created");

      // The acceptance criterion: the node is on the canvas immediately, visible
      // to anything reading the canvas (the web client, another agent, the CLI).
      const live = new FakeResponse();
      await handler(fakeRequest("GET", `/api/bridge/canvas/${CANVAS}/nodes`), live, `/api/bridge/canvas/${CANVAS}/nodes`, {});
      const nodes = live.json().nodes as Array<{ id: string; type: string; status: string }>;
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0]!.id, nodeId);
      assert.equal(nodes[0]!.type, "canvas_bridge");
      assert.equal(nodes[0]!.status, "running");

      // `--follow <id>`: the same request settles and carries the run's text.
      const followed = new FakeResponse();
      await handler(
        fakeRequest("POST", "/api/bridge/canvas/submit", { canvasId: CANVAS, agentRef: "opencode", prompt: "Second pass", follow: true }),
        followed,
        "/api/bridge/canvas/submit",
        {},
      );
      assert.equal(followed.status, 200, "follow answers 200, not 202");
      assert.equal(followed.json().status, "finished");
      assert.equal((followed.json().node as { data?: { text?: string } }).data?.text, "bridge finished");

      const result = new FakeResponse();
      await handler(fakeRequest("GET", `/api/bridge/canvas/${CANVAS}/result/${nodeId}`), result, `/api/bridge/canvas/${CANVAS}/result/${nodeId}`, {});
      assert.equal(result.status, 200);
      assert.equal((result.json().node as { data?: { text?: string } }).data?.text, "bridge finished");
    } finally {
      if (previous === undefined) delete (globalThis as { __loamRunTask?: unknown }).__loamRunTask;
      else (globalThis as { __loamRunTask?: unknown }).__loamRunTask = previous;
    }
  });

  it("accepts a submit without a run engine and leaves the cursor running", async () => {
    const previous = (globalThis as { __loamRunTask?: unknown }).__loamRunTask;
    delete (globalThis as { __loamRunTask?: unknown }).__loamRunTask;
    try {
      const res = new FakeResponse();
      await handler(
        fakeRequest("POST", "/api/bridge/canvas/submit", { canvasId: CANVAS, agentRef: "opencode", prompt: "no engine" }),
        res,
        "/api/bridge/canvas/submit",
        {},
      );
      assert.equal(res.status, 202);
      assert.equal(res.json().status, "running");
      const status = new FakeResponse();
      await handler(fakeRequest("GET", `/api/bridge/canvas/${CANVAS}/status`), status, `/api/bridge/canvas/${CANVAS}/status`, {});
      assert.equal(status.status, 200);
      assert.equal(status.json().status, "done", "the cursor node is written even without a run engine");
    } finally {
      if (previous !== undefined) (globalThis as { __loamRunTask?: unknown }).__loamRunTask = previous;
    }
  });

  it("gives every parallel agent its own cursor and its own node", async () => {
    const cursors: string[] = [];
    for (const parallel of [1, 2, 3]) {
      const res = new FakeResponse();
      await handler(
        fakeRequest("POST", "/api/bridge/canvas/submit", { canvasId: CANVAS, agentRef: "opencode", prompt: `arm ${parallel}`, parallel }),
        res,
        "/api/bridge/canvas/submit",
        {},
      );
      cursors.push(res.json().cursorId as string);
      assert.equal(res.json().status, "running");
    }
    assert.equal(new Set(cursors).size, 3, "three arms must not share a cursor");
    assert.ok(cursors[0]!.includes("parallel1"), "the arm number is part of the cursor id");

    const nodes = new FakeResponse();
    await handler(fakeRequest("GET", `/api/bridge/canvas/${CANVAS}/nodes?type=canvas_bridge`), nodes, `/api/bridge/canvas/${CANVAS}/nodes?type=canvas_bridge`, {});
    const listed = nodes.json().nodes as Array<{ id: string }>;
    assert.equal(listed.length, 3, "each parallel agent is its own node on the canvas");
    assert.deepEqual(
      listed.map((node) => node.id).sort(),
      [...cursors].sort(),
      "the nodes are exactly the arms' cursors",
    );
  });

  it("batch accepts a fan-out, gives each arm its own cursor, and reports rejects", async () => {
    const res = new FakeResponse();
    assert.equal(
      await handler(
        fakeRequest("POST", "/api/bridge/canvas/batch", {
          canvasId: CANVAS,
          agentRef: "opencode",
          nodes: [{ prompt: "arm one" }, { title: "no prompt" }, "arm three"],
        }),
        res,
        "/api/bridge/canvas/batch",
        {},
      ),
      true,
    );
    assert.equal(res.status, 202);
    const body = res.json();
    assert.equal((body.accepted as unknown[]).length, 2);
    assert.equal((body.rejected as Array<{ index: number }>).length, 1);
    assert.equal((body.rejected as Array<{ index: number }>)[0]!.index, 1, "the unusable entry is reported, not fatal");
    const cursors = (body.accepted as Array<{ cursorId: string }>).map((entry) => entry.cursorId);
    assert.notEqual(cursors[0], cursors[1], "each arm gets its own cursor");
  });

  it("refuses a submit whose prompt is missing or cross-site", async () => {
    const empty = new FakeResponse();
    await handler(fakeRequest("POST", "/api/bridge/canvas/submit", { canvasId: CANVAS, agentRef: "opencode" }), empty, "/api/bridge/canvas/submit", {});
    assert.equal(empty.status, 400);

    const crossSite = new FakeResponse();
    await handler(
      fakeRequest("POST", "/api/bridge/canvas/submit", { canvasId: CANVAS, prompt: "x" }, { origin: "https://evil.example" }),
      crossSite,
      "/api/bridge/canvas/submit",
      {},
    );
    assert.equal(crossSite.status, 403, "a cross-site mutation is refused");
  });

  it("streams a snapshot on connect and one change per graph write", async () => {
    const res = new FakeResponse();
    assert.equal(await handler(fakeRequest("GET", `/api/bridge/canvas/${CANVAS}/stream`), res, `/api/bridge/canvas/${CANVAS}/stream`, {}), true);
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(res.headers["x-accel-buffering"], "no", "a proxy must not buffer the live stream");

    const frames = res.frames();
    assert.equal(frames.length, 1, "the stream opens with exactly one snapshot");
    assert.equal(frames[0]!.type, "snapshot");
    assert.equal(frames[0]!.runId, CANVAS);

    // A graph write (here the bridge's own submit) publishes one change.
    const submit = new FakeResponse();
    await handler(
      fakeRequest("POST", "/api/bridge/canvas/submit", { canvasId: CANVAS, agentRef: "opencode", prompt: "streamed" }),
      submit,
      "/api/bridge/canvas/submit",
      {},
    );
    const changed = res.frames();
    assert.equal(changed.length, 2, "one change frame after the write");
    assert.equal(changed[1]!.type, "change");
    assert.equal((changed[1]!.nodeIds as string[]).length, 1, "the change names the node it touched");
    res.destroy();
  });

  it("reports a follow on an unknown node as not found", async () => {
    const res = new FakeResponse();
    await handler(fakeRequest("GET", `/api/bridge/canvas/${CANVAS}/follow/task_nope`), res, `/api/bridge/canvas/${CANVAS}/follow/task_nope`, {});
    assert.equal(res.status, 404);
  });

  it("patches node data and re-points parents through the bridge surface", async () => {
    const submit = new FakeResponse();
    await handler(
      fakeRequest("POST", "/api/bridge/canvas/submit", { canvasId: CANVAS, agentRef: "opencode", prompt: "patch me" }),
      submit,
      "/api/bridge/canvas/submit",
      {},
    );
    const nodeId = submit.json().nodeId as string;

    const patched = new FakeResponse();
    await handler(
      fakeRequest("PATCH", `/api/bridge/canvas/${CANVAS}/nodes`, { nodes: [{ id: nodeId, data: { text: "edited" } }] }),
      patched,
      `/api/bridge/canvas/${CANVAS}/nodes`,
      {},
    );
    assert.equal(patched.status, 200);
    assert.equal(((patched.json().nodes as Array<{ data?: { text?: string } }>)[0]!.data ?? {}).text, "edited");

    const other = new FakeResponse();
    await handler(
      fakeRequest("POST", "/api/bridge/canvas/submit", { canvasId: CANVAS, agentRef: "opencode", prompt: "child" }),
      other,
      "/api/bridge/canvas/submit",
      {},
    );
    const childId = other.json().nodeId as string;
    const repointed = new FakeResponse();
    // Parent re-pointing is its own route (a different write surface than status/data).
    assert.equal(
      await parentHandler(
        fakeRequest("PATCH", `/api/bridge/canvas/${CANVAS}/nodes/${childId}`, { parentIds: [nodeId] }),
        repointed,
        `/api/bridge/canvas/${CANVAS}/nodes/${childId}`,
        {},
      ),
      true,
    );
    assert.equal(repointed.status, 200);
    assert.deepEqual((repointed.json().node as { parent_ids: string[] }).parent_ids, [nodeId]);
  });

  it("computes the RFC6455 accept key", () => {
    // RFC 6455 section 1.3 example, the one value every client checks.
    assert.equal(socket.acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
});

describe("canvas bridge upgrade", () => {
  let server: http.Server;
  let base = "";

  before(async () => {
    const routes = (await import("../routes/canvasBridge.js")) as unknown as {
      createCanvasBridgeUpgrade: (deps: {
        authenticate: (req: IncomingMessage) => boolean;
        subscribe: (canvasId: string, listener: (change: { runId: string; nodeIds: string[]; seq: number }) => void) => () => void;
      }) => (req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => boolean;
    };
    server = http.createServer((req, res) => {
      res.writeHead(404).end();
    });
    const upgrade = routes.createCanvasBridgeUpgrade({
      authenticate: (req) => {
        // The production rule: the install token, header or `?token=`.
        const url = new URL(req.url ?? "/", "http://x");
        const token = typeof req.headers["x-loam-local-token"] === "string" ? req.headers["x-loam-local-token"] : url.searchParams.get("token") ?? undefined;
        return token === "good-token";
      },
      subscribe: (canvasId, listener) => subscribeRunGraph(canvasId, listener),
    });
    server.on("upgrade", (req, socket, head) => {
      const sock = socket as import("node:net").Socket;
      if (!upgrade(req, sock, head)) sock.destroy();
    });
    base = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as import("node:net").AddressInfo;
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Handshake, read one text frame, then close. */
  function readOneFrame(path: string): Promise<Json> {
    const key = crypto.randomBytes(16).toString("base64");
    const url = new URL(base + path);
    return new Promise((resolve, reject) => {
      const request = http.request({
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": key,
          "sec-websocket-version": "13",
        },
      });
      request.on("upgrade", (_res, socket: import("node:net").Socket) => {
        const reader = new BridgeSocketReader(socket, (text) => {
          socket.destroy();
          try {
            resolve(JSON.parse(text) as Json);
          } catch {
            resolve({ raw: text } as Json);
          }
        });
        void reader;
      });
      request.on("response", () => reject(new Error("the upgrade was refused")));
      request.on("error", reject);
      request.end();
    });
  }

  it("pushes a live node change to a connected socket", async () => {
    const frame = readOneFrame(`/api/bridge/canvas/${CANVAS}/ws?token=good-token`);
    // The bridge writes a node; the socket must receive it without being asked.
    const submit = new FakeResponse();
    await handler(
      fakeRequest("POST", "/api/bridge/canvas/submit", { canvasId: CANVAS, agentRef: "opencode", prompt: "live socket" }),
      submit,
      "/api/bridge/canvas/submit",
      {},
    );
    const payload = await frame;
    assert.equal(payload.type, "change", "the socket carries the node change");
    assert.equal(payload.runId, CANVAS);
    assert.equal((payload.nodeIds as string[]).length, 1);
  });

  it("refuses an upgrade without a token", async () => {
    const url = new URL(base + `/api/bridge/canvas/${CANVAS}/ws`);
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
          "sec-websocket-version": "13",
        },
      });
      request.on("upgrade", () => reject(new Error("the upgrade should have been refused")));
      request.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 401, "a missing token is refused like every other /api route");
  });
});

/** Reads WebSocket text frames off a raw socket (enough for one push). */
class BridgeSocketReader {
  private buffer = Buffer.alloc(0);

  constructor(socket: import("node:net").Socket, private readonly onText: (text: string) => void) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const frame = this.read();
        if (!frame) return;
        this.onText(frame.toString("utf8"));
      }
    });
  }

  private read(): Buffer | undefined {
    const buf = this.buffer;
    if (buf.length < 2) return undefined;
    const masked = (buf[1]! & 0x80) !== 0;
    const length = buf[1]! & 0x7f;
    const offset = 2 + (masked ? 4 : 0) + (length === 126 ? 2 : length === 127 ? 8 : 0);
    const size = length === 126 ? buf.readUInt16BE(2) : length === 127 ? Number(buf.readBigUInt64BE(2)) : length;
    if (buf.length < offset + size) return undefined;
    const payload = buf.subarray(offset, offset + size);
    this.buffer = buf.subarray(offset + size);
    return payload;
  }
}
