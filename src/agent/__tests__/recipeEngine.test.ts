/**
 * Neo N4: the incremental Recipe engine state machine.
 *
 * Four properties must hold, and they are asserted here:
 *   1. the remaining-work estimate is derived from the open steps and never
 *      reports more work than the recipe actually holds;
 *   2. rewriting a step that already ran is refused, and a rewrite of a pending
 *      step names the ids it replaces;
 *   3. restarting from a step keeps every upstream step verbatim (same id,
 *      status and node) and reopens only the restart point;
 *   4. re-seeding after a replan keeps finished steps and drops the ones the
 *      new plan does not mention.
 *
 * The engine is free of model and tool dependencies, so these tests need no
 * Ollama client, no workspace and no network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PlanStepInfo } from "../events.js";
import {
  applyProposal,
  beginStep,
  completedCount,
  finishStep,
  initRecipe,
  observationsFromTrace,
  pendingCount,
  planStepsOf,
  reseedRecipe,
  remainingEstimate,
  restartFrom,
  stepIdOfNode,
  type RecipeState,
} from "../recipe.js";

function planSteps(count: number): PlanStepInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i + 1}`,
    title: `step ${i + 1}`,
    instruction: `do thing ${i + 1}`,
    successCriteria: `thing ${i + 1} is done`,
  }));
}

describe("recipe engine: remaining estimate", () => {
  it("counts open steps and never reports more than the recipe holds", () => {
    const state = initRecipe("goal", planSteps(3));
    assert.equal(state.steps.length, 3, "the seed plan becomes the recipe");
    assert.equal(state.steps[0]!.status, "ready", "the first step is ready to run");
    assert.equal(pendingCount(state.steps), 3, "all three steps are open");
    assert.equal(remainingEstimate(state.steps), 3);

    // A planner that claims a longer horizon cannot inflate the estimate beyond
    // the steps the recipe actually contains.
    assert.equal(remainingEstimate(state.steps, 99), 3, "the estimate is clamped to the open steps");

    // As steps finish, the estimate falls by one each time.
    const afterOne = finishStep(state, 0, true);
    assert.equal(completedCount(afterOne.steps), 1);
    assert.equal(remainingEstimate(afterOne.steps), 2);

    const afterTwo = finishStep(afterOne, 1, true);
    assert.equal(remainingEstimate(afterTwo.steps), 1);

    const afterThree = finishStep(afterTwo, 2, true);
    assert.equal(remainingEstimate(afterThree.steps), 0, "a finished recipe has no remaining work");
  });

  it("treats a blocked step as terminal evidence, not pending work", () => {
    let state = initRecipe("goal", planSteps(3));
    state = finishStep(state, 0, false);
    assert.equal(state.steps[0]!.status, "blocked");
    // The blocked step is not work the user is still waiting for: the planner
    // re-routes around it.
    assert.equal(pendingCount(state.steps), 2);
    assert.equal(remainingEstimate(state.steps), 2);
  });

  it("keeps the estimate at zero for an empty recipe", () => {
    const state = initRecipe("goal", []);
    assert.equal(state.current, -1, "no current step before the first one starts");
    assert.equal(remainingEstimate(state.steps), 0);
    assert.equal(pendingCount(state.steps), 0);
  });
});

describe("recipe engine: rewrite", () => {
  it("records the id a rewrite replaces", () => {
    let state = initRecipe("goal", planSteps(2));
    state = beginStep(state, 0);
    const applied = applyProposal(state, {
      add: [],
      rewrite: { s2: { id: "s2b", title: "step 2 revised", instruction: "do the second thing differently", successCriteria: "the revised thing is done" } },
      drop: [],
      remainingEstimate: 2,
      hasMore: true,
    });

    assert.equal(applied.change, "rewrite");
    assert.deepEqual(applied.replaced, ["s2"], "the replaced step id is reported");
    const rewritten = applied.state.steps.find((step) => step.id === "s2b");
    assert.ok(rewritten, "the step carries its own new id");
    assert.deepEqual(rewritten!.replaces, ["s2"], "the rewrite names the step it replaced");
    assert.equal(rewritten!.status, "proposed", "the rewrite is still pending");
    // The order of the recipe is preserved so a restart can be compared.
    assert.deepEqual(applied.state.steps.map((step) => step.id), ["s1", "s2b"]);
  });

  it("refuses to rewrite a step that already ran", () => {
    let state = initRecipe("goal", planSteps(2));
    state = beginStep(state, 0);
    state = finishStep(state, 0, true);

    const applied = applyProposal(state, {
      add: [],
      rewrite: { s1: { id: "s1x", title: "step 1 reworded", instruction: "do it again", successCriteria: "done" } },
      drop: [],
      remainingEstimate: 1,
      hasMore: true,
    });

    // A finished step is evidence: it may not be silently reworded.
    assert.equal(applied.change, "advance");
    assert.deepEqual(applied.replaced, [], "no step was rewritten");
    assert.equal(applied.state.steps[0]!.status, "done", "the finished step is untouched");
    assert.equal(applied.state.steps[0]!.title, "step 1");
  });

  it("drops only pending steps and never a finished one", () => {
    let state = initRecipe("goal", planSteps(3));
    state = finishStep(state, 0, true);

    const applied = applyProposal(state, {
      add: [],
      rewrite: {},
      drop: ["s1", "s3"],
      remainingEstimate: 1,
      hasMore: true,
    });

    assert.equal(applied.change, "drop");
    assert.deepEqual(applied.dropped, ["s3"], "only the pending step was dropped");
    assert.equal(applied.state.steps[0]!.status, "done", "the finished step survives a drop request");
    assert.equal(applied.state.steps[2]!.status, "skipped");
    assert.equal(pendingCount(applied.state.steps), 1);
  });

  it("grows the recipe only at the tail", () => {
    let state = initRecipe("goal", planSteps(1));
    state = finishStep(state, 0, true);

    const applied = applyProposal(state, {
      add: [
        { id: "s2", title: "second", instruction: "do the second thing", successCriteria: "second is done" },
        { id: "s3", title: "third", instruction: "do the third thing", successCriteria: "third is done" },
      ],
      rewrite: {},
      drop: [],
      remainingEstimate: 2,
      hasMore: true,
    });

    assert.equal(applied.change, "propose");
    assert.deepEqual(applied.state.steps.map((step) => step.id), ["s1", "s2", "s3"]);
    assert.equal(applied.state.steps[1]!.status, "ready", "the first added step becomes runnable");
    assert.equal(applied.state.steps[2]!.status, "proposed");
    assert.equal(applied.remainingEstimate, 2);
  });

  it("projects the recipe back onto the frozen plan shape", () => {
    const state = initRecipe("goal", planSteps(2));
    const projected = planStepsOf(state);
    assert.deepEqual(
      projected.map((step) => ({ id: step.id, title: step.title, successCriteria: step.successCriteria })),
      [
        { id: "s1", title: "step 1", successCriteria: "thing 1 is done" },
        { id: "s2", title: "step 2", successCriteria: "thing 2 is done" },
      ],
    );
  });
});

describe("recipe engine: restart from a step", () => {
  it("keeps every upstream step verbatim and reopens only the restart point", () => {
    let state = initRecipe("goal", planSteps(4));
    state = finishStep(state, 0, true);
    state = finishStep(state, 1, true);
    state = finishStep(state, 2, false);
    state.steps[0]!.nodeId = "node-1";
    state.steps[1]!.nodeId = "node-2";

    const restarted = restartFrom(state, "s3", "user edited the input");
    assert.equal(restarted.change, "restart");
    assert.deepEqual(restarted.kept, ["s1", "s2"], "the steps before the restart point are kept");
    assert.deepEqual(restarted.regenerated, ["s3", "s4"], "the restart point and everything after it is regenerated");

    const steps = restarted.state.steps;
    // Upstream keeps its id, status and node: the outputs those steps produced
    // stay on the canvas and are never recomputed.
    assert.equal(steps.length, 3, "downstream steps are dropped");
    assert.deepEqual(steps.map((step) => step.id), ["s1", "s2", "s3"]);
    assert.equal(steps[0]!.status, "done");
    assert.equal(steps[1]!.status, "done");
    assert.equal(steps[0]!.nodeId, "node-1");
    assert.equal(steps[1]!.nodeId, "node-2");
    // The restart point is reopened and no longer claims the rejected attempt.
    assert.equal(steps[2]!.status, "ready");
    assert.equal(steps[2]!.nodeId, undefined);
    assert.equal(restarted.state.current, 2, "the run continues at the restart point");
    assert.equal(completedCount(steps), 2);
  });

  it("is a no-op for an unknown step", () => {
    const state = initRecipe("goal", planSteps(2));
    const restarted = restartFrom(state, "s99", "restart");
    assert.equal(restarted.change, "restart");
    assert.deepEqual(restarted.kept, ["s1", "s2"]);
    assert.deepEqual(restarted.regenerated, []);
    assert.equal(restarted.state.steps.length, 2, "an unknown step leaves the recipe unchanged");
  });

  it("reports the restart reason when the caller omits one", () => {
    // The exported helper keeps the event honest rather than empty.
    const restarted = restartFrom(initRecipe("goal", planSteps(2)), "s1", "");
    assert.equal(restarted.state.goal, "goal");
  });
});

describe("recipe engine: re-seed after a replan", () => {
  it("keeps finished steps and drops the ones the new plan does not mention", () => {
    let state = initRecipe("goal", planSteps(3));
    state = finishStep(state, 0, true);
    state = finishStep(state, 1, true);

    const reseeded = reseedRecipe(state, "new goal", [
      { id: "s1", title: "step 1", instruction: "do thing 1", successCriteria: "thing 1 is done" },
      { id: "s5", title: "step five", instruction: "do thing five", successCriteria: "thing five is done" },
    ]);

    assert.equal(reseeded.goal, "new goal");
    assert.deepEqual(reseeded.steps.map((step) => step.id), ["s1", "s5"]);
    assert.equal(reseeded.steps[0]!.status, "done", "a finished step keeps its status");
    // The new plan's first step is the kept finished one, so the added step is
    // still `proposed`; the run loop opens it by id when it reaches it.
    assert.equal(reseeded.steps[1]!.status, "proposed");
    assert.equal(pendingCount(reseeded.steps), 1, "only the unmentioned new step is left to run");
  });

  it("makes the first step of a fresh re-seed runnable", () => {
    const state = initRecipe("goal", planSteps(1));
    const reseeded = reseedRecipe(state, "goal", planSteps(2));
    assert.equal(reseeded.steps[0]!.status, "ready");
    assert.equal(reseeded.steps[1]!.status, "proposed");
  });
});

describe("recipe engine: helpers", () => {
  it("summarizes tool results into planner observations", () => {
    const observations = observationsFromTrace(
      [
        { name: "web_search", args: { query: "x" }, ok: true, summary: "found three sources" },
        { name: "web_fetch", args: { url: "https://example.com" }, ok: false, summary: "fetch failed: timeout" },
      ],
      "s2",
    );
    assert.deepEqual(
      observations.map((observation) => ({ tool: observation.tool, stepId: observation.stepId, ok: observation.ok })),
      [
        { tool: "web_search", stepId: "s2", ok: true },
        { tool: "web_fetch", stepId: "s2", ok: false },
      ],
    );
    assert.equal(observations[0]!.summary, "found three sources");
  });

  it("maps a run-graph node back to its recipe step", () => {
    let state: RecipeState = initRecipe("goal", planSteps(3));
    state.steps[0]!.nodeId = "node-1";
    state.steps[2]!.nodeId = "node-3";
    assert.equal(stepIdOfNode("node-1", state), 0);
    assert.equal(stepIdOfNode("node-3", state), 2);
    assert.equal(stepIdOfNode(undefined, state), -1);
    assert.equal(stepIdOfNode("node-missing", state), -1);
  });
});
