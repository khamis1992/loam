/**
 * Neo N14 acceptance tests: exporting a run as a static replay.
 *
 * The task asks for a self-contained static replay (run graph + outputs, secrets
 * stripped) with a timeline scrubber, view-only, sharing-aware. These tests pin
 * each clause:
 *
 *   1. the bundle carries the graph and the files the run produced;
 *   2. scrubbing reveals nodes in event order (frame N shows the first N nodes);
 *   3. every credential-shaped substring is gone, including in the run title;
 *   4. the standalone HTML makes no network request and is view-only;
 *   5. the share feed publishes the replay to anonymous readers only.
 *
 * The store is real (SQLite) behind a throwaway data directory, so the tests
 * exercise the same code path the server uses. No network and no model calls.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";

import type { AgentEvent } from "../../agent/events.js";
import { applyRunEvent, beginRun, resetRunGraph } from "../../agent/runGraphAdapter.js";
import {
  buildRunReplay,
  hasSecret,
  MAX_REPLAY_NODES,
  renderReplayHtml,
  scanReplayForSecrets,
} from "../export.js";
import { RunGraph } from "../runGraph.js";
import type { RunNode } from "../store.js";
import { handleGraphRoutes } from "../../server/routes/graph.js";
import { sanitizeTranscript } from "../../server/shares.js";
import { createTask, getTask, type Task } from "../../server/db.js";
import { closeDb, putEntity } from "../../server/sqliteStore.js";

const RUN = "task_replay_export_1";

/**
 * Insert a task row with an exact id and status. `createTask` mints its own id,
 * and the run graph is keyed by the Loam task id, so the fixture has to carry the
 * same id the nodes were recorded under.
 */
function makeTask(status: Task["status"]): void {
  const task = createTask("Export me", "Publish the quarterly report");
  const row: Task = { ...task, id: RUN, status };
  putEntity("tasks", row);
}

let tmpDir = "";
let prevDataDir: string | undefined;

function freshDataDir(prefix: string): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  prevDataDir = process.env.MANUS_LOCAL_DATA_DIR;
  process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
  closeDb();
  resetRunGraph();
}

function restoreDataDir(): void {
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
}

/** A recorded run: plan -> search -> document, with a token hidden in a tool arg. */
function recordedRun(runId: string): RunNode[] {
  const events: AgentEvent[] = [
    { type: "task", taskId: runId },
    {
      type: "plan",
      goal: "Publish the quarterly report",
      trivial: false,
      steps: [
        { id: "s1", title: "Gather sources", instruction: "Search", successCriteria: "3 sources" },
        { id: "s2", title: "Write the report", instruction: "Write", successCriteria: "Report exists" },
      ],
      source: "model",
    },
    { type: "plan_step", id: "s1", index: 1, total: 2, title: "Gather sources", phase: "start" },
    { type: "tool_call", name: "web_search", args: { query: "quarterly revenue" } },
    { type: "tool_result", name: "web_search", ok: true, summary: "3 sources found" },
    {
      type: "tool_call",
      name: "web_fetch",
      args: { url: "https://example.com/r", headers: { Authorization: "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" } },
    },
    { type: "tool_result", name: "web_fetch", ok: true, summary: "fetched" },
    { type: "plan_step", id: "s1", index: 1, total: 2, title: "Gather sources", phase: "done" },
    { type: "plan_step", id: "s2", index: 2, total: 2, title: "Write the report", phase: "start" },
    { type: "tool_call", name: "file_write", args: { path: "report.md", content: "hi" } },
    { type: "tool_result", name: "file_write", ok: true, summary: "wrote report.md" },
    { type: "plan_step", id: "s2", index: 2, total: 2, title: "Write the report", phase: "done" },
    { type: "critique", id: "s2", verdict: "pass", reason: "Report is complete" },
    { type: "done", text: "Published", steps: 2, model: "test" },
  ];
  beginRun(runId, "Publish the quarterly report");
  for (const event of events) applyRunEvent(runId, event);
  return new RunGraph().getRunNodes(runId);
}

/** Minimal RunNode, for the unit-shaped cases that do not need a live agent. */
function node(id: string, type: RunNode["type"], data: Record<string, unknown> | undefined, at: number): RunNode {
  return {
    id,
    run_id: RUN,
    parent_ids: [],
    type,
    status: "finished",
    ...(data !== undefined ? { data } : {}),
    version: 1,
    created: at,
    updated: at,
  };
}

class FakeResponse extends Writable {
  status = 0;
  headers: Record<string, unknown> = {};
  chunks: Buffer[] = [];

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.status = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }

  _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  body(): Buffer {
    return Buffer.concat(this.chunks);
  }

  json(): Record<string, unknown> {
    return JSON.parse(this.body().toString("utf8")) as Record<string, unknown>;
  }
}

function fakeRequest(method: string, url: string): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  Object.assign(req, { method, url, headers: { host: "127.0.0.1:3939" } });
  return req;
}

describe("run replay: the bundle", () => {
  beforeEach(() => freshDataDir("loam-replay-export-"));
  afterEach(() => restoreDataDir());

  it("carries the graph, the timeline and the files the run produced", () => {
    const nodes = recordedRun(RUN);
    const replay = buildRunReplay({ runId: RUN, title: "Publish the quarterly report", nodes });

    assert.equal(replay.runId, RUN);
    assert.equal(replay.stats.totalNodes, nodes.length);
    // One edge per non-root node: the graph is a chain here.
    assert.equal(replay.stats.edges, nodes.length - 1);
    // The scrubber frames are exactly the nodes, in event order.
    assert.deepEqual(replay.frames.map((f) => f.nodeId), replay.nodes.map((n) => n.id));
    assert.deepEqual(replay.frames.map((f) => f.index), replay.nodes.map((_, i) => i));
    // A frame label is a human sentence, not a raw payload dump.
    assert.ok(replay.frames.every((f) => f.label.length > 0));
    // The run produced report.md.
    assert.ok(replay.outputs.some((o) => o.path === "report.md"));
    // Timestamps are ISO strings, so a viewer never has to guess a timezone.
    assert.ok(!Number.isNaN(Date.parse(replay.createdAt)));
    assert.ok(!Number.isNaN(Date.parse(replay.generatedAt)));
  });

  it("reveals nodes in event order as the scrubber advances", () => {
    const nodes = recordedRun(RUN);
    const replay = buildRunReplay({ runId: RUN, title: "t", nodes });

    // Frame N shows the first N+1 nodes: that is the invariant the viewer's
    // render() loop depends on (rows[i].pending === i > upTo).
    for (let upTo = 0; upTo < replay.frames.length; upTo++) {
      const shown = new Set(replay.frames.slice(0, upTo + 1).map((f) => f.nodeId));
      assert.equal(shown.size, upTo + 1, `frame ${upTo} shows ${upTo + 1} nodes`);
      for (const frame of replay.frames) {
        const revealed = frame.index <= upTo;
        assert.equal(shown.has(frame.nodeId), revealed, `frame ${frame.index} at scrub ${upTo}`);
      }
    }
    // And the order is the order the agent emitted events in, not a re-sort.
    const ordered = replay.nodes.map((n) => n.created);
    for (let i = 1; i < ordered.length; i++) assert.ok(ordered[i]! >= ordered[i - 1]!, "nodes are in event order");
  });

  it("strips credentials from every node payload, including the run title", () => {
    const nodes = recordedRun(RUN);
    const leaky: RunNode = node("leak", "search", { query: "use key sk-abcdefghijklmnopqrstuv", url: "https://a.b/c" }, 9_999);
    const replay = buildRunReplay({
      runId: RUN,
      // The title is user-authored, so it is the one field that arrives from
      // outside the node payload and must be sanitized too.
      title: "Publish with api_key=supersecretvalue123",
      nodes: [...nodes, leaky],
    });

    const text = JSON.stringify(replay);
    assert.ok(!text.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "GitHub token is gone");
    assert.ok(!text.includes("sk-abcdefghijklmnopqrstuv"), "OpenAI-style key is gone");
    assert.ok(!text.includes("supersecretvalue123"), "credential from the title is gone");
    assert.ok(!hasSecret(replay.title), "the title itself scans clean");
    assert.deepEqual(scanReplayForSecrets(replay), [], "the finished bundle has zero findings");
    assert.ok(replay.redactions > 0, "the export reports how much it removed");
  });

  it("drops fields that are not on the publishable allow-list", () => {
    const nodes = [
      node("n1", "search", { tool: "web_fetch", url: "https://example.com", args: { headers: { Authorization: "Bearer x" } } }, 1),
    ];
    const replay = buildRunReplay({ runId: RUN, title: "t", nodes });
    const data = replay.nodes[0]!.data as Record<string, unknown>;

    // `args` is the usual hiding place for a credential, so it is not published.
    assert.equal(data.args, undefined);
    assert.equal(data.tool, "web_fetch");
    assert.equal(data.url, "https://example.com");
  });

  it("omits edges to nodes outside the export instead of dangling them", () => {
    const nodes = [node("a", "question", undefined, 1), node("b", "search", undefined, 2)];
    nodes[1]!.parent_ids = ["a", "ghost"];

    const replay = buildRunReplay({ runId: RUN, title: "t", nodes });
    assert.deepEqual(replay.edges, [{ from: "a", to: "b" }]);
  });

  it("caps a runaway export and reports an in-progress run", () => {
    const many = Array.from({ length: MAX_REPLAY_NODES + 50 }, (_, i) =>
      node(`n${i}`, "note", { summary: `step ${i}` }, i),
    );
    const replay = buildRunReplay({ runId: RUN, title: "t", nodes: many, partial: true });
    assert.equal(replay.stats.totalNodes, MAX_REPLAY_NODES, "the export is bounded");
    assert.equal(replay.partial, true);
  });
});

describe("run replay: the standalone viewer", () => {
  beforeEach(() => freshDataDir("loam-replay-html-"));
  afterEach(() => restoreDataDir());

  it("is a single offline page with a scrubber and no remote reference", () => {
    const nodes = recordedRun(RUN);
    const html = renderReplayHtml({ replay: buildRunReplay({ runId: RUN, title: "Publish", nodes }) });

    assert.match(html, /<!doctype html>/i);
    assert.match(html, /<input[^>]*type="range"[^>]*id="scrub"/, "a scrubber is present");
    assert.match(html, /id="timeline"/);
    assert.match(html, /View only/, "the page says it is view-only");
    // Self-contained: nothing is fetched from anywhere.
    assert.ok(!/src\s*=\s*["']https?:/i.test(html), "no remote script");
    assert.ok(!/href\s*=\s*["']https?:/i.test(html), "no remote stylesheet or font");
    // The bundle is inlined, so the page works from file://.
    assert.ok(html.includes(JSON.stringify("Publish")) || html.includes("Publish"), "the bundle is embedded");
    // Content security policy closes the last gap: no network at all.
    assert.match(html, /content-security-policy/i);
    assert.match(html, /default-src 'none'/);
  });

  it("escapes run content so a node label cannot break out of the page", () => {
    const nodes = [node("x", "search", { query: "</script><script>alert(1)</script>" }, 1)];
    const html = renderReplayHtml({ replay: buildRunReplay({ runId: RUN, title: "t", nodes }) });

    // A raw `</script>` inside the inlined bundle would end the element early.
    const scripts = html.split("<script>").length - 1;
    const closed = html.split("</script>").length - 1;
    assert.equal(closed, scripts, "every script element is closed exactly once");
    assert.ok(!html.includes("</script><script>alert(1)"), "the payload cannot inject a script");
  });
});

describe("run replay: the HTTP surface", () => {
  beforeEach(() => freshDataDir("loam-replay-http-"));
  afterEach(() => restoreDataDir());

  it("serves the JSON bundle and the standalone HTML page", async () => {
    recordedRun(RUN);
    makeTask("done");

    const jsonRes = new FakeResponse();
    assert.equal(await handleGraphRoutes(fakeRequest("GET", `/api/graph/${RUN}/replay`), jsonRes as unknown as ServerResponse, `/api/graph/${RUN}/replay`), true);
    assert.equal(jsonRes.status, 200);
    assert.equal(jsonRes.headers["content-type"], "application/json; charset=utf-8");
    assert.match(String(jsonRes.headers["content-disposition"]), /loam-replay-.*\.json/);
    const bundle = jsonRes.json();
    assert.equal(bundle.runId, RUN);
    assert.ok(Array.isArray(bundle.nodes));

    const htmlRes = new FakeResponse();
    await handleGraphRoutes(fakeRequest("GET", `/api/graph/${RUN}/replay/html`), htmlRes as unknown as ServerResponse, `/api/graph/${RUN}/replay/html`);
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers["content-type"], "text/html; charset=utf-8");
    assert.match(String(htmlRes.headers["content-disposition"]), /loam-replay-.*\.html/);
    assert.match(htmlRes.body().toString("utf8"), /<!doctype html>/i);
    assert.equal(htmlRes.headers["x-content-type-options"], "nosniff");
  });

  it("marks an unfinished run as partial and 404s an unknown run", async () => {
    recordedRun(RUN);
    makeTask("running");

    const res = new FakeResponse();
    await handleGraphRoutes(fakeRequest("GET", `/api/graph/${RUN}/replay`), res as unknown as ServerResponse, `/api/graph/${RUN}/replay`);
    assert.equal(res.json().partial, true);

    const missing = new FakeResponse();
    await handleGraphRoutes(fakeRequest("GET", "/api/graph/nope/replay"), missing as unknown as ServerResponse, "/api/graph/nope/replay");
    assert.equal(missing.status, 404);

    const method = new FakeResponse();
    await handleGraphRoutes(fakeRequest("POST", `/api/graph/${RUN}/replay`), method as unknown as ServerResponse, `/api/graph/${RUN}/replay`);
    assert.equal(method.status, 405);
  });

  it("publishes the replay through the public, token-gated share feed", () => {
    recordedRun(RUN);
    makeTask("done");

    const shared = sanitizeTranscript(getTask(RUN)!);
    assert.ok(shared.replay, "a share of a graphed run carries the replay");
    assert.equal(shared.replay!.runId, RUN);
    // The share feed is anonymous, so it must be clean of credentials by contract.
    assert.deepEqual(scanReplayForSecrets(shared.replay), []);
    // The transcript keeps its pre-existing shape alongside the new field.
    assert.ok(Array.isArray(shared.messages));
    assert.ok(Array.isArray(shared.artifacts));
  });

  it("omits the replay when the run has no graph nodes", () => {
    makeTask("done");
    const shared = sanitizeTranscript(getTask(RUN)!);
    assert.equal(shared.replay, undefined);
  });
});
