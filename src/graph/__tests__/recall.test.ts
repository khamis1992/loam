/**
 * Neo N16 acceptance tests: cross-run recall ("bookshelf").
 *
 * The contract being tested is the one the spec states: an asset made in run A
 * is found by description in run B and attached as a node with a link back.
 * Around that, three properties are asserted because they are what makes the
 * feature safe in production:
 *
 *   1. **The shelf is derived, so it can be rebuilt.** A node edited after being
 *      indexed, a node that became `failed`, and a run that was deleted must all
 *      leave the shelf correctly, via `refresh`/`rebuild` rather than trusting a
 *      stale row.
 *   2. **It degrades, it does not break.** With no embedder the shelf answers
 *      lexically, and a search over an empty shelf returns `[]`, never throws.
 *   3. **It never leaks a credential.** A node whose text looks like a token is
 *      not indexed at all, because the shelf is later injected into a prompt.
 *
 * The store is real (SQLite) so the tests exercise the same code path the server
 * uses. Each test gets its own temporary data directory. No network, no model.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { AgentEvent } from "../../agent/events.js";
import { RunGraph } from "../runGraph.js";
import type { RunNode } from "../store.js";
import {
  RecallIndex,
  isRecallable,
  recallMedium,
  recallText,
} from "../recall.js";
import { createRecallTools, formatRecallHit } from "../../tools/memory.js";
import { RECALL_NODE_ENTITY as RECALL_KIND } from "../recall.js";
import { allEntities, closeDb } from "../../server/sqliteStore.js";

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

const RUN_A = "task_recall_a";
const RUN_B = "task_recall_b";

/** One finished node, in the shape `RunGraph` produces for a tool result. */
function node(over: Partial<RunNode> & { id: string; type: RunNode["type"] }): RunNode {
  const now = Date.now();
  return {
    id: over.id,
    run_id: over.run_id ?? RUN_A,
    parent_ids: [],
    type: over.type,
    status: over.status ?? "finished",
    data: over.data,
    version: 1,
    created: over.created ?? now,
    updated: over.updated ?? now,
  };
}

/** Build a graph that has already indexed a finished document node. */
function graphWith(nodeA: RunNode): { graph: RunGraph; index: RecallIndex } {
  const graph = new RunGraph();
  const index = new RecallIndex();
  graph.attachRecall(index);
  graph.beginRun(RUN_A, "Write the quarterly report");
  return { graph, index };
}

/**
 * A recorded run whose final event publishes an image artifact, so the graph
 * really holds the origin node the recall tool is supposed to link back to.
 */
function runPublishingImage(taskId: string, path: string, title: string): AgentEvent[] {
  return [
    { type: "task", taskId },
    { type: "plan", goal: title, trivial: false, steps: [], source: "model" },
    { type: "tool_call", name: "gen_image", args: { prompt: title } },
    { type: "tool_result", name: "gen_image", ok: true, summary: "generated" },
    { type: "artifact_published", path, kind: "image", title, mime: "image/png", sizeBytes: 10, sha256: "abc" },
    { type: "done", text: title, steps: 1, model: "test-model" },
  ];
}

describe("N16 recallText / recallMedium / isRecallable", () => {
  it("builds a description from the metadata a node actually carries", () => {
    const text = recallText(
      node({
        id: "n1",
        type: "document",
        data: { title: "Quarterly report", path: "reports/q3.md" },
      }),
    );
    assert.match(text, /Quarterly report/);
    assert.match(text, /reports\/q3\.md/);
  });

  it("falls back to the node shape when it carries no description", () => {
    const text = recallText(node({ id: "n2", type: "note", data: {} }));
    assert.match(text, /^note /);
  });

  it("splits a `media` node into image or video by kind/mime", () => {
    assert.equal(
      recallMedium(node({ id: "m1", type: "media", data: { kind: "image" } })),
      "image",
    );
    assert.equal(
      recallMedium(node({ id: "m2", type: "media", data: { mime: "video/mp4" } })),
      "video",
    );
    // An unlabelled media node is still recallable, just as an unknown medium.
    assert.equal(recallMedium(node({ id: "m3", type: "media", data: {} })), "media");
    assert.equal(recallMedium(node({ id: "d1", type: "document" })), "text");
    assert.equal(recallMedium(node({ id: "w1", type: "webpage", data: {} })), "webpage");
  });

  it("only shelves finished, recallable nodes", () => {
    assert.ok(isRecallable(node({ id: "ok", type: "document", data: { title: "report" } })));
    assert.ok(!isRecallable(node({ id: "running", type: "document", status: "running", data: { title: "report" } })));
    assert.ok(!isRecallable(node({ id: "failed", type: "document", status: "failed", data: { title: "report" } })));
    // A recipe step is not an asset: it is the process, not the output.
    assert.ok(!isRecallable(node({ id: "step", type: "recipe_step", data: { title: "search" } })));
  });
});

describe("N16 RecallIndex", () => {
  beforeEach(() => freshDataDir("loam-recall-"));
  afterEach(() => restoreDataDir());

  it("indexes a finished node and finds it by description (lexical, no embedder)", async () => {
    const { index } = graphWith(
      node({ id: "doc-1", type: "document", data: { title: "Nutrio dashboard image", path: "out/dash.png" } }),
    );
    await index.index(
      node({ id: "doc-1", type: "document", data: { title: "Nutrio dashboard image", path: "out/dash.png" } }),
    );
    const hits = await index.search({ query: "Nutrio dashboard" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.node.nodeId, "doc-1");
    assert.equal(hits[0]!.node.medium, "text");
    assert.equal(hits[0]!.node.path, "out/dash.png");
    assert.equal(hits[0]!.channel, "lexical");
  });

  it("ranks the best-matching node first", async () => {
    const { index } = graphWith(node({ id: "x", type: "note" }));
    await index.index(node({ id: "a", type: "document", data: { title: "quarterly revenue report" } }));
    await index.index(node({ id: "b", type: "document", data: { title: "holiday photo album" } }));
    const hits = await index.search({ query: "quarterly revenue report" });
    assert.equal(hits[0]!.node.nodeId, "a");
  });

  it("answers an empty shelf without throwing", async () => {
    const { index } = graphWith(node({ id: "x", type: "note" }));
    const hits = await index.search({ query: "anything" });
    assert.deepEqual(hits, []);
    assert.deepEqual(index.stats(), { nodes: 0, vectorized: 0, lexicalOnly: true, model: "" });
  });

  it("filters by medium and by run", async () => {
    const { index } = graphWith(node({ id: "x", type: "note" }));
    await index.index(node({ id: "img", type: "media", data: { kind: "image", title: "hero banner" } }));
    await index.index(
      node({ id: "other", run_id: RUN_B, type: "document", data: { title: "other run report" } }),
    );
    assert.equal((await index.search({ query: "hero banner", mediums: ["image"] })).length, 1);
    assert.equal((await index.search({ query: "hero banner", mediums: ["text"] })).length, 0);
    assert.equal((await index.search({ query: "report", runId: RUN_B })).length, 1);
    assert.equal((await index.search({ query: "report", runId: RUN_A })).length, 0);
  });

  it("drops a node that stopped being a finished result", async () => {
    const { index } = graphWith(node({ id: "x", type: "note" }));
    await index.index(node({ id: "doc-2", type: "document", data: { title: "draft report" } }));
    assert.equal(index.stats().nodes, 1);
    // The node failed: refresh must forget it rather than recall it as a result.
    await index.refresh(node({ id: "doc-2", type: "document", status: "failed", data: { title: "draft report" } }));
    assert.equal(index.stats().nodes, 0);
    assert.deepEqual(await index.search({ query: "draft report" }), []);
  });

  it("re-indexes a node whose text was edited, so the shelf matches the graph", async () => {
    const { index } = graphWith(node({ id: "x", type: "note" }));
    // The words are unique on purpose: a shared word would still match the new
    // text lexically, which is correct behaviour, not staleness.
    await index.index(node({ id: "doc-3", type: "document", data: { title: "zeppelin report" } }));
    await index.refresh(node({ id: "doc-3", type: "document", data: { title: "harbour report" } }));
    assert.deepEqual(await index.search({ query: "zeppelin" }), []);
    const hits = await index.search({ query: "harbour" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.node.text, "harbour report");
  });

  it("never shelves a node whose text looks like a credential", async () => {
    const { index } = graphWith(node({ id: "x", type: "note" }));
    const stored = await index.index(
      node({ id: "leak", type: "document", data: { title: "api_key: sk-abcdefghijklmnopqrst" } }),
    );
    assert.equal(stored, false);
    assert.equal(index.stats().nodes, 0);
  });

  it("rebuilds the shelf from the graph, repairing stale rows", async () => {
    const { graph, index } = graphWith(node({ id: "x", type: "note" }));
    await index.index(node({ id: "doc-4", type: "document", data: { title: "stale spanner" } }));
    // The graph is the source of truth: the row is stale and must be replaced.
    const nodes = [node({ id: "doc-4", type: "document", data: { title: "current rivet" } })];
    const indexed = await index.rebuild({ runs: () => [{ runId: RUN_A, nodes }] });
    assert.equal(indexed, 1);
    assert.deepEqual(await index.search({ query: "stale spanner" }), []);
    assert.equal((await index.search({ query: "current rivet" })).length, 1);
    // And a node that vanished from the graph leaves the shelf.
    await index.rebuild({ runs: () => [] });
    assert.equal(index.stats().nodes, 0);
  });

  it("persists across a new index instance (restart)", async () => {
    const { index } = graphWith(node({ id: "x", type: "note" }));
    await index.index(node({ id: "doc-5", type: "document", data: { title: "persisted report" } }));
    const reloaded = new RecallIndex();
    assert.equal(reloaded.stats().nodes, 1);
    assert.equal((await reloaded.search({ query: "persisted report" })).length, 1);
  });
});

describe("N16 recall tool", () => {
  beforeEach(() => freshDataDir("loam-recall-tool-"));
  afterEach(() => restoreDataDir());

  it("lists candidates, then attaches one as a node linked back to its run", async () => {
    const graph = new RunGraph();
    const index = new RecallIndex();
    graph.attachRecall(index);
    // Run A: an image is really produced and published, so the origin exists.
    graph.replay(RUN_A, runPublishingImage(RUN_A, "out/dash.png", "Nutrio dashboard"));
    // `gen_image` also creates a `media` node, so pick the published artifact.
    const origin = graph
      .getRunNodes(RUN_A)
      .find((n) => n.type === "media" && (n.data as Record<string, unknown>)["path"] === "out/dash.png");
    assert.ok(origin, "the replayed run must contain the published image node");
    const originData = origin.data as Record<string, unknown>;
    assert.equal(originData["mime"], "image/png");
    assert.equal(originData["kind"], "image");
    await index.index(origin);

    // Run B: a different run asks for the asset by description.
    graph.beginRun(RUN_B, "Write the case study");
    const attached: string[] = [];
    const tools = createRecallTools({
      index,
      runId: RUN_B,
      attach: (source, runId, query) => {
        const created = graph.attachRecallNode(
          runId,
          source,
          query,
          (s) => graph.getNode(s.nodeId, s.runId),
        );
        assert.ok(created);
        attached.push(created.id);
        return created;
      },
    });
    const recall = tools[0]!;

    const listed = await recall.run({ query: "Nutrio dashboard" }, {} as never);
    assert.equal(listed.ok, true);
    assert.match(listed.content, new RegExp(origin.id));
    assert.match(listed.content, /out\/dash\.png/);

    const attachedResult = await recall.run({ query: "Nutrio dashboard", node_id: origin.id }, {} as never);
    assert.equal(attachedResult.ok, true);
    assert.equal(attached.length, 1);

    // The attached node lives in run B and names run A, so the canvas can link back.
    const created = graph.getNode(attached[0]!, RUN_B)!;
    assert.equal(created.run_id, RUN_B);
    const data = created.data as Record<string, unknown>;
    assert.equal(data["recalled"], true);
    assert.equal(data["sourceNodeId"], origin.id);
    assert.equal(data["sourceRunId"], RUN_A);
    assert.equal(data["sourceType"], "media");
    // The origin still exists, so the artifact location is carried over.
    assert.equal(data["path"], "out/dash.png");
  });

  it("answers an empty shelf with a plain message, not an error", async () => {
    const index = new RecallIndex();
    const recall = createRecallTools({ index })[0];
    assert.ok(recall);
    const result = await recall.run({ query: "nothing here" }, {} as never);
    assert.equal(result.ok, true);
    assert.match(result.content, /nothing recalled/i);
  });

  it("refuses an unknown medium and reports a missing node", async () => {
    const index = new RecallIndex();
    const [recall] = createRecallTools({ index });
    assert.ok(recall);
    assert.match((await recall.run({ query: "x", medium: "pdf" }, {} as never)).content, /unknown medium/);
    assert.match((await recall.run({ query: "x", node_id: "nope" }, {} as never)).content, /not on the shelf/);
  });

  it("reports shelf status, including the lexical-only mode", async () => {
    const index = new RecallIndex();
    const tools = createRecallTools({ index });
    const status = tools.find((tool) => tool.name === "recall_status");
    assert.ok(status);
    const result = await status.run({}, {} as never);
    assert.match(result.content, /0 node\(s\)/);
    assert.match(result.content, /lexical-only/);
  });

  it("renders a hit with its provenance for the model to read", () => {
    const text = formatRecallHit(
      {
        node: {
          id: "asset-1",
          nodeId: "asset-1",
          runId: RUN_A,
          type: "media",
          medium: "image",
          text: "Nutrio dashboard",
          status: "finished",
          path: "out/dash.png",
          dim: 0,
          model: "",
          created: 0,
          updated: 0,
        },
        score: 0.42,
        channel: "vector",
      },
      1,
    );
    assert.match(text, /\[image\] media/);
    assert.match(text, new RegExp(RUN_A));
    assert.match(text, /score 0\.420/);
    assert.match(text, /out\/dash\.png/);
  });

  it("is reachable from the always-on run tool set", async () => {
    const { ALWAYS_ON_TOOLS } = await import("../../server/runTools.js");
    assert.ok(ALWAYS_ON_TOOLS.includes("recall"));
    assert.ok(ALWAYS_ON_TOOLS.includes("recall_status"));
  });

  it("lets a run-scoped instance replace the process-wide copy", async () => {
    // The process-wide `recall` is registered for discovery; a run binds its
    // own copy with the run id and attach callback. Binding must replace, not
    // collide: `register` rejects a duplicate name and would crash the run.
    const { ToolRegistry } = await import("../../tools/registry.js");
    const registry = new ToolRegistry();
    registry.registerAll(createRecallTools());
    const runScoped = createRecallTools({ runId: RUN_B })[0]!;
    assert.throws(() => registry.forAllowlist(["recall"]).withTools([runScoped]), /duplicate tool/);

    const bound = registry.forAllowlist(["recall", "recall_status"]).withBound([
      runScoped,
      createRecallTools({ runId: RUN_B })[1]!,
    ]);
    assert.deepEqual(bound.names().sort(), ["recall", "recall_status"]);
    // The bound instance is the run-scoped one: it knows this run's id.
    const attached: string[] = [];
    const tools = createRecallTools({
      index: new RecallIndex(),
      runId: RUN_B,
      attach: (source, runId) => {
        attached.push(runId);
        return node({ id: "created", run_id: runId, type: "note", data: { sourceNodeId: source.nodeId } });
      },
    });
    const replaced = registry.forAllowlist(["recall"]).withBound([tools[0]!]);
    const result = await replaced.get("recall")!.run({ query: "x", node_id: "nope" }, {} as never);
    assert.match(result.content, /not on the shelf/);
    assert.deepEqual(attached, []);
  });

  it("writes its rows into the entities table, keyed by node id", async () => {
    const { index } = graphWith(node({ id: "x", type: "note" }));
    await index.index(node({ id: "doc-6", type: "document", data: { title: "persisted row" } }));
    // The row is keyed by the node id, so it can be re-read without the index.
    const rows = allEntities<{ id: string; nodeId: string; runId: string; text: string }>(RECALL_KIND);
    const row = rows.find((r) => r.nodeId === "doc-6");
    assert.ok(row, "the indexed node must be persisted as a recall row");
    assert.equal(row.id, "doc-6");
    assert.equal(row.runId, RUN_A);
    assert.match(row.text, /persisted row/);
    assert.ok(fs.readdirSync(tmpDir).length > 0, "the shelf must persist to the data directory");
  });
});
