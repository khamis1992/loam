import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateWorkflow } from "../workflows/validate.js";
import { advanceWorkflow, resumeWorkflow, startWorkflow, renderTemplate, evalCondition, type WorkflowPorts } from "../workflows/engine.js";
import { saveWorkflow, loadWorkflow, loadRun, stepsOf, listWorkflows } from "../workflows/store.js";
import { selectBest } from "../selection/selectBest.js";
import { createInterrupt, resolveInterrupt, RESPONSE_SCHEMAS } from "../durable/interrupts.js";
import { resetWorkflowSchemaFlag } from "../workflows/store.js";
import type { WorkflowDef } from "../workflows/types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-orch-workflows-"));
process.env.LOAM_DATA_DIR = tmp;
process.env.MANUS_LOCAL_DATA_DIR = tmp;
resetWorkflowSchemaFlag();

const lim = { maxSupersteps: 100, maxParallelNodes: 4, maxSubworkflowDepth: 3 };
const vlim = { maxNodes: 64, isCloudModel: (m: string) => m.endsWith(":cloud") };

function ports(log: string[] = []): WorkflowPorts {
  return {
    runAgent: async (node, prompt) => {
      log.push(`${node.id}:${prompt}`);
      if (node.id === "draft_a") return { ok: true, text: "Plan A: weekly box" };
      if (node.id === "draft_b") return { ok: true, text: "Plan B: daily meals" };
      if (node.id === "draft_c") return { ok: true, text: "Plan B: daily meals" };
      return { ok: true, text: `done ${node.id}` };
    },
    runTool: async (name, args) => ({ ok: name !== "fail_tool", content: `${name}(${JSON.stringify(args)})` }),
    askHuman: (node, ctx) =>
      createInterrupt({ taskId: ctx.taskId, kind: "workflow_human", payload: { nodeId: node.id, question: node.human?.question }, responseSchema: { type: "string", maxLength: 2000 }, ttlMs: 600_000, maxPendingPerTask: 20 }).interruptId,
    select: (goal, candidates) => selectBest({ goal, candidates, maxCandidates: 8 }),
    loadWorkflow,
  };
}

const review: WorkflowDef = {
  id: "nutrio-offer",
  version: 1,
  title: "Nutrio offer review",
  inputs: { type: "object", required: ["market"], properties: { market: { type: "string" } } },
  start: "brief",
  nodes: [
    { id: "brief", kind: "transform", transform: { set: { brief: "Offer for {{inputs.market}}" } } },
    { id: "draft_a", kind: "agent", outputKey: "a", agent: { prompt: "{{state.brief}} (A)" } },
    { id: "draft_b", kind: "agent", outputKey: "b", agent: { prompt: "{{state.brief}} (B)" } },
    { id: "draft_c", kind: "agent", outputKey: "c", agent: { prompt: "{{state.brief}} (C)" } },
    { id: "pick", kind: "vote", outputKey: "best", waitFor: ["draft_a", "draft_b", "draft_c"], vote: { from: ["draft_a", "draft_b", "draft_c"], goal: "{{state.brief}}" } },
    { id: "approve", kind: "human", outputKey: "decision", human: { title: "Approve offer", question: "Ship {{state.best.text}}?" } },
    { id: "gate", kind: "condition", condition: { op: "eq", path: "state.decision", value: "yes" } },
    { id: "publish", kind: "tool", outputKey: "published", tool: { name: "write_file", args: { path: "offer.md", content: "{{state.best.text}}" } } },
    { id: "revise", kind: "agent", outputKey: "revised", agent: { prompt: "Revise {{state.best.text}}" } },
  ],
  edges: [
    { from: "brief", to: "draft_a" },
    { from: "brief", to: "draft_b" },
    { from: "brief", to: "draft_c" },
    { from: "draft_a", to: "pick" },
    { from: "draft_b", to: "pick" },
    { from: "draft_c", to: "pick" },
    { from: "pick", to: "approve" },
    { from: "approve", to: "gate" },
    { from: "gate", to: "publish", when: "true" },
    { from: "gate", to: "revise", when: "false" },
  ],
};

test("templates and conditions are data-only (no eval)", () => {
  assert.equal(renderTemplate("Hi {{inputs.name}} {{state.x.y}} {{state.missing}}", { inputs: { name: "Khamis" }, state: { x: { y: 3 } } }), "Hi Khamis 3 ");
  assert.equal(renderTemplate("{{process.env.SECRET}}", { inputs: {}, state: {} }), "{{process.env.SECRET}}");
  assert.equal(evalCondition({ all: [{ op: "gt", path: "state.n", value: 2 }, { not: { op: "exists", path: "state.z" } }] }, { state: { n: 3 } }), true);
});

test("validation catches structural mistakes and local models", () => {
  assert.deepEqual(validateWorkflow(review, vlim), []);
  const bad = structuredClone(review);
  bad.nodes.push({ id: "orphan", kind: "agent", outputKey: "o", agent: { prompt: "x", model: "qwen3:8b" } });
  bad.edges.push({ from: "gate", to: "nowhere", when: "true" });
  const errs = validateWorkflow(bad, vlim);
  assert.ok(errs.some((e) => e.includes("not a cloud model")));
  assert.ok(errs.some((e) => e.includes("unknown node nowhere")));
  assert.ok(errs.some((e) => e.includes("orphan is unreachable")));
  assert.ok(validateWorkflow({ id: "X" }, vlim).length > 0);
});

test("parallel drafts, join, vote, human pause, durable resume, branch", async () => {
  saveWorkflow(review, "user");
  assert.equal(listWorkflows()[0]?.id, "nutrio-offer");
  const log: string[] = [];
  let run = startWorkflow(review, "task_wf", { market: "Doha" });
  run = await advanceWorkflow(review, run, ports(log), lim);
  assert.equal(run.status, "waiting");
  assert.deepEqual((run.state.best as { winner: string }).winner, "draft_b", "two identical drafts form the majority group");
  assert.ok(log.includes("draft_a:Offer for Doha (A)"));
  const interruptId = run.waitingInterrupt?.interruptId as string;
  // Simulate a restart: reload the run from SQLite, resolve the durable interrupt, resume.
  const reloaded = loadRun(run.runId);
  assert.equal(reloaded?.status, "waiting");
  const res = resolveInterrupt(interruptId, "yes");
  assert.equal(res.ok, true);
  const done = await resumeWorkflow(review, reloaded!, "yes", ports(log), lim);
  assert.equal(done.status, "succeeded");
  assert.match(String(done.state.published), /Plan B: daily meals/);
  assert.equal(done.state.revised, undefined);
  assert.ok(stepsOf(run.runId).some((s) => s.nodeId === "approve" && s.status === "waiting"));
});

test("loops stop at maxVisits; failures stop the run; deadlocks are reported", async () => {
  const loop: WorkflowDef = {
    id: "loop",
    version: 1,
    title: "loop",
    inputs: { type: "object" },
    start: "work",
    nodes: [
      { id: "work", kind: "agent", outputKey: "w", maxVisits: 3, agent: { prompt: "again" } },
      { id: "check", kind: "condition", condition: { op: "eq", path: "state.w", value: "never" } },
    ],
    edges: [
      { from: "work", to: "check" },
      { from: "check", to: "work", when: "false" },
    ],
  };
  const r = await advanceWorkflow(loop, startWorkflow(loop, "t", {}), ports(), lim);
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /exceeded maxVisits 3/);
  const failing: WorkflowDef = { ...loop, id: "f", start: "t1", nodes: [{ id: "t1", kind: "tool", outputKey: "x", tool: { name: "fail_tool", args: {} } }], edges: [] };
  const f = await advanceWorkflow(failing, startWorkflow(failing, "t", {}), ports(), lim);
  assert.equal(f.status, "failed");
  const dead: WorkflowDef = {
    ...loop,
    id: "d",
    start: "a",
    nodes: [
      { id: "a", kind: "agent", outputKey: "a", agent: { prompt: "a" } },
      { id: "b", kind: "agent", outputKey: "b", waitFor: ["c"], agent: { prompt: "b" } },
      { id: "c", kind: "agent", outputKey: "c", agent: { prompt: "c" } },
    ],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
  };
  const d = await advanceWorkflow(dead, startWorkflow(dead, "t", {}), ports(), lim);
  assert.equal(d.status, "failed");
  assert.match(d.error ?? "", /deadlock/);
});

test("subworkflows run nested, refuse human nodes, and respect the depth limit", async () => {
  const child: WorkflowDef = { id: "child", version: 1, title: "c", inputs: { type: "object" }, start: "x", nodes: [{ id: "x", kind: "transform", transform: { set: { out: "child saw {{inputs.v}}" } } }], edges: [] };
  saveWorkflow(child, "user");
  const parent: WorkflowDef = { id: "parent", version: 1, title: "p", inputs: { type: "object" }, start: "s", nodes: [{ id: "s", kind: "subworkflow", outputKey: "sub", subworkflow: { workflowId: "child", inputs: { v: "42" } } }], edges: [] };
  const r = await advanceWorkflow(parent, startWorkflow(parent, "t", {}), ports(), lim);
  assert.equal(r.status, "succeeded");
  assert.deepEqual(r.state.sub, { out: "child saw 42" });
  const humanChild: WorkflowDef = { ...child, id: "hchild", nodes: [{ id: "x", kind: "human", outputKey: "h", human: { title: "t", question: "q" } }] };
  saveWorkflow(humanChild, "user");
  const p2: WorkflowDef = { ...parent, id: "p2", nodes: [{ id: "s", kind: "subworkflow", outputKey: "sub", subworkflow: { workflowId: "hchild", inputs: {} } }] };
  const r2 = await advanceWorkflow(p2, startWorkflow(p2, "t", {}), ports(), lim);
  assert.equal(r2.status, "failed");
  const r3 = await advanceWorkflow(parent, startWorkflow(parent, "t", {}), ports(), { ...lim, maxSubworkflowDepth: 0 });
  assert.match(r3.error ?? "", /depth limit/);
});

test("abort cancels between supersteps", async () => {
  const ac = new AbortController();
  ac.abort();
  const r = await advanceWorkflow(review, startWorkflow(review, "t", { market: "x" }), ports(), lim, ac.signal);
  assert.equal(r.status, "cancelled");
  void createInterrupt;
  void RESPONSE_SCHEMAS;
});
