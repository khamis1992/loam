/**
 * D13 — resumable deterministic workflows.
 *
 * Everything runs offline: the "agent" is an injected async function, so no model
 * and no network are involved. The tests pin the behaviour the runner promises:
 *   - a DAG of map/single stages executes in deterministic topological order;
 *   - a fan-out of N items produces N index-ordered outputs plus a combine call;
 *   - an interrupted run records finished calls and a resume executes only the rest;
 *   - the journal survives a process restart (a fresh journal instance on disk);
 *   - replaying an already-complete run executes nothing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { ToolContext } from "../registry.js";
import {
  FileWorkflowJournal,
  MemoryWorkflowJournal,
  callKey,
  createWorkflowTools,
  orderStages,
  renderPrompt,
  renderResultsBlock,
  runWorkflow,
  validateWorkflow,
  workflowFingerprint,
  type CompletedStage,
  type WorkflowAgent,
  type WorkflowDefinition,
  type WorkflowRunState,
} from "../workflow.js";

const SIX = ["a", "b", "c", "d", "e", "f"];

function fanOutCombine(): WorkflowDefinition {
  return {
    name: "fanout-combine",
    stages: [
      { id: "map", kind: "map", prompt: "process {item}" },
      { id: "combine", kind: "single", prompt: "combine these results:\n{results}", dependsOn: ["map"] },
    ],
  };
}

function fanOutOnly(): WorkflowDefinition {
  return { name: "fanout", stages: [{ id: "map", kind: "map", prompt: "process {item}" }] };
}

function ctx(workspace: string): ToolContext {
  return { cfg: {} as never, workspace, emit: () => {} } as unknown as ToolContext;
}

describe("workflow — definition validation", () => {
  it("accepts a valid DAG", () => {
    assert.equal(validateWorkflow(fanOutCombine()), null);
  });

  it("rejects empty stages, duplicate ids, bad kinds and unknown deps", () => {
    assert.match(validateWorkflow({ stages: [] }) ?? "", /at least one stage/);
    assert.match(
      validateWorkflow({ stages: [{ id: "x", kind: "map", prompt: "p" }, { id: "x", kind: "map", prompt: "p" }] }) ?? "",
      /duplicate stage id/,
    );
    assert.match(
      validateWorkflow({ stages: [{ id: "x", kind: "nope" as "map", prompt: "p" }] }) ?? "",
      /kind must be/,
    );
    assert.match(
      validateWorkflow({ stages: [{ id: "x", kind: "map", prompt: "p", dependsOn: ["ghost"] }] }) ?? "",
      /unknown stage/,
    );
    assert.match(
      validateWorkflow({
        stages: [
          { id: "x", kind: "single", prompt: "p", dependsOn: ["y"] },
          { id: "y", kind: "single", prompt: "p", dependsOn: ["x"] },
        ],
      }) ?? "",
      /cycle/,
    );
  });

  it("orders stages topologically and deterministically", () => {
    const workflow: WorkflowDefinition = {
      stages: [
        { id: "combine", kind: "single", prompt: "p", dependsOn: ["map"] },
        { id: "map", kind: "map", prompt: "p" },
      ],
    };
    assert.deepEqual(
      orderStages(workflow).map((s) => s.id),
      ["map", "combine"],
    );
  });

  it("fingerprints and keys are stable for identical inputs", () => {
    assert.equal(workflowFingerprint(fanOutCombine()), workflowFingerprint(fanOutCombine()));
    assert.equal(callKey("fp", "map", 0, "p", "s"), callKey("fp", "map", 0, "p", "s"));
    assert.notEqual(callKey("fp", "map", 0, "p", "s"), callKey("fp", "map", 1, "p", "s"));
  });
});

describe("workflow — prompt rendering", () => {
  const stages: CompletedStage[] = [
    { id: "map", kind: "map", outputs: [{ text: "done:a", steps: 1 }, { text: "done:b", steps: 1 }] },
  ];

  it("renders {item} and {results} deterministically", () => {
    assert.equal(renderPrompt("process {item}", "a", []), "process a");
    const rendered = renderPrompt("combine:\n{results}", undefined, stages);
    assert.match(rendered, /Stage "map"/);
    assert.match(rendered, /\[0\] done:a/);
    assert.match(rendered, /\[1\] done:b/);
  });

  it("renders an empty results block when nothing has completed", () => {
    assert.equal(renderResultsBlock([]), "");
  });
});

describe("workflow — runner", () => {
  it("fans out 6 items and runs the combine step", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const agent: WorkflowAgent = async (call) => {
      calls += 1;
      prompts.push(call.prompt);
      if (call.stageId === "combine") return { text: "combined", steps: 1 };
      return { text: `done:${call.item}`, steps: 1 };
    };

    const result = await runWorkflow({
      runId: "run-1",
      workflow: fanOutCombine(),
      items: SIX,
      agent,
      journal: new MemoryWorkflowJournal(),
    });

    assert.equal(result.status, "completed");
    assert.equal(calls, 7, "6 map calls + 1 combine call");
    assert.equal(result.executed.length, 7);
    assert.equal(result.replayed.length, 0);
    assert.equal(result.stages.length, 2);

    const mapStage = result.stages[0]!;
    assert.deepEqual(
      mapStage.outputs.map((o) => o.text),
      ["done:a", "done:b", "done:c", "done:d", "done:e", "done:f"],
      "map outputs are index-ordered",
    );
    assert.equal(result.output, "combined");
    assert.match(prompts[6]!, /Stage "map"/, "the combine prompt carries the map results");
    assert.match(prompts[6]!, /done:a/);
  });

  it("replays a completed run without executing anything", async () => {
    let calls = 0;
    const agent: WorkflowAgent = async (call) => {
      calls += 1;
      return { text: `done:${call.item}`, steps: 1 };
    };
    const journal = new MemoryWorkflowJournal();
    const first = await runWorkflow({ runId: "run-2", workflow: fanOutOnly(), items: SIX, agent, journal });
    assert.equal(first.executed.length, 6);

    const second = await runWorkflow({ runId: "run-2", workflow: fanOutOnly(), items: SIX, agent, journal });
    assert.equal(calls, 6, "no new agent calls on replay");
    assert.equal(second.executed.length, 0);
    assert.equal(second.replayed.length, 6);
    assert.equal(second.status, "completed");
  });

  it("assembles outputs in index order even when calls finish out of order", async () => {
    const agent: WorkflowAgent = async (call) => {
      await new Promise((r) => setTimeout(r, (SIX.length - call.index) * 2));
      return { text: `r${call.index}`, steps: 1 };
    };
    const result = await runWorkflow({
      runId: "run-3",
      workflow: fanOutOnly(),
      items: SIX,
      agent,
      journal: new MemoryWorkflowJournal(),
      concurrency: 4,
    });
    assert.deepEqual(
      result.stages[0]!.outputs.map((o) => o.text),
      ["r0", "r1", "r2", "r3", "r4", "r5"],
    );
  });

  it("refuses to resume a runId created for a different workflow", async () => {
    const journal = new MemoryWorkflowJournal();
    await runWorkflow({ runId: "run-4", workflow: fanOutOnly(), items: SIX, agent: async () => ({ text: "x", steps: 1 }), journal });
    await assert.rejects(
      runWorkflow({ runId: "run-4", workflow: fanOutCombine(), items: SIX, agent: async () => ({ text: "x", steps: 1 }), journal }),
      /different workflow/,
    );
  });
});

describe("workflow — kill and resume", () => {
  it("kills after 3 completes and a resume executes only the remaining 3", async () => {
    let count = 0;
    const controller = new AbortController();
    const agent: WorkflowAgent = async (call) => {
      count += 1;
      if (count === 3) controller.abort();
      return { text: `r${call.index}`, steps: 1 };
    };

    const journal = new MemoryWorkflowJournal();
    const first = await runWorkflow({
      runId: "kill-1",
      workflow: fanOutOnly(),
      items: SIX,
      agent,
      journal,
      signal: controller.signal,
    });
    assert.equal(first.status, "interrupted");
    assert.equal(first.executed.length, 3, "only the first three calls ran");

    const second = await runWorkflow({
      runId: "kill-1",
      workflow: fanOutOnly(),
      items: SIX,
      agent,
      journal,
    });
    assert.equal(second.status, "completed");
    assert.equal(second.executed.length, 3, "only the three remaining calls ran");
    assert.equal(second.replayed.length, 3, "the three finished calls replayed");
    assert.equal(count, 6, "exactly six agent calls in total");
    assert.deepEqual(
      second.stages[0]!.outputs.map((o) => o.text),
      ["r0", "r1", "r2", "r3", "r4", "r5"],
    );
  });

  it("keeps the journal across a process restart (fresh journal instance on disk)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-workflow-"));
    try {
      let count = 0;
      const controller = new AbortController();
      const agent: WorkflowAgent = async (call) => {
        count += 1;
        if (count === 3) controller.abort();
        return { text: `r${call.index}`, steps: 1 };
      };

      const first = await runWorkflow({
        runId: "restart-1",
        workflow: fanOutOnly(),
        items: SIX,
        agent,
        journal: new FileWorkflowJournal(dir),
        signal: controller.signal,
      });
      assert.equal(first.status, "interrupted");
      assert.equal(first.executed.length, 3);
      assert.ok(fs.existsSync(path.join(dir, "restart-1.json")), "the journal is persisted to disk");

      // A brand-new journal instance simulates a new process reading the same file.
      const second = await runWorkflow({
        runId: "restart-1",
        workflow: fanOutOnly(),
        items: SIX,
        agent,
        journal: new FileWorkflowJournal(dir),
      });
      assert.equal(second.executed.length, 3);
      assert.equal(second.replayed.length, 3);
      assert.equal(count, 6);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workflow — tools", () => {
  const tools = () => createWorkflowTools({ ollama: {} as never, registry: { forAllowlist: () => ({}) } as never });

  it("exposes workflow_run, workflow_resume and workflow_status", () => {
    assert.deepEqual(
      tools().map((t) => t.name).sort(),
      ["workflow_resume", "workflow_run", "workflow_status"],
    );
  });

  it("documents the workflow schema and required arguments", () => {
    const run = tools().find((t) => t.name === "workflow_run")!;
    const schema = run.parameters as { required?: string[]; properties?: Record<string, { type?: string }> };
    assert.deepEqual(schema.required, ["workflow", "items"]);
    assert.equal(schema.properties?.["workflow"]?.type, "object");
    const resume = tools().find((t) => t.name === "workflow_resume")!;
    assert.deepEqual((resume.parameters as { required?: string[] }).required, ["runId"]);
  });

  it("rejects a missing workflow and an empty item list without running an agent", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-workflow-tool-"));
    try {
      const run = tools().find((t) => t.name === "workflow_run")!;
      const missing = await run.run({}, ctx(workspace));
      assert.equal(missing.ok, false);
      assert.match(missing.content, /requires a workflow/);

      const noItems = await run.run({ workflow: fanOutOnly() }, ctx(workspace));
      assert.equal(noItems.ok, false);
      assert.match(noItems.content, /at least one item/);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reports an unknown runId from workflow_status", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-workflow-tool-"));
    try {
      const status = tools().find((t) => t.name === "workflow_status")!;
      const res = await status.run({ runId: "does-not-exist" }, ctx(workspace));
      assert.equal(res.ok, false);
      assert.match(res.content, /no workflow run found/);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("persists a run so workflow_status can read it back", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-workflow-tool-"));
    try {
      const state: WorkflowRunState = {
        version: 1,
        runId: "status-1",
        workflow: fanOutOnly(),
        items: SIX,
        status: "interrupted",
        calls: {},
        updatedAt: new Date().toISOString(),
      };
      const dir = path.join(workspace, ".loam", "workflows");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "status-1.json"), JSON.stringify(state), "utf8");

      const status = tools().find((t) => t.name === "workflow_status")!;
      const res = await status.run({ runId: "status-1" }, ctx(workspace));
      assert.equal(res.ok, true);
      const parsed = JSON.parse(res.content) as { status: string; totalCalls: number };
      assert.equal(parsed.status, "interrupted");
      assert.equal(parsed.totalCalls, 0);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
