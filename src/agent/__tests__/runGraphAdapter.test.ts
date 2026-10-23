/**
 * Neo N1: the live-run adapter.
 *
 * The adapter is the only thing the server calls, so the tests pin the two
 * guarantees it must keep:
 *   1. an event is recorded as a node of the task's graph;
 *   2. a recording failure never escapes into the task.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { beginRun, applyRunEvent, getRunNodes, getRunGraphLayout, getRunNode, clearRun } from "../runGraphAdapter.js";
import { closeDb } from "../../server/sqliteStore.js";

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

const RUN = "task_adapter_1";
// The adapter holds one process-wide graph, so each test gets its own run id:
// a `closeDb()` resets the file but not the graph's in-process row index.
const RUN_2 = "task_adapter_2";

describe("run graph adapter: live run", () => {
  beforeEach(() => freshDataDir("loam-rungraph-adapter-"));
  afterEach(() => restoreDataDir());

  it("records events as nodes and can resume the same task", () => {
    const root = beginRun(RUN, "Write the quarterly report");
    assert.ok(root, "the adapter returns the root question");
    assert.equal(root!.type, "question");

    const ids = applyRunEvent(RUN, { type: "tool_call", name: "web_search", args: { query: "revenue" } });
    assert.equal(ids.length, 1, "a tool call produces one node");

    const nodes = getRunNodes(RUN);
    assert.equal(nodes.length, 2, "root plus the search node");
    assert.equal(nodes[1]!.type, "search");
    assert.deepEqual(getRunNode(ids[0]!, RUN)?.parent_ids, [root!.id], "the node hangs off the root");

    // A second `beginRun` resumes instead of starting over.
    beginRun(RUN, "Write the quarterly report");
    assert.equal(getRunNodes(RUN).length, 2, "resume does not duplicate nodes");

    const layout = getRunGraphLayout(RUN);
    assert.equal(layout.nodes.length, 2);
    assert.equal(layout.stats.totalNodes, 2);
    assert.ok(layout.edges.length >= 1, "the search node is connected to the root");
  });

  it("swallows recording failures so a task is never broken by the graph", () => {
    beginRun(RUN_2, "Never break the task");
    // An event that cannot be mapped is ignored, not thrown.
    const ids = applyRunEvent(RUN_2, { type: "assistant_token", text: "partial" });
    assert.deepEqual(ids, [], "unmapped events produce no node");
    assert.equal(getRunNodes(RUN_2).length, 1, "only the root exists");

    // A malformed payload must not escape either.
    assert.doesNotThrow(() => applyRunEvent(RUN_2, { type: "tool_call", name: "web_search", args: undefined }));
    clearRun(RUN_2);
    assert.equal(getRunNodes(RUN_2).length, 0, "clearRun drops the graph");
  });
});
