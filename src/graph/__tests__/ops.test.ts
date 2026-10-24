/**
 * Neo N11 acceptance tests: canvas editing semantics.
 *
 * The spec states the contract as five behaviours, so the tests are organised
 * around exactly those, plus the property that makes the feature usable in a live
 * run:
 *
 *   1. **Edit a node's output** -> a new version, the old text kept in history,
 *      and everything downstream marked stale.
 *   2. **Cut / re-connect an edge** -> the next step's context changes, because a
 *      node's context is its parents.
 *   3. **Duplicate a node** -> a branch, not a second copy of the same step.
 *   4. **Multi-select group** -> a merged context carrying every member.
 *   5. **Follow-up vs quote** -> the same node handed to the model two ways.
 *   6. **Every operation tells the agent.** An edit is a fact the next step must
 *      see, so each op files a directive; consuming it once is what keeps a
 *      correction from pinning itself in the prompt forever.
 *
 * The graph and the directive log are the real ones (SQLite behind a throwaway
 * data directory), so the tests exercise the same code path the server uses. No
 * network and no model calls.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { RunGraph } from "../runGraph.js";
import {
  descendantsOf,
  downstreamOf,
  duplicateNode,
  editNode,
  groupNodes,
  nodeText,
  parseCanvasOpRequest,
  readEditHistory,
  reconnectNode,
  setContextMode,
} from "../ops.js";
import { clearDirectives, consumeDirectives, readDirectives } from "../directives.js";
import { closeDb } from "../../server/sqliteStore.js";

const RUN = "task_canvas_ops_1";

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

/**
 * A run shaped like a real one: a question, a plan step, two tool nodes that
 * step produced, and the completion node. The projection is *flat* (tool nodes
 * hang off the step and `complete` is their sibling, not their child), which is
 * exactly why the edit test asserts downstream work is still found.
 */
function chainGraph(): { graph: RunGraph; stepId: string; searchId: string; pageId: string; doneId: string } {
  const graph = new RunGraph();
  graph.beginRun(RUN, "Research the market and write a summary");
  graph.applyEvent(RUN, {
    type: "plan",
    goal: "Research the market and write a summary",
    trivial: false,
    steps: [{ id: "s1", title: "Collect sources", instruction: "Search", successCriteria: "Sources found" }],
    source: "model",
  });
  graph.applyEvent(RUN, { type: "plan_step", id: "s1", index: 0, total: 1, title: "Collect sources", phase: "start" });
  graph.applyEvent(RUN, { type: "tool_call", name: "web_search", args: { query: "market size" } });
  graph.applyEvent(RUN, { type: "tool_result", name: "web_search", ok: true, summary: "Found 3 sources on market size" });
  graph.applyEvent(RUN, { type: "tool_call", name: "web_fetch", args: { url: "https://example.com/report" } });
  graph.applyEvent(RUN, { type: "tool_result", name: "web_fetch", ok: true, summary: "The report says the market is $4B" });
  graph.applyEvent(RUN, { type: "plan_step", id: "s1", index: 0, total: 1, title: "Collect sources", phase: "done" });
  graph.applyEvent(RUN, { type: "done", text: "The market is $4B.", steps: 1, model: "test-model" });

  const nodes = graph.getRunNodes(RUN);
  const step = nodes.find((node) => node.type === "recipe_step")!;
  const search = nodes.find((node) => node.type === "search")!;
  const page = nodes.find((node) => node.type === "webpage")!;
  const done = nodes.find((node) => node.type === "complete")!;
  return { graph, stepId: step.id, searchId: search.id, pageId: page.id, doneId: done.id };
}

describe("N11 canvas ops: edit a node's output", () => {
  beforeEach(() => freshDataDir("loam-canvas-ops-"));
  afterEach(() => restoreDataDir());

  it("appends a version, keeps the old text, and marks downstream stale", () => {
    const { graph, searchId, pageId } = chainGraph();
    const before = graph.getNode(searchId, RUN)!;
    const oldText = nodeText(before);

    const result = editNode({ graph, runId: RUN, nodeId: searchId, text: "Market size is $4.2B (2024), growing 11% YoY." });

    assert.equal(result.op, "edit");
    assert.equal(result.nodeId, searchId);
    const after = graph.getNode(searchId, RUN)!;
    assert.equal(after.version, before.version + 1, "an edit is a new version");
    assert.match(nodeText(after), /4\.2B/, "the corrected text is the node's output");
    assert.doesNotMatch(nodeText(after), /Found 3 sources/, "the old output is no longer what the node says");

    const history = readEditHistory(after);
    assert.equal(history.length, 1, "the previous text is kept as history");
    assert.equal(history[0]!.previous, oldText);
    assert.match(history[0]!.text, /4\.2B/);

    // The node that consumed the search is downstream, so it is stale.
    assert.ok(result.stale.includes(pageId), "a downstream node is marked stale");
    const downstream = graph.getNode(pageId, RUN)!;
    assert.equal((downstream.data as { stale?: boolean }).stale, true);
    assert.equal((downstream.data as { staleAfter?: string }).staleAfter, searchId);
    assert.equal(downstream.status, "finished", "stale is a payload flag, not a lifecycle change");
  });

  it("files exactly one directive, and consuming it clears it", () => {
    const { graph, searchId } = chainGraph();
    const result = editNode({ graph, runId: RUN, nodeId: searchId, text: "Corrected output" });
    assert.ok(result.directive, "an edit files a directive for the next step");

    const pending = readDirectives(RUN);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.reason, "edited");
    assert.equal(pending[0]!.mode, "follow-up");
    assert.equal(pending[0]!.nodeId, searchId);
    assert.match(pending[0]!.text, /Corrected output/);
    assert.equal(pending[0]!.version, graph.getNode(searchId, RUN)!.version);

    const taken = consumeDirectives(RUN);
    assert.equal(taken.length, 1, "the loop takes the edit");
    assert.deepEqual(readDirectives(RUN), [], "and it is not handed over twice");
    assert.deepEqual(consumeDirectives(RUN), [], "a second pull is empty");
  });

  it("refuses a node that is not in this run", () => {
    const { graph } = chainGraph();
    assert.throws(() => editNode({ graph, runId: RUN, nodeId: "does-not-exist", text: "x" }), /not found/);
    assert.deepEqual(readDirectives(RUN), [], "a refused edit files nothing");
  });

  it("finds every structural descendant, however deep the chain runs", () => {
    const { graph, stepId, searchId, doneId } = chainGraph();
    // The recipe step is the structural parent of both tool nodes, so editing it
    // should reach the whole branch.
    const ids = descendantsOf(graph, RUN, stepId).map((node) => node.id);
    assert.ok(ids.includes(searchId));
    assert.ok(ids.includes(doneId), "the completion node is reached through the branch");

    // A leaf has no structural children at all, even though later work follows it.
    assert.deepEqual(descendantsOf(graph, RUN, searchId), [], "a tool node has no structural children");
  });

  it("finds downstream work in execution order when the branch is flat", () => {
    const { graph, searchId, pageId, doneId } = chainGraph();
    const ids = downstreamOf(graph, RUN, searchId).map((node) => node.id);
    assert.ok(ids.includes(pageId), "a later tool call in the same branch is downstream");
    assert.ok(ids.includes(doneId), "the completion node came after the edit");
    assert.ok(ids.indexOf(pageId) < ids.indexOf(doneId), "downstream is returned in execution order");
  });
});

describe("N11 canvas ops: cut and re-connect an edge", () => {
  beforeEach(() => freshDataDir("loam-canvas-ops-"));
  afterEach(() => restoreDataDir());

  it("cutting a parent removes it from the node's context and files a directive", () => {
    const { graph, pageId, searchId } = chainGraph();
    const result = reconnectNode({ graph, runId: RUN, nodeId: pageId, parentIds: [] });

    assert.equal(result.op, "cut");
    const after = graph.getNode(pageId, RUN)!;
    assert.deepEqual(after.parent_ids, [], "the edge is gone, so the parent no longer feeds this node");

    const [directive] = readDirectives(RUN);
    assert.ok(directive);
    assert.equal(directive.reason, "cut");
    assert.match(directive.detail ?? "", /Cut from/);
    assert.doesNotMatch(directive.detail ?? "", /web_search/, "the detail names the node's title, not its id");
    assert.ok(!after.parent_ids.includes(searchId));
  });

  it("re-connecting to a new parent changes the context and names it", () => {
    const { graph, pageId, doneId } = chainGraph();
    const result = reconnectNode({ graph, runId: RUN, nodeId: pageId, parentIds: [doneId] });

    // The move drops the old parent too, so it is both a cut and a connect; the
    // operation is reported as the connect, and the dropped parent is still named.
    assert.equal(result.op, "reconnect");
    assert.deepEqual(graph.getNode(pageId, RUN)!.parent_ids, [doneId]);
    const [directive] = readDirectives(RUN);
    assert.equal(directive!.reason, "reconnect");
    assert.match(directive!.detail ?? "", /Connected to/);
    assert.match(directive!.detail ?? "", /Cut from/, "the dropped parent is named too");
  });

  it("refuses a parent id that is not in this run", () => {
    const { graph, pageId } = chainGraph();
    assert.throws(() => reconnectNode({ graph, runId: RUN, nodeId: pageId, parentIds: ["ghost"] }), /not found/);
    assert.equal(graph.getNode(pageId, RUN)!.parent_ids.length, 1, "the edge is untouched");
  });

  it("never lets a node become its own parent", () => {
    const { graph, pageId, searchId } = chainGraph();
    reconnectNode({ graph, runId: RUN, nodeId: pageId, parentIds: [pageId, searchId] });
    assert.deepEqual(graph.getNode(pageId, RUN)!.parent_ids, [searchId]);
  });
});

describe("N11 canvas ops: duplicate is a branch", () => {
  beforeEach(() => freshDataDir("loam-canvas-ops-"));
  afterEach(() => restoreDataDir());

  it("creates a branch node carrying the source payload, leaving the original alone", () => {
    const { graph, searchId } = chainGraph();
    const source = graph.getNode(searchId, RUN)!;

    const result = duplicateNode({ graph, runId: RUN, nodeId: searchId });
    assert.equal(result.op, "duplicate");
    assert.notEqual(result.nodeId, searchId, "a duplicate is its own node");

    const branch = graph.getNode(result.nodeId, RUN)!;
    assert.equal(branch.type, "branch");
    assert.equal((branch.data as { duplicatedFrom?: string }).duplicatedFrom, searchId);
    assert.equal((branch.data as { sourceVersion?: number }).sourceVersion, source.version);
    assert.match(nodeText(branch), /Found 3 sources/, "the copy starts from the source's content");

    assert.equal(graph.getNode(searchId, RUN)!.version, source.version, "the original keeps its version");
    assert.deepEqual(readDirectives(RUN)[0]!.reason, "duplicate");
  });

  it("is deterministic: duplicating twice yields the same branch id", () => {
    const { graph, searchId } = chainGraph();
    const first = duplicateNode({ graph, runId: RUN, nodeId: searchId });
    const second = duplicateNode({ graph, runId: RUN, nodeId: searchId });
    assert.equal(first.nodeId, second.nodeId, "a repeated duplicate is the same branch, not a new node");
    assert.equal(graph.getRunNodes(RUN).filter((node) => node.type === "branch").length, 1);
  });
});

describe("N11 canvas ops: group is a merged context", () => {
  beforeEach(() => freshDataDir("loam-canvas-ops-"));
  afterEach(() => restoreDataDir());

  it("merges every selected node into one node that lists them all as parents", () => {
    const { graph, searchId, pageId } = chainGraph();
    const result = groupNodes({ graph, runId: RUN, nodeIds: [searchId, pageId], title: "Market evidence" });

    assert.equal(result.op, "group");
    const merged = graph.getNode(result.nodeId, RUN)!;
    assert.equal(merged.type, "merge");
    assert.deepEqual(merged.parent_ids, [searchId, pageId], "the group is a fan-in over every member");
    assert.equal((merged.data as { groupSize?: number }).groupSize, 2);

    const [directive] = readDirectives(RUN);
    assert.equal(directive!.reason, "group");
    assert.match(directive!.text, /Found 3 sources/, "the merged context carries the first member");
    assert.match(directive!.text, /market is \$4B/, "and the second");
    assert.match(directive!.detail ?? "", /Grouped 2 nodes/);
  });

  it("refuses a group of fewer than two nodes", () => {
    const { graph, searchId } = chainGraph();
    assert.throws(() => groupNodes({ graph, runId: RUN, nodeIds: [searchId] }), /at least two/, "a group is always at least two nodes");
  });
});

describe("N11 canvas ops: follow-up vs quote", () => {
  beforeEach(() => freshDataDir("loam-canvas-ops-"));
  afterEach(() => restoreDataDir());

  it("quote asks for the content verbatim without changing the node", () => {
    const { graph, pageId } = chainGraph();
    const before = graph.getNode(pageId, RUN)!;
    const result = setContextMode({ graph, runId: RUN, nodeId: pageId, mode: "quote" });

    assert.equal(result.op, "quote");
    assert.equal(graph.getNode(pageId, RUN)!.version, before.version, "the mode does not rewrite the node");
    const [directive] = readDirectives(RUN);
    assert.equal(directive!.mode, "quote");
    assert.match(directive!.detail ?? "", /exactly/);
  });

  it("follow-up asks to continue from the node", () => {
    const { graph, pageId } = chainGraph();
    const result = setContextMode({ graph, runId: RUN, nodeId: pageId, mode: "follow-up", note: "Use this figure." });
    assert.equal(result.op, "follow-up");
    const [directive] = readDirectives(RUN);
    assert.equal(directive!.mode, "follow-up");
    assert.match(directive!.text, /Use this figure\./, "the note the user typed is carried");
    assert.match(directive!.text, /market is \$4B/);
  });
});

describe("N11 canvas ops: request parsing", () => {
  it("accepts each operation the canvas can send", () => {
    assert.deepEqual(parseCanvasOpRequest({ op: "edit", nodeId: "n1", text: "hello" }), { op: "edit", nodeId: "n1", text: "hello" });
    assert.deepEqual(parseCanvasOpRequest({ op: "cut", nodeId: "n1", parentIds: ["p1"] }), { op: "cut", nodeId: "n1", parentIds: ["p1"] });
    assert.deepEqual(parseCanvasOpRequest({ op: "duplicate", nodeId: "n1" }), { op: "duplicate", nodeId: "n1" });
    assert.deepEqual(parseCanvasOpRequest({ op: "group", nodeIds: ["a", "b"] }), { op: "group", nodeIds: ["a", "b"] });
    assert.deepEqual(parseCanvasOpRequest({ op: "quote", nodeId: "n1" }), { op: "quote", nodeId: "n1" });
    assert.deepEqual(parseCanvasOpRequest({ op: "edit", nodeId: "n1", text: "x", mode: "quote" }), {
      op: "edit",
      nodeId: "n1",
      text: "x",
      mode: "quote",
    });
  });

  it("rejects a malformed payload rather than half-applying it", () => {
    assert.equal(parseCanvasOpRequest(null), undefined);
    assert.equal(parseCanvasOpRequest({}), undefined);
    assert.equal(parseCanvasOpRequest({ op: "edit", nodeId: "n1" }), undefined, "an edit needs text");
    assert.equal(parseCanvasOpRequest({ op: "edit", nodeId: "n1", text: "   " }), undefined, "blank text is not an edit");
    assert.equal(parseCanvasOpRequest({ op: "group", nodeIds: ["only-one"] }), undefined, "a group needs two nodes");
    assert.equal(parseCanvasOpRequest({ op: "cut", nodeId: "n1", parentIds: "p1" }), undefined);
    assert.equal(parseCanvasOpRequest({ op: "nope", nodeId: "n1" }), undefined);
    assert.equal(parseCanvasOpRequest({ op: "edit", nodeId: "n1", text: "x".repeat(70_000) }), undefined, "text is capped");
  });

  it("clears a run's directives when the run is dropped", () => {
    const { graph, searchId } = chainGraph();
    editNode({ graph, runId: RUN, nodeId: searchId, text: "x" });
    assert.equal(readDirectives(RUN).length, 1);
    clearDirectives(RUN);
    assert.deepEqual(readDirectives(RUN), []);
  });
});
