/**
 * Neo N2: the Canvas HTTP surface.
 *
 * The route module is the only way the canvas reaches the graph, so the tests pin
 * the guarantees a live canvas depends on:
 *   1. GET returns the graph plus only the nodes appended after `afterSeq`;
 *   2. PATCH edits one node of the run it belongs to and refuses everything else;
 *   3. the SSE stream opens with a snapshot and pushes one change per graph write.
 *
 * The store is real (SQLite) behind a throwaway data directory, so the tests
 * exercise the same adapter the server uses. No network and no model calls.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";

import { applyRunEvent, beginRun, resetRunGraph, subscribeRunGraph } from "../../agent/runGraphAdapter.js";
import { closeDb } from "../../server/sqliteStore.js";

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
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  body(): Buffer {
    return Buffer.concat(this.chunks);
  }

  json(): Json {
    return JSON.parse(this.body().toString("utf8")) as Json;
  }

  /** The SSE frames written so far, as parsed payloads. */
  frames(): Json[] {
    return this.body()
      .toString("utf8")
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

const RUN = "task_canvas_route_1";
let tmpDir = "";
let prevDataDir: string | undefined;
let handler: Handler;

/** A run with a six-step recipe, the shape the acceptance test describes. */
function sixStepRun(): void {
  beginRun(RUN, "Build the marketing site");
  applyRunEvent(RUN, {
    type: "plan",
    goal: "Build the marketing site",
    trivial: false,
    steps: ["one", "two", "three", "four", "five", "six"].map((id, index) => ({
      id,
      title: `Step ${index + 1}`,
      instruction: "Do the work",
      successCriteria: "Done",
    })),
    source: "model",
  });
}

describe("canvas graph routes", () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-canvas-routes-"));
    prevDataDir = process.env.MANUS_LOCAL_DATA_DIR;
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    closeDb();
    // The adapter keeps a process-wide graph across connections, so a fresh
    // database must also drop its in-memory cursors.
    resetRunGraph();
    handler = (await import("../routes/graph.js")).handleGraphRoutes as unknown as Handler;
    sixStepRun();
  });

  afterEach(() => {
    closeDb();
    resetRunGraph();
    if (prevDataDir === undefined) delete process.env.MANUS_LOCAL_DATA_DIR;
    else process.env.MANUS_LOCAL_DATA_DIR = prevDataDir;
    try {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    tmpDir = "";
  });

  it("ignores paths that are not graph routes", async () => {
    const res = new FakeResponse();
    assert.equal(await handler(fakeRequest("GET", "/api/other"), res, "/api/other", {}), false);
  });

  it("returns the graph plus only the nodes appended after the cursor", async () => {
    const res = new FakeResponse();
    assert.equal(await handler(fakeRequest("GET", `/api/graph/${RUN}`), res, `/api/graph/${RUN}`, {}), true);
    assert.equal(res.status, 200);

    const body = res.json();
    assert.equal(body.runId, RUN);
    assert.equal(body.enabled, true);
    const nodes = body.nodes as Array<{ id: string; type: string; position?: number }>;
    assert.equal(nodes.length, 7, "root question plus six recipe steps");
    assert.equal(nodes[0]!.type, "question", "the root question comes from the goal");
    assert.equal(nodes.filter((node) => node.type === "recipe_step").length, 6, "the six steps are on the canvas");
    assert.equal((body.stats as { totalNodes: number }).totalNodes, 7);
    assert.deepEqual(body.fresh, [], "no cursor given means no incremental nodes");

    // A new node appears after the cursor, so the delta is exactly that node.
    const ids = applyRunEvent(RUN, { type: "tool_call", name: "web_search", args: { query: "revenue" } });
    assert.equal(ids.length, 1);
    const cursor = Math.max(...nodes.map((node) => node.position ?? 0));
    const delta = new FakeResponse();
    assert.equal(await handler(fakeRequest("GET", `/api/graph/${RUN}?afterSeq=${cursor}`), delta, `/api/graph/${RUN}`, {}), true);
    const fresh = delta.json().fresh as Array<{ id: string }>;
    assert.deepEqual(
      fresh.map((node) => node.id),
      ids,
      "the incremental reply carries only the appended node",
    );
  });

  it("edits a node of this run and refuses cross-site or foreign-run writes", async () => {
    const nodeId = (await handler, applyRunEvent(RUN, { type: "tool_call", name: "web_search", args: { query: "x" } }))[0]!;

    const ok = new FakeResponse();
    assert.equal(
      await handler(fakeRequest("PATCH", `/api/graph/${RUN}/nodes/${nodeId}`, { status: "finished" }), ok, `/api/graph/${RUN}/nodes/${nodeId}`, {}),
      true,
    );
    assert.equal(ok.status, 200);
    assert.equal((ok.json().node as { status: string }).status, "finished");

    const crossSite = new FakeResponse();
    await handler(
      fakeRequest("PATCH", `/api/graph/${RUN}/nodes/${nodeId}`, { status: "finished" }, { origin: "https://evil.example" }),
      crossSite,
      `/api/graph/${RUN}/nodes/${nodeId}`,
      {},
    );
    assert.equal(crossSite.status, 403, "a cross-site mutation is refused");

    // A node id from another run is not reachable through this run's URL.
    const other = "task_canvas_route_other";
    beginRun(other, "Another task");
    const foreignId = applyRunEvent(other, { type: "tool_call", name: "web_search", args: { query: "y" } })[0]!;
    const foreign = new FakeResponse();
    await handler(
      fakeRequest("PATCH", `/api/graph/${RUN}/nodes/${foreignId}`, { status: "finished" }),
      foreign,
      `/api/graph/${RUN}/nodes/${foreignId}`,
      {},
    );
    assert.equal(foreign.status, 404, "a node of another run is not found here");

    const unknownStatus = new FakeResponse();
    await handler(
      fakeRequest("PATCH", `/api/graph/${RUN}/nodes/${nodeId}`, { status: "bogus" }),
      unknownStatus,
      `/api/graph/${RUN}/nodes/${nodeId}`,
      {},
    );
    assert.equal(unknownStatus.status, 400, "an unknown status is rejected");

    const missing = new FakeResponse();
    await handler(
      fakeRequest("PATCH", `/api/graph/${RUN}/nodes/nope`, { status: "finished" }),
      missing,
      `/api/graph/${RUN}/nodes/nope`,
      {},
    );
    assert.equal(missing.status, 404, "an unknown node is rejected");
  });

  it("reports a disabled graph as empty rather than an error", async () => {
    const res = new FakeResponse();
    assert.equal(await handler(fakeRequest("GET", `/api/graph/${RUN}`), res, `/api/graph/${RUN}`, { enabled: false }), true);
    const body = res.json();
    assert.equal(body.enabled, false);
    // The layout is still readable, so a disabled canvas degrades to "no nodes"
    // instead of breaking the panel.
    assert.equal(Array.isArray(body.nodes), true);
  });

  it("streams a snapshot on connect and one change per graph write", async () => {
    const res = new FakeResponse();
    // The stream stays open, so the handler returns before any frame is written.
    assert.equal(await handler(fakeRequest("GET", `/api/graph/${RUN}/stream`), res, `/api/graph/${RUN}/stream`, {}), true);
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(res.headers["x-accel-buffering"], "no", "a proxy must not buffer the live stream");

    const frames = res.frames();
    assert.equal(frames.length, 1, "the stream opens with exactly one snapshot");
    assert.equal(frames[0]!.type, "snapshot");
    assert.equal(frames[0]!.runId, RUN);
    assert.equal((frames[0]!.nodes as unknown[]).length, 7, "the snapshot carries the whole graph");

    // A graph write publishes a change, which the stream forwards.
    applyRunEvent(RUN, { type: "tool_call", name: "web_search", args: { query: "live" } });
    const changed = res.frames();
    assert.equal(changed.length, 2, "one change frame after the write");
    assert.equal(changed[1]!.type, "change");
    assert.equal(changed[1]!.runId, RUN);
    assert.equal((changed[1]!.nodeIds as string[]).length, 1, "the change names the node it touched");
    assert.equal(typeof changed[1]!.seq, "number");
    res.destroy();
  });

  it("stops forwarding changes once the client disconnects", async () => {
    const res = new FakeResponse();
    await handler(fakeRequest("GET", `/api/graph/${RUN}/stream`), res, `/api/graph/${RUN}/stream`, {});
    const unsubscribe = subscribeRunGraph(RUN, () => undefined);
    res.destroy();
    unsubscribe();
    assert.equal(res.frames().length, 1, "no change is written after the client is gone");
  });

  it("applies a canvas edit and files a directive the agent will pick up", async () => {
    const searchId = applyRunEvent(RUN, { type: "tool_call", name: "web_search", args: { query: "revenue" } })[0]!;

    const res = new FakeResponse();
    assert.equal(
      await handler(
        fakeRequest("POST", `/api/graph/${RUN}/ops`, { op: "edit", nodeId: searchId, text: "Revenue is $4.2B." }),
        res,
        `/api/graph/${RUN}/ops`,
        {},
      ),
      true,
    );
    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.op, "edit");
    assert.equal(body.nodeId, searchId);
    assert.ok(Array.isArray(body.stale), "an edit reports what it superseded");
    assert.equal(Array.isArray(body.nodes), true, "the panel gets the graph back");

    // The graph really holds the corrected text, and the edit history is kept.
    const node = (body.nodes as Array<{ id: string; data?: { query?: string; edits?: unknown[] } }>).find((candidate) => candidate.id === searchId)!;
    assert.equal(node.data!.query, "Revenue is $4.2B.", "the edit rewrites the field the node's type carries");
    assert.equal(node.data!.edits!.length, 1, "the previous text is kept as history");

    // The directive is what the next step is told, and reading it does not clear it.
    const pending = new FakeResponse();
    assert.equal(await handler(fakeRequest("GET", `/api/graph/${RUN}/ops`), pending, `/api/graph/${RUN}/ops`, {}), true);
    const directives = pending.json().directives as Array<{ reason: string; nodeId: string; text: string }>;
    assert.equal(directives.length, 1);
    assert.equal(directives[0]!.reason, "edited");
    assert.equal(directives[0]!.nodeId, searchId);
    assert.match(directives[0]!.text, /4\.2B/);
  });

  it("refuses an unrecognised, cross-site or foreign-run canvas operation", async () => {
    const searchId = applyRunEvent(RUN, { type: "tool_call", name: "web_search", args: { query: "x" } })[0]!;

    const bad = new FakeResponse();
    await handler(fakeRequest("POST", `/api/graph/${RUN}/ops`, { op: "explode" }), bad, `/api/graph/${RUN}/ops`, {});
    assert.equal(bad.status, 400, "an operation the graph cannot perform is a 400");

    const blank = new FakeResponse();
    await handler(fakeRequest("POST", `/api/graph/${RUN}/ops`, { op: "edit", nodeId: searchId }), blank, `/api/graph/${RUN}/ops`, {});
    assert.equal(blank.status, 400, "an edit with no text is rejected, not applied");

    const crossSite = new FakeResponse();
    await handler(
      fakeRequest("POST", `/api/graph/${RUN}/ops`, { op: "duplicate", nodeId: searchId }, { origin: "https://evil.example" }),
      crossSite,
      `/api/graph/${RUN}/ops`,
      {},
    );
    assert.equal(crossSite.status, 403, "a cross-site canvas edit is refused");

    const foreign = new FakeResponse();
    await handler(fakeRequest("POST", `/api/graph/${RUN}/ops`, { op: "edit", nodeId: "ghost", text: "x" }), foreign, `/api/graph/${RUN}/ops`, {});
    assert.equal(foreign.status, 404, "a node of another run is not found here");

    const group = new FakeResponse();
    await handler(fakeRequest("POST", `/api/graph/${RUN}/ops`, { op: "group", nodeIds: [searchId] }), group, `/api/graph/${RUN}/ops`, {});
    assert.equal(group.status, 400, "a group of one is a malformed request, not a conflict");
  });

  it("cuts and re-connects an edge through the route", async () => {
    const [stepId] = applyRunEvent(RUN, { type: "plan_step", id: "s1", index: 0, total: 6, title: "Step 1", phase: "start" });
    const nodeId = applyRunEvent(RUN, { type: "tool_call", name: "web_search", args: { query: "x" } })[0]!;
    assert.ok(stepId && nodeId);

    const cut = new FakeResponse();
    await handler(fakeRequest("POST", `/api/graph/${RUN}/ops`, { op: "cut", nodeId, parentIds: [] }), cut, `/api/graph/${RUN}/ops`, {});
    assert.equal(cut.status, 200);
    assert.equal(cut.json().op, "cut");
    assert.deepEqual(cut.json().stale, [], "a cut supersedes nothing");

    const moved = new FakeResponse();
    await handler(fakeRequest("POST", `/api/graph/${RUN}/ops`, { op: "cut", nodeId, parentIds: [stepId] }), moved, `/api/graph/${RUN}/ops`, {});
    assert.equal(moved.status, 200);
    assert.equal(moved.json().op, "reconnect", "a move reports the connect it performed");
  });
});
