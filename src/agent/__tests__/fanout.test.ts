/**
 * Neo N7: branch fan-out acceptance tests.
 *
 * The three properties the task requires, asserted end to end:
 *   1. a 4-branch fixture really runs concurrently (wall time well below the
 *      serial cost of the same four branches);
 *   2. the merge node cites every branch it consumed;
 *   3. one failing branch does not fail the others.
 *
 * The core is model-free: the branch runner is injected, so these tests need no
 * Ollama client, no network and no workspace.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Emit } from "../events.js";
import {
  FANOUT_MAX_BRANCHES,
  deterministicMerge,
  normalizeBranches,
  runFanout,
  type FanoutGraph,
  type FanoutMergeInput,
} from "../fanout.js";
import { SubagentRegistry } from "../../subagent/registry.js";

const RUN = "task_n7";
const GOAL = "Write the quarterly report";

interface RecordedNode {
  id: string;
  type: "branch" | "merge";
  label: string;
  parents: string[];
  data: Record<string, unknown>;
}

/** A fake canvas: records the branch roots and the merge node. */
function fakeGraph(): { graph: FanoutGraph; nodes: RecordedNode[] } {
  const nodes: RecordedNode[] = [];
  let counter = 0;
  return {
    nodes,
    graph: {
      createBranch: (_runId, _fanoutId, index, label) => {
        const id = `branch-${index}`;
        nodes.push({ id, type: "branch", label, parents: ["parent-step"], data: { index } });
        return { id };
      },
      createMerge: (_runId, _fanoutId, branchNodeIds, summary) => {
        const id = `merge-${counter++}`;
        nodes.push({ id, type: "merge", label: "Merged", parents: branchNodeIds, data: { branchNodeIds, summary } });
        return { id };
      },
    },
  };
}

function specs(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    prompt: `branch ${index + 1}`,
    label: `branch ${index + 1}`,
  }));
}

/** A branch runner that sleeps `ms`, tracking the peak number in flight. */
function sleepingRunner(ms: number, failIndexes: readonly number[] = []) {
  let inFlight = 0;
  let peak = 0;
  const runner = async (branch: { index: number; prompt: string }) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, ms));
    inFlight -= 1;
    if (failIndexes.includes(branch.index)) {
      return { ok: false, text: "", error: "branch exploded" };
    }
    return { ok: true, text: `result of ${branch.prompt}`, steps: 3, toolCalls: 2 };
  };
  return { runner, peak: () => peak };
}

describe("fanout: four branches run concurrently", () => {
  it("finishes in far less than the serial cost of the same four branches", async () => {
    const { graph, nodes } = fakeGraph();
    const { runner, peak } = sleepingRunner(120);
    const events: string[] = [];
    const emit: Emit = (event) => {
      if (event.type === "fanout_branch") events.push(`${event.index}:${event.phase}`);
    };

    const registry = new SubagentRegistry(4);
    const start = Date.now();
    const report = await runFanout({
      runId: RUN,
      fanoutId: "f1",
      goal: GOAL,
      branches: specs(4),
      runner,
      emit,
      registry,
      graph,
    });
    const elapsed = Date.now() - start;

    // Four 120ms branches at concurrency 4 cost ~120ms, not ~480ms.
    assert.ok(elapsed < 120 * 4 * 0.6, `expected parallel execution, took ${elapsed}ms`);
    assert.equal(peak(), 4, "all four branches were in flight together");
    assert.equal(report.branches.length, 4);
    assert.equal(report.failedIndexes.length, 0);
    assert.equal(report.ok, true);

    // Every branch start was announced, and each finished.
    assert.deepEqual(events.sort(), ["0:start", "0:done", "1:start", "1:done", "2:start", "2:done", "3:start", "3:done"].sort());
    assert.equal(nodes.filter((node) => node.type === "branch").length, 4);
  });

  it("respects the semaphore bound instead of spawning every branch at once", async () => {
    const { graph } = fakeGraph();
    const { runner, peak } = sleepingRunner(60);
    const registry = new SubagentRegistry(2);
    await runFanout({
      runId: RUN,
      fanoutId: "f2",
      goal: GOAL,
      branches: specs(4),
      runner,
      emit: () => {},
      registry,
      graph,
    });
    assert.equal(peak(), 2, "the child semaphore caps in-flight branches");
  });
});

describe("fanout: the merge consumes every branch", () => {
  it("cites all four branch node ids and carries the merged result", async () => {
    const { graph, nodes } = fakeGraph();
    const { runner } = sleepingRunner(5);
    const registry = new SubagentRegistry(4);

    const report = await runFanout({
      runId: RUN,
      fanoutId: "f3",
      goal: GOAL,
      branches: specs(4),
      runner,
      emit: () => {},
      registry,
      graph,
    });

    const merge = nodes.find((node) => node.type === "merge");
    assert.ok(merge, "the merge node exists");
    assert.deepEqual(merge!.parents, ["branch-0", "branch-1", "branch-2", "branch-3"]);
    assert.deepEqual(merge!.data["branchNodeIds"], ["branch-0", "branch-1", "branch-2", "branch-3"]);
    assert.equal(merge!.id, report.mergeNodeId);
    // The merged answer contains every branch result.
    for (let i = 1; i <= 4; i += 1) {
      assert.match(report.summary, new RegExp(`result of branch ${i}`));
    }
  });

  it("emits a merge event naming every branch", async () => {
    const { graph } = fakeGraph();
    const { runner } = sleepingRunner(5);
    const registry = new SubagentRegistry(4);
    const merges: Array<{ branchNodeIds: string[]; summary: string }> = [];
    const emit: Emit = (event) => {
      if (event.type === "fanout_merge") merges.push({ branchNodeIds: event.branchNodeIds, summary: event.summary });
    };

    await runFanout({
      runId: RUN,
      fanoutId: "f4",
      goal: GOAL,
      branches: specs(4),
      runner,
      emit,
      registry,
      graph,
    });

    assert.equal(merges.length, 1);
    assert.deepEqual(merges[0]!.branchNodeIds, ["branch-0", "branch-1", "branch-2", "branch-3"]);
    assert.ok(merges[0]!.summary.length > 0);
  });
});

describe("fanout: one failing branch does not fail the others", () => {
  it("keeps the healthy branches and reports the failed index", async () => {
    const { graph, nodes } = fakeGraph();
    const { runner } = sleepingRunner(20, [2]);
    const registry = new SubagentRegistry(4);
    const branchEvents: Array<{ index: number; phase: string; summary?: string }> = [];
    const emit: Emit = (event) => {
      if (event.type === "fanout_branch") branchEvents.push({ index: event.index, phase: event.phase, summary: event.summary });
    };

    const report = await runFanout({
      runId: RUN,
      fanoutId: "f5",
      goal: GOAL,
      branches: specs(4),
      runner,
      emit,
      registry,
      graph,
    });

    // Three branches succeeded, one failed, and the fan-out still returned a result.
    assert.equal(report.branches.length, 4);
    assert.deepEqual(report.failedIndexes, [2]);
    assert.equal(report.ok, true);
    assert.ok(report.summary.includes("result of branch 1"));
    assert.ok(report.summary.includes("result of branch 4"));
    assert.match(report.summary, /Failed branch\(es\): 3/);

    // The failed branch announced its failure instead of silently vanishing.
    const failed = branchEvents.find((event) => event.index === 2 && event.phase === "done");
    assert.match(failed?.summary ?? "", /branch 3 failed/);
    // Its canvas node is marked failed, and the merge still cites it.
    const branchNode = nodes.find((node) => node.id === "branch-2");
    assert.ok(branchNode);
    assert.deepEqual((mergeParents(nodes)), ["branch-0", "branch-1", "branch-2", "branch-3"]);
  });

  it("reports every failed index when several branches fail", async () => {
    const { graph } = fakeGraph();
    const { runner } = sleepingRunner(10, [0, 3]);
    const registry = new SubagentRegistry(4);
    const report = await runFanout({
      runId: RUN,
      fanoutId: "f6",
      goal: GOAL,
      branches: specs(4),
      runner,
      emit: () => {},
      registry,
      graph,
    });
    assert.deepEqual(report.failedIndexes, [0, 3]);
    assert.match(report.summary, /Failed branch\(es\): 1, 4/);
  });
});

function mergeParents(nodes: RecordedNode[]): string[] {
  return nodes.find((node) => node.type === "merge")?.parents ?? [];
}

describe("fanout: helpers", () => {
  it("normalizes a caller-supplied branch list to the supported bounds", () => {
    assert.deepEqual(normalizeBranches([" a ", "", "b", 7, "c"]), ["a", "b", "c"]);
    assert.deepEqual(normalizeBranches("not a list"), []);
    const tooMany = Array.from({ length: FANOUT_MAX_BRANCHES + 10 }, (_, i) => `p${i}`);
    assert.equal(normalizeBranches(tooMany).length, FANOUT_MAX_BRANCHES);
  });

  it("deterministicMerge keeps every distinct fact and names the failures", () => {
    const summary = deterministicMerge({
      goal: GOAL,
      branches: [
        { index: 0, ok: true, text: "Revenue grew 12%.", nodeId: "b0", steps: 1, toolCalls: 1 },
        { index: 1, ok: true, text: "Costs fell 4%.", nodeId: "b1", steps: 1, toolCalls: 1 },
        { index: 2, ok: false, text: "", nodeId: "b2", steps: 0, toolCalls: 0, error: "boom" },
      ],
      failedIndexes: [2],
    });
    assert.match(summary, /Revenue grew 12%/);
    assert.match(summary, /Costs fell 4%/);
    assert.match(summary, /2 branch\(es\) completed/);
    assert.match(summary, /Failed branch\(es\): 3/);
  });

  it("falls back to the deterministic merge when the injected merger fails", async () => {
    const { graph } = fakeGraph();
    const { runner } = sleepingRunner(5);
    const registry = new SubagentRegistry(4);
    const report = await runFanout({
      runId: RUN,
      fanoutId: "f7",
      goal: GOAL,
      branches: specs(2),
      runner,
      emit: () => {},
      registry,
      graph,
      merger: () => Promise.reject(new Error("model unavailable")),
    });
    assert.match(report.summary, /result of branch 1/);
    assert.match(report.summary, /result of branch 2/);
  });

  it("refuses an empty fan-out", async () => {
    const { graph } = fakeGraph();
    const registry = new SubagentRegistry(4);
    await assert.rejects(
      () =>
        runFanout({
          runId: RUN,
          fanoutId: "f8",
          goal: GOAL,
          branches: [],
          runner: async () => ({ ok: true, text: "x" }),
          emit: () => {},
          registry,
          graph,
        }),
      /at least one branch/,
    );
  });

  it("hands the merge step the goal, every branch result and the failed indexes", async () => {
    const { graph } = fakeGraph();
    const { runner } = sleepingRunner(5, [1]);
    const registry = new SubagentRegistry(4);
    let seen: FanoutMergeInput | undefined;
    await runFanout({
      runId: RUN,
      fanoutId: "f9",
      goal: GOAL,
      branches: specs(2),
      runner,
      emit: () => {},
      registry,
      graph,
      merger: async (input) => {
        seen = input;
        return "merged";
      },
    });
    assert.ok(seen);
    assert.equal(seen!.goal, GOAL);
    assert.deepEqual(seen!.failedIndexes, [1]);
    assert.equal(seen!.branches.length, 2);
    assert.equal(seen!.branches[0]!.text, "result of branch 1");
  });
});
