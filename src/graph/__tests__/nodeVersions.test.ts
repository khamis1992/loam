/**
 * Neo N13: what gets captured as a node version.
 *
 * The version list only means something if it holds *documents*, so the tests pin
 * the capture rules: a document/webpage/`kb_seed` node with text is snapshotted, a
 * search or media node is not, and an unchanged snapshot is not duplicated. They
 * also pin the file capture that lets a ZIP carry the page's assets, including the
 * rule that keeps a node from making the server open a file outside its workspace.
 *
 * The run graph is built through the real adapter, so capture exercises the same
 * store the server reads.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { AgentEvent } from "../../agent/events.js";
import { applyRunEvent, beginRun, getRunNode, getRunNodes, resetRunGraph } from "../../agent/runGraphAdapter.js";
import { closeDb } from "../../server/sqliteStore.js";
import {
  canVersionNode,
  captureNodeFiles,
  captureNodeVersion,
  captureRunNodes,
  listFileVersions,
  listVersionsForNode,
  nodeCurrentText,
  nodeFiles,
  nodeTitle,
  resetNodeVersions,
} from "../nodeVersions.js";

const RUN = "task_n13_versions";

let tmpDir = "";
let prevDataDir: string | undefined;

function fresh(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-node-versions-"));
  prevDataDir = process.env.MANUS_LOCAL_DATA_DIR;
  process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
  closeDb();
  resetRunGraph();
  resetNodeVersions();
}

function restore(): void {
  closeDb();
  resetRunGraph();
  resetNodeVersions();
  if (prevDataDir === undefined) delete process.env.MANUS_LOCAL_DATA_DIR;
  else process.env.MANUS_LOCAL_DATA_DIR = prevDataDir;
  try {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  tmpDir = "";
}

describe("node version capture", () => {
  beforeEach(fresh);
  afterEach(restore);

  /** A run whose tool result carries the document text (N13's `content` field). */
  function documentRun(tool: string, args: Record<string, unknown>, content: string): string {
    beginRun(RUN, "Write the report");
    applyRunEvent(RUN, { type: "plan", goal: "Write the report", trivial: false, steps: [{ id: "s1", title: "Draft", instruction: "Write", successCriteria: "Done" }], source: "model" });
    applyRunEvent(RUN, { type: "plan_step", id: "s1", index: 1, total: 1, title: "Draft", phase: "start" });
    applyRunEvent(RUN, { type: "tool_call", name: tool, args });
    const [nodeId] = applyRunEvent(RUN, { type: "tool_result", name: tool, ok: true, summary: "done", content });
    assert.ok(nodeId, "the tool result created a node");
    return nodeId;
  }

  it("snapshots a document node's text as version 1", () => {
    const nodeId = documentRun("file_write", { path: "report.md" }, "# Report\nFirst draft");
    const node = getRunNode(nodeId, RUN);
    assert.ok(node, "the node exists");

    assert.equal(canVersionNode(node.type), true, "a file_write node is a document");
    assert.equal(nodeCurrentText(node), "# Report\nFirst draft", "the text is read back out of the payload");
    assert.equal(nodeTitle(node), "report.md", "the payload path names the document");

    // The live event path already snapshotted the node, so a manual sweep over
    // the same revision writes nothing.
    assert.equal(captureRunNodes(RUN), 0, "a repeat sweep of the same revision captures nothing");
    const versions = listVersionsForNode(nodeId);
    assert.equal(versions.length, 1);
    assert.equal(versions[0]!.version, 1);
    assert.equal(versions[0]!.content, "# Report\nFirst draft");
    assert.equal(versions[0]!.source, "agent", "an agent-written snapshot is marked as such");
  });

  it("captures a new version when the text changes, and not when it does not", () => {
    const nodeId = documentRun("file_write", { path: "report.md" }, "# Report");
    assert.equal(listVersionsForNode(nodeId).length, 1, "the event path snapshotted the document");
    assert.equal(getRunNode(nodeId, RUN)?.version, 2, "the write bumped the node revision once");

    // A repeated sweep over the same revision is a no-op: nothing new happened, so
    // no duplicate snapshot is written.
    assert.equal(captureRunNodes(RUN), 0, "a repeat sweep of the same revision captures nothing");
    assert.equal(listVersionsForNode(nodeId).length, 1, "the list did not grow");

    // A real edit is a new tool call, so it is a new node rather than another
    // revision of the first. Both documents keep their own version history, which
    // is what the canvas diffs.
    applyRunEvent(RUN, { type: "tool_call", name: "file_edit", args: { path: "report.md" } });
    const [editId] = applyRunEvent(RUN, { type: "tool_result", name: "file_edit", ok: true, summary: "done", content: "# Report\nv2" });
    assert.notEqual(editId, nodeId, "the edit is a separate node");
    assert.equal(listVersionsForNode(nodeId).length, 1, "the first document is unchanged");
    assert.equal(listVersionsForNode(editId!).length, 1, "the edit is its own version 1");
    assert.equal(listVersionsForNode(editId!)[0]!.content, "# Report\nv2");
  });

  it("leaves nodes that cannot be diffed alone", () => {
    beginRun(RUN, "Research the market");
    applyRunEvent(RUN, { type: "tool_call", name: "web_search", args: { query: "revenue" } });
    const [searchRawId] = applyRunEvent(RUN, { type: "tool_result", name: "web_search", ok: true, summary: "3 results" });
    assert.ok(searchRawId);
    const search = getRunNode(searchRawId, RUN);
    assert.ok(search, "the search result created a node");
    assert.equal(canVersionNode(search.type), false, "a search node carries no document");
    assert.equal(nodeCurrentText(search), "", "a search result has no diffable text");
    assert.equal(captureRunNodes(RUN), 0, "a search node is never snapshotted");
    assert.deepEqual(listVersionsForNode(searchRawId), []);
  });

  it("captures a webpage node and marks a user capture as the user's", () => {
    const nodeId = documentRun("web_fetch", { url: "https://example.com/" }, "<!doctype html><h1>Hi</h1>");
    const node = getRunNode(nodeId, RUN);
    assert.ok(node, "the fetch created a webpage node");
    assert.equal(node.type, "webpage", "web_fetch is a webpage node");

    const captured = captureNodeVersion({
      nodeId,
      runId: RUN,
      type: node.type,
      title: nodeTitle(node),
      content: "<!doctype html><h1>Hi again</h1>",
      nodeVersion: node.version,
      source: "user",
    });
    assert.ok(captured, "a canvas edit is captured");
    assert.equal(captured.source, "user", "the capture records who made it");
    assert.equal(listVersionsForNode(nodeId).length, 2, "the agent's snapshot and the edit are both kept");
  });

  it("captures a node's named files, but never a path outside the workspace", () => {
    const nodeId = documentRun("web_scaffold", { path: "site/index.html" }, "site/index.html");
    const node = getRunNode(nodeId, RUN);
    assert.ok(node, "the scaffold created a node");

    // The site exists inside the workspace, and a sibling file does not.
    fs.mkdirSync(path.join(tmpDir, "site"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "site", "index.html"), "<h1>Local</h1>", "utf8");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "loam-node-files-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside", "utf8");

    const files = nodeFiles(node, tmpDir);
    assert.deepEqual(files, [path.join(tmpDir, "site", "index.html")], "the named file resolves inside the workspace");

    assert.equal(captureNodeFiles({ nodeId, runId: RUN, paths: files, root: tmpDir }), 1, "the file version is captured");
    const stored = listFileVersions(nodeId);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.type, "file");
    assert.equal(stored[0]!.title, "index.html");
    assert.equal(stored[0]!.content, "<h1>Local</h1>");

    // A path outside the workspace is refused, so a hand-edited payload cannot
    // make the server read an arbitrary file. The file it did capture stays the
    // only version: the outside file added nothing.
    assert.equal(
      captureNodeFiles({ nodeId, runId: RUN, paths: [path.join(outside, "secret.txt")], root: tmpDir }),
      0,
    );
    assert.deepEqual(
      listFileVersions(nodeId).map((row) => row.title),
      ["index.html"],
      "the outside file was never captured",
    );
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("refuses to capture a node that does not belong to the run", () => {
    const nodeId = documentRun("file_write", { path: "report.md" }, "text");
    const captured = captureNodeVersion({ nodeId, runId: "task_some_other_run", type: "document", title: "x", content: "text", nodeVersion: 1 });
    assert.equal(captured, undefined, "a foreign run id cannot snapshot the node");
  });

  it("builds a run's event log and captures only its document nodes", () => {
    const events: AgentEvent[] = [
      { type: "task", taskId: RUN },
      { type: "tool_call", name: "web_search", args: { query: "x" } },
      { type: "tool_result", name: "web_search", ok: true, summary: "found" },
      { type: "tool_call", name: "file_write", args: { path: "notes.md" } },
      { type: "tool_result", name: "file_write", ok: true, summary: "done", content: "notes body" },
    ];
    beginRun(RUN, "Mixed run");
    for (const event of events) applyRunEvent(RUN, event);

    // The search node is skipped and the document node is captured once, by the
    // live event path. A second sweep over the same revision writes nothing, so
    // the count is 0 rather than a duplicate snapshot.
    assert.equal(captureRunNodes(RUN), 0, "a repeat sweep of the same revisions captures nothing");
    const documents = getRunNodes(RUN).filter((row) => canVersionNode(row.type));
    assert.equal(documents.length, 1, "exactly one document node exists in the run");
    assert.equal(listVersionsForNode(documents[0]!.id).length, 1, "its text is stored");
  });
});
