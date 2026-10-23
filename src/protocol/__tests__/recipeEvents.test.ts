/**
 * Protocol tests for the Neo N4 incremental Recipe engine.
 *
 * The orchestrator emits `recipe_update` and `recipe_restart`; the protocol maps
 * them to `recipeUpdate` and `recipeRestart` socket events the UI renders. These
 * tests exercise the mapper end to end, including the fields a client needs to
 * render a live recipe: per-step status, the node a step maps to, the steps a
 * rewrite replaced, the remaining-work estimate and the kept/regenerated split of
 * a restart.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentEvent } from "../../agent/events.js";
import { createEventMapperState, mapAgentEvent } from "../events.js";
import type { ChatEvent, RecipeRestartEvent, RecipeUpdateEvent } from "../types.js";

function mapAll(events: AgentEvent[]): ChatEvent[] {
  const state = createEventMapperState();
  return events.flatMap((event) => mapAgentEvent(event, state, "sess_1"));
}

function recipeEvent(overrides: Partial<Extract<AgentEvent, { type: "recipe_update" }>> = {}) {
  return {
    type: "recipe_update" as const,
    goal: "Ship the quarterly report",
    steps: [
      { id: "s1", title: "Gather sources", instruction: "Search the web", successCriteria: "3 sources", status: "done" as const, nodeId: "node-1", completedCount: 2 },
      { id: "s2", title: "Retry the source", instruction: "Fetch again", successCriteria: "Source present", status: "ready" as const, replaces: ["s2"], completedCount: 2 },
    ],
    remainingEstimate: 1,
    change: "propose" as const,
    source: "planner" as const,
    ...overrides,
  };
}

describe("recipe protocol mapping", () => {
  it("maps a recipe_update to one recipeUpdate carrying the whole recipe", () => {
    const out = mapAll([recipeEvent()]);
    const update = out.find((e): e is RecipeUpdateEvent => e.type === "recipeUpdate");
    assert.ok(update, "expected a recipeUpdate event");
    assert.equal(out.filter((e) => e.type === "recipeUpdate").length, 1, "one event per recipe update");
    assert.equal(update!.goal, "Ship the quarterly report");
    assert.equal(update!.remainingEstimate, 1);
    assert.equal(update!.change, "propose");
    assert.equal(update!.source, "planner");
    assert.deepEqual(
      update!.steps.map((step) => ({ id: step.id, status: step.status, completedCount: step.completedCount })),
      [
        { id: "s1", status: "done", completedCount: 2 },
        { id: "s2", status: "ready", completedCount: 2 },
      ],
    );
  });

  it("carries the node id and the replaced steps of a rewritten recipe row", () => {
    const out = mapAll([recipeEvent()]);
    const update = out.find((e): e is RecipeUpdateEvent => e.type === "recipeUpdate")!;
    assert.equal(update.steps[0]!.nodeId, "node-1", "the row names the canvas node it maps to");
    assert.deepEqual(update.steps[1]!.replaces, ["s2"], "a rewrite names the step it replaced");
  });

  it("omits nodeId and replaces when the step has none", () => {
    const out = mapAll([
      recipeEvent({
        steps: [{ id: "s9", title: "Deliver", instruction: "Write the answer", successCriteria: "Answer exists", status: "proposed", completedCount: 0 }],
      }),
    ]);
    const step = out.find((e): e is RecipeUpdateEvent => e.type === "recipeUpdate")!.steps[0]!;
    assert.equal("nodeId" in step, false, "an unstarted step has no node");
    assert.equal("replaces" in step, false, "an unreplaced step has no replaces list");
  });

  it("maps a recipe_restart to a recipeRestart naming the kept and regenerated steps", () => {
    const out = mapAll([
      {
        type: "recipe_restart" as const,
        stepId: "s3",
        nodeId: "node-3",
        keptSteps: ["s1", "s2"],
        regeneratedSteps: ["s3", "s4"],
        reason: "user edited the input of step 3",
      },
    ]);
    const restart = out.find((e): e is RecipeRestartEvent => e.type === "recipeRestart");
    assert.ok(restart, "expected a recipeRestart event");
    assert.equal(out.filter((e) => e.type === "recipeRestart").length, 1);
    assert.equal(restart!.stepId, "s3");
    assert.equal(restart!.nodeId, "node-3");
    assert.deepEqual(restart!.keptSteps, ["s1", "s2"], "the upstream steps are kept verbatim");
    assert.deepEqual(restart!.regeneratedSteps, ["s3", "s4"], "downstream is regenerated");
    assert.match(restart!.reason, /user edited the input of step 3/);
  });

  it("does not turn recipe events into tool or plan frames", () => {
    const out = mapAll([recipeEvent(), { type: "recipe_restart", stepId: "s1", nodeId: "node-1", keptSteps: [], regeneratedSteps: ["s1"], reason: "restart" }]);
    assert.equal(out.filter((e) => e.type === "toolUsed").length, 0, "a recipe row is not a tool call");
    assert.equal(out.filter((e) => e.type === "planUpdate").length, 0, "a recipe row is not a plan update");
    assert.equal(out.filter((e) => e.type === "newPlanStep").length, 0, "a recipe row is not a plan step");
    assert.equal(out.length, 2, "each recipe event maps to exactly its own frame");
  });
});
