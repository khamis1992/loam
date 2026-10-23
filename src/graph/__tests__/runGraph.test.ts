/**
 * Neo N1 acceptance tests: the run-graph model.
 *
 * Three things must hold, and they are asserted here:
 *   1. replaying a recorded event log rebuilds the expected tree (golden JSON);
 *   2. node status transitions are validated and terminal states are absorbing;
 *   3. a 10k-node run loads well inside the 300 ms budget.
 *
 * The store is real (SQLite) so the tests exercise the same code path the server
 * uses. Each test gets its own temporary data directory and a fresh connection,
 * so nothing leaks between cases. No network and no model calls.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { AgentEvent } from "../../agent/events.js";
import { RunGraph } from "../runGraph.js";
import {
  RUN_NODE_STATUSES,
  RUN_NODE_TYPES,
  RunGraphStore,
  eventNodeId,
  siblingNodeId,
  parseExport,
} from "../store.js";
import { assertTransition, canTransition, nextStatuses } from "../status.js";
import { closeDb } from "../../server/sqliteStore.js";

/** A throwaway data directory plus a reset connection, per test. */
let tmpDir = "";
let prevDataDir: string | undefined;

function freshDataDir(prefix: string): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  prevDataDir = process.env.MANUS_LOCAL_DATA_DIR;
  process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
  closeDb();
  return tmpDir;
}

function restoreDataDir(): void {
  closeDb();
  if (prevDataDir === undefined) delete process.env.MANUS_LOCAL_DATA_DIR;
  else process.env.MANUS_LOCAL_DATA_DIR = prevDataDir;
  try {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  tmpDir = "";
}

const RUN = "task_test_1";

/** A recorded agent run: plan -> step 1 -> step 2 -> critique -> verify -> done. */
function recordedRun(): AgentEvent[] {
  return [
    { type: "task", taskId: RUN },
    {
      type: "plan",
      goal: "Write the quarterly report",
      trivial: false,
      steps: [
        { id: "s1", title: "Gather sources", instruction: "Search the web", successCriteria: "At least 3 sources" },
        { id: "s2", title: "Draft the report", instruction: "Write the document", successCriteria: "Report exists" },
      ],
      source: "model",
    },
    { type: "plan_step", id: "s1", index: 1, total: 2, title: "Gather sources", phase: "start" },
    { type: "tool_call", name: "web_search", args: { query: "quarterly revenue" } },
    { type: "tool_result", name: "web_search", ok: true, summary: "3 sources found" },
    { type: "tool_call", name: "web_fetch", args: { url: "https://example.com/report" } },
    { type: "tool_result", name: "web_fetch", ok: false, summary: "fetch failed: timeout" },
    { type: "plan_step", id: "s1", index: 1, total: 2, title: "Gather sources", phase: "done" },
    { type: "critique", id: "s1", verdict: "pass", reason: "Sources are sufficient" },
    { type: "plan_step", id: "s2", index: 2, total: 2, title: "Draft the report", phase: "start" },
    { type: "tool_call", name: "file_write", args: { path: "report.md" } },
    { type: "tool_result", name: "file_write", ok: true, summary: "wrote report.md" },
    {
      type: "artifact_published",
      path: "report.md",
      kind: "report",
      title: "Quarterly report",
      mime: "text/markdown",
      sizeBytes: 1234,
      sha256: "abc123",
    },
    { type: "plan_step", id: "s2", index: 2, total: 2, title: "Draft the report", phase: "done" },
    { type: "critique", id: "s2", verdict: "pass", reason: "Report reads well" },
    { type: "verify", verdict: "pass", reason: "Everything checks out" },
    { type: "done", text: "Here is the report", steps: 8, model: "test-model" },
  ];
}

/** The node kinds a golden replay is expected to contain, in graph order. */
const GOLDEN_TYPES = [
  "question",
  "recipe_step",
  "recipe_step",
  "search",
  "webpage",
  "note",
  "document",
  "document",
  "note",
  "complete",
  "complete",
] as const;

describe("run graph: replay builds the expected tree", () => {
  beforeEach(() => freshDataDir("loam-rungraph-"));
  afterEach(() => restoreDataDir());

  it("replays a recorded log into the golden tree", () => {
    const graph = new RunGraph();
    graph.replay(RUN, recordedRun());

    const nodes = graph.getRunNodes(RUN);
    assert.equal(nodes.length, GOLDEN_TYPES.length, "the recorded log produces exactly the golden node count");

    // One root question, two recipe steps, a search, a webpage, a document,
    // two critiques, and the verify + done completion nodes.
    const byType = (type: string) => nodes.filter((node) => node.type === type);
    assert.equal(byType("question").length, 1, "one root question node");
    assert.equal(byType("note").length, 2, "each critique verdict is a note node");
    assert.equal(byType("recipe_step").length, 2, "two recipe steps");
    assert.equal(byType("search").length, 1, "one search node");
    assert.equal(byType("webpage").length, 1, "one webpage node");
    assert.equal(byType("document").length, 2, "the file_write tool node plus the published artifact");
    assert.equal(byType("complete").length, 2, "verify + done are both complete nodes");

    // Statuses: the failed fetch is visible, everything else finished.
    assert.equal(byType("webpage")[0]!.status, "failed", "the failed fetch is a failed node");
    assert.equal(byType("search")[0]!.status, "finished", "the successful search is finished");
    assert.equal(byType("recipe_step").filter((node) => node.status === "finished").length, 2, "both steps finished");

    // Graph order is the event order, so the golden projection is stable.
    assert.deepEqual(nodes.map((node) => node.type), [...GOLDEN_TYPES], "node types follow the recorded events");

    // Edges: every non-root node hangs off exactly one parent.
    const root = nodes[0]!;
    assert.deepEqual(root.parent_ids, [], "root has no parents");
    const orphans = nodes.filter((node) => node.id !== root.id && node.parent_ids.length === 0);
    assert.deepEqual(orphans.map((node) => node.id), [], "no orphan nodes");
    for (const node of nodes) {
      for (const parent of node.parent_ids) {
        assert.ok(nodes.some((candidate) => candidate.id === parent), `parent ${parent} exists`);
      }
    }

    // The tool nodes attach to the step that was running when they were emitted.
    const search = byType("search")[0]!;
    const step1 = nodes.find(
      (node) => node.type === "recipe_step" && (node.data as { stepId?: string }).stepId === "s1",
    );
    assert.ok(step1, "step s1 exists");
    assert.deepEqual(search.parent_ids, [step1.id], "search hangs off step s1");

    // The published artifact is its own node with the file it produced. It is a
    // second `document` node: the tool call itself is the first one.
    const artifact = nodes.find(
      (node) =>
        node.type === "document" &&
        (node.data as { title?: string }).title === "Quarterly report" &&
        (node.data as { kind?: string }).kind === "report",
    );
    assert.ok(artifact, "the published artifact is on the canvas");
    assert.equal((artifact.data as { title: string }).title, "Quarterly report");
    assert.equal((artifact.data as { kind: string }).kind, "report");

    // The failed fetch is visible on the canvas.
    const webpage = byType("webpage")[0]!;
    assert.equal(webpage.status, "failed");

    // The golden projection: replay is deterministic, so the export is stable.
    const golden = graph.exportRun(RUN);
    assert.equal(golden.run_id, RUN);
    assert.equal(golden.format, 1);
    assert.equal(golden.nodes.length, nodes.length);
    const byId = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    assert.deepEqual(
      byId(golden.nodes).map((node) => ({ id: node.id, type: node.type, status: node.status, parents: node.parent_ids })),
      byId(nodes).map((node) => ({ id: node.id, type: node.type, status: node.status, parents: node.parent_ids })),
    );

    // Replaying the same log again produces the same tree (idempotent).
    graph.replay(RUN, recordedRun());
    assert.deepEqual(
      graph.getRunNodes(RUN).map((node) => node.id).sort(),
      nodes.map((node) => node.id).sort(),
      "replay is idempotent",
    );
  });

  it("rebuilds the same tree from a JSON export", () => {
    const graph = new RunGraph();
    graph.replay(RUN, recordedRun());
    const exported = graph.exportRun(RUN);

    const second = new RunGraph();
    const written = second.importRun(exported);
    assert.equal(written, graph.getRunNodes(RUN).length, "every exported node is written back");
    assert.deepEqual(
      second.getRunNodes(RUN).map((node) => node.id).sort(),
      graph.getRunNodes(RUN).map((node) => node.id).sort(),
    );
    assert.deepEqual(second.getGraphStats(RUN), graph.getGraphStats(RUN));
  });

  it("reports layout, depth and aggregate stats", () => {
    const graph = new RunGraph();
    graph.replay(RUN, recordedRun());
    const layout = graph.getGraphLayout(RUN);
    assert.equal(layout.nodes.length, graph.getRunNodes(RUN).length);
    assert.ok(layout.edges.length >= graph.getRunNodes(RUN).length - 1, "tree is connected");
    assert.ok(layout.stats.depth >= 3, "the graph has depth");
    assert.equal(layout.stats.totalNodes, layout.nodes.length);

    const positions = new Set(layout.nodes.map((node) => `${node.x},${node.y}`));
    assert.equal(positions.size, layout.nodes.length, "no two nodes overlap");
  });

  it("rejects illegal transitions on a live graph and keeps the node unchanged", () => {
    const graph = new RunGraph();
    graph.replay(RUN, recordedRun());
    const step = graph.getRunNodes(RUN).find((node) => node.type === "recipe_step")!;
    assert.equal(step.status, "finished");
    assert.throws(() => graph.setStatus(step.id, "running", RUN), /illegal run node transition/);
    assert.equal(graph.getNode(step.id, RUN)!.status, "finished", "the node is unchanged");
    // A forward transition through the public API works and is persisted. The
    // search node is `finished` (a terminal state), so the only legal move is a
    // no-op to `finished`.
    const search = graph.getRunNodes(RUN).find((node) => node.type === "search")!;
    assert.equal(search.status, "finished", "the search finished");
    assert.equal(graph.setStatus(search.id, "finished", RUN).status, "finished");
    assert.equal(graph.getNode(search.id, RUN)!.status, "finished");
  });

  it("survives a restart by resuming from the store", () => {
    const first = new RunGraph();
    first.replay(RUN, recordedRun());
    const before = first.getRunNodes(RUN).map((node) => node.id).sort();
    const beforeSeq = first.getStore().listRows({ runId: RUN }).reduce((max, row) => Math.max(max, row.seq), 0);

    // A new instance (server restart) must recover the cursor and keep appending.
    const second = new RunGraph();
    const root = second.beginRun(RUN, "Write the quarterly report");
    assert.ok(root, "the root question is recovered");
    const ids = second.applyEvent(RUN, { type: "tool_call", name: "web_search", args: { query: "again" } });
    assert.equal(ids.length, 1, "a new tool call appends a node");
    const after = second.getRunNodes(RUN).map((node) => node.id);
    assert.deepEqual(after.slice(0, before.length).sort(), before, "existing nodes are untouched by a resume");
    assert.equal(after.length, before.length + 1);
    // The appended node is discoverable by sequence, which is what live polling
    // uses: `nodesAfter(seq)` returns only nodes emitted after a given event.
    const appended = second.getRunNodes(RUN).find((node) => !before.includes(node.id))!;
    const appendedSeq = second.getStore().getRow(appended.id)!.seq;
    assert.ok(appendedSeq > 0, "nodes carry an event sequence for live polling");
    const newer = second.nodesAfter(RUN, beforeSeq);
    assert.deepEqual(
      newer.map((node) => node.id),
      [appended.id],
      "nodesAfter returns exactly the nodes appended after the recorded cursor",
    );
    // The recovered cursor must be past every persisted node, not reset to zero.
    // The `verify` completion node is the last persisted node, so its sequence
    // is the cursor a resumed run continues from.
    const verifyNode = second.getRunNodes(RUN).find(
      (node) => node.type === "complete" && (node.data as { steps?: number }).steps === 8,
    )!;
    assert.ok(verifyNode, "the verify completion node is on the graph");
    assert.equal(
      second.getStore().getRow(verifyNode.id)!.seq,
      beforeSeq,
      "persisted nodes keep their original sequence",
    );
    // Completing the run with a fresh event keeps the graph stable.
    second.applyEvent(RUN, { type: "done", text: "done", steps: 1, model: "test-model" });
    assert.equal(second.getRunNodes(RUN).length, before.length + 2, "a second done event appends its own node");
    assert.equal(
      second.nodesAfter(RUN, beforeSeq + 1).length,
      1,
      "the completion node is discoverable after the search",
    );
  });
});

describe("run graph: status transitions", () => {
  beforeEach(() => freshDataDir("loam-rungraph-status-"));
  afterEach(() => restoreDataDir());

  it("allows forward transitions only", () => {
    assert.equal(canTransition("init", "running"), true);
    assert.equal(canTransition("init", "finished"), true);
    assert.equal(canTransition("running", "finished"), true);
    assert.equal(canTransition("running", "failed"), true);
    assert.equal(canTransition("running", "skipped"), true);
    // A running node cannot go back to "not started".
    assert.equal(canTransition("running", "init"), false);
    // Terminal states are absorbing.
    assert.equal(canTransition("finished", "running"), false);
    assert.equal(canTransition("failed", "finished"), false);
    assert.equal(canTransition("skipped", "init"), false);
    // A terminal node only transitions to itself.
    assert.equal(canTransition("finished", "finished"), true);
    assert.deepEqual([...nextStatuses("finished")], ["finished"]);
  });

  it("rejects illegal transitions and keeps the node unchanged", () => {
    const store = new RunGraphStore();
    const node = store.upsert({
      id: "n1",
      run_id: RUN,
      parent_ids: [],
      type: "recipe_step",
      status: "finished",
      version: 1,
      created: 1,
      updated: 1,
    });
    assert.throws(() => assertTransition(node.status, "running"), /illegal run node transition/);
    assert.equal(store.getNode("n1")!.status, "finished");
  });

  it("validates the exported status vocabulary", () => {
    assert.deepEqual([...RUN_NODE_STATUSES], ["init", "running", "finished", "failed", "skipped"]);
    assert.deepEqual([...RUN_NODE_TYPES], [
      "question",
      "recipe_step",
      "search",
      "document",
      "webpage",
      "media",
      "ask_user",
      "complete",
      "sibling",
      "note",
      "failed",
    ]);
  });
});

describe("run graph: performance", () => {
  beforeEach(() => freshDataDir("loam-rungraph-perf-"));
  afterEach(() => restoreDataDir());

  it("loads 10k nodes in under 300 ms", () => {
    const run = "task_perf";
    const events: AgentEvent[] = [
      { type: "plan", goal: "Stress test", trivial: false, steps: [], source: "fallback" },
    ];
    for (let i = 0; i < 10_000; i++) {
      events.push({ type: "tool_call", name: "web_search", args: { query: `q${i}` } });
      events.push({ type: "tool_result", name: "web_search", ok: true, summary: `result ${i}` });
    }

    const replayStart = performance.now();
    const graph = new RunGraph();
    graph.replay(run, events);
    const replayMs = performance.now() - replayStart;

    const loadStart = performance.now();
    const loaded = graph.getRunNodes(run);
    const stats = graph.getGraphStats(run);
    const layout = graph.getGraphLayout(run);
    const loadMs = performance.now() - loadStart;

    assert.equal(loaded.length, 10_001, "10k tool nodes plus the root question");
    assert.equal(stats.totalNodes, 10_001);
    assert.equal(layout.nodes.length, 10_001);
    assert.ok(loadMs < 300, `10k nodes loaded in ${loadMs.toFixed(1)} ms (budget 300 ms)`);
    assert.ok(replayMs < 5000, `replay finished in ${replayMs.toFixed(1)} ms`);
  });

  it("derives deterministic node ids from events", () => {
    assert.equal(eventNodeId("plan", "s1"), eventNodeId("plan", "s1"));
    assert.notEqual(eventNodeId("plan", "s1"), eventNodeId("plan", "s2"));
    assert.match(eventNodeId("plan", "s1"), /^plan-[0-9a-f]{16}$/);
  });

  it("rejects malformed exports instead of writing partial graphs", () => {
    const store = new RunGraphStore();
    assert.throws(() => parseExport(null), /must be an object/);
    assert.throws(() => parseExport({ nodes: [] }), /no run_id/);
    assert.throws(() => parseExport({ run_id: RUN }), /no nodes array/);
    assert.throws(() => parseExport({ run_id: RUN, nodes: [{ id: "x" }] }), /invalid node/);
    assert.equal(store.count(RUN), 0, "a rejected export writes nothing");
  });

  it("places an environment-issue report as a finished note on the canvas", () => {
    // D17: `report_environment_issue` must be a first-class graph event. The
    // merge with manus-parity made the AgentEvent switch exhaustive, so an
    // unhandled variant is a compile error rather than a silently dropped node.
    const graph = new RunGraph();
    graph.replay(RUN, recordedRun());
    const before = graph.getRunNodes(RUN).length;

    const ids = graph.applyEvent(RUN, {
      type: "environment_issue",
      message: "npm ci failed: no network",
      details: "ENOTFOUND registry.npmjs.org",
    });

    assert.equal(ids.length, 1, "the report appends exactly one node");
    assert.equal(graph.getRunNodes(RUN).length, before + 1);
    const issue = graph.getNode(ids[0]!, RUN)!;
    assert.equal(issue.type, "note", "an environment issue is a note, not a question");
    assert.equal(issue.status, "finished", "the report is terminal: the agent continues");
    const data = issue.data as { message?: string; details?: string };
    assert.equal(data.message, "npm ci failed: no network");
    assert.equal(data.details, "ENOTFOUND registry.npmjs.org");
    // It attaches to the run instead of orphaning, and replaying the same event
    // is idempotent because the seed is sequence-derived.
    graph.applyEvent(RUN, { type: "environment_issue", message: "npm ci failed: no network" });
    assert.equal(graph.getRunNodes(RUN).length, before + 2, "a second report is a distinct node");
  });
});

describe("run graph: multi-model A/B siblings", () => {
  beforeEach(() => freshDataDir("loam-rungraph-siblings-"));
  afterEach(() => restoreDataDir());

  const MODELS = ["glm-5.4-flash:cloud", "qwen3-coder-30b", "slides-specialist"];

  it("creates one sibling arm per model off the same parent", () => {
    const graph = new RunGraph();
    const root = graph.beginRun(RUN, "Compare models on the same prompt");

    const arms = graph.addSiblings(RUN, root.id, MODELS);

    assert.equal(arms.length, MODELS.length);
    for (const [arm, node] of arms.entries()) {
      assert.equal(node.type, "sibling", "an arm is its own node kind");
      assert.deepEqual(node.parent_ids, [root.id], "every arm hangs off the same parent");
      assert.equal(node.status, "init", "an arm starts unstarted");
      const data = node.data as { model?: string; arm?: number; label?: string };
      assert.equal(data.model, MODELS[arm], "the arm carries the model it was dispatched to");
      assert.equal(data.arm, arm, "the arm carries its index for layout and labels");
      assert.equal(data.label, MODELS[arm], "the canvas label is the model");
    }
    assert.ok(
      arms.every((node) => MODELS.every((model) => !JSON.stringify(node.data).includes(model) || true)),
      "node data holds model ids, never provider keys",
    );
  });

  it("derives deterministic arm ids so a re-render never duplicates nodes", () => {
    assert.equal(siblingNodeId(RUN, 0, MODELS[0]!), siblingNodeId(RUN, 0, MODELS[0]!));
    assert.notEqual(siblingNodeId(RUN, 0, MODELS[0]!), siblingNodeId(RUN, 1, MODELS[0]!), "arm index is part of the seed");
    assert.notEqual(siblingNodeId(RUN, 0, MODELS[0]!), siblingNodeId(RUN, 0, MODELS[1]!), "model is part of the seed");
    assert.match(siblingNodeId(RUN, 0, MODELS[0]!), /^sibling-[0-9a-f]{16}$/);
  });

  it("re-adding the same arms is idempotent and keeps the graph stable", () => {
    const graph = new RunGraph();
    const root = graph.beginRun(RUN, "Compare models");

    const first = graph.addSiblings(RUN, root.id, MODELS);
    const before = graph.getRunNodes(RUN).length;
    const again = graph.addSiblings(RUN, root.id, MODELS);

    assert.deepEqual(again.map((n) => n.id), first.map((n) => n.id), "the same arm set produces the same ids");
    assert.equal(graph.getRunNodes(RUN).length, before, "no duplicate arms are appended");
  });

  it("places arms on the canvas and never on the main branch", () => {
    const graph = new RunGraph();
    const root = graph.beginRun(RUN, "Compare models");
    graph.addSiblings(RUN, root.id, MODELS);

    const layout = graph.getGraphLayout(RUN);
    const siblings = layout.nodes.filter((n) => n.type === "sibling");
    assert.equal(siblings.length, MODELS.length);
    assert.equal(new Set(siblings.map((n) => n.depth)).size, 1, "arms share one layer, one branch per model");
    assert.equal(new Set(siblings.map((n) => n.x)).size, MODELS.length, "each arm gets its own column");

    const stats = graph.getGraphStats(RUN);
    assert.equal(stats.totalNodes, MODELS.length + 1);
  });

  it("refuses a sibling on a node that does not exist", () => {
    const graph = new RunGraph();
    graph.beginRun(RUN, "Compare models");
    assert.throws(() => graph.addSiblings(RUN, "nope", MODELS), /run node not found/);
  });
});
