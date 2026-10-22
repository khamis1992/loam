/**
 * Tests for the live plan-step statuses (plan tool) and the work-phase
 * transitions (phase_set tool).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentEvent } from "../../agent/events.js";
import { planTool } from "../specAliases.js";
import type { ToolContext } from "../registry.js";
import { createPhaseTools, getTaskPhase } from "../phaseTools.js";

function makeCtx(taskId?: string): { ctx: ToolContext; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const ctx = {
    cfg: {},
    workspace: ".",
    emit: (event: AgentEvent) => {
      events.push(event);
    },
    taskId,
  } as unknown as ToolContext;
  return { ctx, events };
}

describe("plan tool live statuses", () => {
  it("derives default statuses from currentStep and maps done to the done phase", async () => {
    const { ctx, events } = makeCtx("plan-default");
    const res = await planTool().run({ steps: [{ title: "a" }, { title: "b" }, { title: "c" }], currentStep: 1 }, ctx);

    assert.equal(res.ok, true);
    assert.equal(res.content, "1/3 done; doing: b");

    const plan = events.find((e) => e.type === "plan");
    assert.ok(plan && plan.type === "plan");
    assert.deepEqual(plan.steps.map((s) => s.status), ["done", "doing", "pending"]);

    const phases = events.filter((e) => e.type === "plan_step").map((e) => (e.type === "plan_step" ? e.phase : undefined));
    assert.deepEqual(phases, ["done", "start", "start"]);
  });

  it("stays backward compatible with title-only steps", async () => {
    const { ctx } = makeCtx("plan-compat");
    const res = await planTool().run({ steps: [{ title: "only" }], currentStep: 0 }, ctx);
    assert.equal(res.ok, true);
    assert.equal(res.content, "0/1 done; doing: only");
  });

  it("keeps an explicit id and note on the emitted step", async () => {
    const { ctx, events } = makeCtx("plan-id");
    await planTool().run({ steps: [{ title: "a", id: "custom-1", status: "done", note: "finished" }], currentStep: 0 }, ctx);

    const plan = events.find((e) => e.type === "plan");
    assert.ok(plan && plan.type === "plan");
    assert.equal(plan.steps[0]?.id, "custom-1");
    assert.equal(plan.steps[0]?.status, "done");
    assert.equal(plan.steps[0]?.note, "finished");
  });

  it("rejects blocked without a note", async () => {
    const { ctx } = makeCtx("plan-blocked");
    const res = await planTool().run({ steps: [{ title: "a", status: "blocked" }], currentStep: 0 }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.content, /requires a note/);
  });

  it("rejects cancelled without a note", async () => {
    const { ctx } = makeCtx("plan-cancelled");
    const res = await planTool().run({ steps: [{ title: "a", status: "cancelled" }], currentStep: 0 }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.content, /requires a note/);
  });

  it("accepts blocked with a note and reports the count", async () => {
    const { ctx } = makeCtx("plan-blocked-note");
    const res = await planTool().run({ steps: [{ title: "a", status: "blocked", note: "waiting on API" }], currentStep: 0 }, ctx);
    assert.equal(res.ok, true);
    assert.equal(res.content, "0/1 done; blocked: 1");
  });

  it("rejects two doing steps unless parallel is set", async () => {
    const { ctx } = makeCtx("plan-two-doing");
    const res = await planTool().run({ steps: [{ title: "a", status: "doing" }, { title: "b", status: "doing" }], currentStep: 0 }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.content, /at most one step/);
  });

  it("allows two doing steps when parallel is true", async () => {
    const { ctx } = makeCtx("plan-parallel");
    const res = await planTool().run({ steps: [{ title: "a", status: "doing" }, { title: "b", status: "doing" }], currentStep: 0, parallel: true }, ctx);
    assert.equal(res.ok, true);
    assert.equal(res.content, "0/2 done; doing: a, b");
  });

  it("rejects an unknown status", async () => {
    const { ctx } = makeCtx("plan-bad-status");
    const res = await planTool().run({ steps: [{ title: "a", status: "waiting" }], currentStep: 0 }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.content, /invalid status/);
  });
});

describe("phase_set", () => {
  it("records a transition and emits a phase event", async () => {
    const { ctx, events } = makeCtx("phase-1");
    const res = await createPhaseTools()[0]!.run({ phase: "build", reason: "plan approved" }, ctx);

    assert.equal(res.ok, true);
    assert.equal(res.content, "chat -> build: plan approved");
    assert.equal(getTaskPhase("phase-1"), "build");

    const phase = events.find((e) => e.type === "phase");
    assert.ok(phase && phase.type === "phase");
    assert.equal(phase.phase, "build");
    assert.equal(phase.reason, "plan approved");
  });

  it("reports the previous phase on a second transition", async () => {
    const { ctx } = makeCtx("phase-2");
    const tool = createPhaseTools()[0]!;
    await tool.run({ phase: "plan", reason: "first" }, ctx);
    const res = await tool.run({ phase: "verify", reason: "done" }, ctx);

    assert.equal(res.content, "plan -> verify: done");
    assert.equal(getTaskPhase("phase-2"), "verify");
  });

  it("rejects an unknown phase", async () => {
    const { ctx } = makeCtx("phase-3");
    const res = await createPhaseTools()[0]!.run({ phase: "deploy", reason: "x" }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.content, /unknown phase/);
    assert.equal(getTaskPhase("phase-3"), undefined);
  });

  it("rejects an empty reason", async () => {
    const { ctx } = makeCtx("phase-4");
    const res = await createPhaseTools()[0]!.run({ phase: "build", reason: "   " }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.content, /reason/);
  });
});
