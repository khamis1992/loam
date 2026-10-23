/**
 * Neo N4: the live recipe must survive history replay.
 *
 * A recipe-mode run reports its recipe with `recipe_update` events and restarts
 * with `recipe_restart`. Those events are persisted as task steps, so reopening
 * the session has to rebuild the same recipe row and restart card; otherwise the
 * panel shows the seed plan instead of the recipe the run actually executed, and
 * a restart the user already performed disappears.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapAgentEvent, createEventMapperState } from "../index.js";
import { buildHistoryFromTask } from "../socket.js";
import type { RecipeStepInfo } from "../../agent/events.js";
import type { Task } from "../../server/db.js";

const RECIPE_STEP: RecipeStepInfo = {
  id: "s1",
  title: "gather",
  instruction: "gather with web_fetch",
  successCriteria: "the source is fetched",
  status: "done",
  completedCount: 1,
};

function recipeUpdateEvent() {
  return {
    type: "recipe_update" as const,
    goal: "finish the request",
    steps: [RECIPE_STEP],
    remainingEstimate: 1,
    change: "advance" as const,
    source: "planner" as const,
  };
}

function recipeRestartEvent() {
  return {
    type: "recipe_restart" as const,
    stepId: "s2",
    nodeId: "node-7",
    keptSteps: ["s1"],
    regeneratedSteps: ["s2", "s3"],
    reason: "user edited the input of step 2",
  };
}

describe("recipe event mapping", () => {
  it("maps recipe_update to a replaceable recipe row", () => {
    const out = mapAgentEvent(recipeUpdateEvent(), createEventMapperState(), "s1");
    assert.equal(out.length, 1);
    const recipe = out[0]!;
    assert.equal(recipe.type, "recipeUpdate");
    assert.equal(recipe.goal, "finish the request");
    assert.deepEqual(recipe.steps[0], RECIPE_STEP);
    assert.equal(recipe.remainingEstimate, 1);
    assert.equal(recipe.change, "advance");
    assert.equal(recipe.source, "planner");
  });

  it("maps recipe_restart to the restart card", () => {
    const out = mapAgentEvent(recipeRestartEvent(), createEventMapperState(), "s1");
    const restart = out[0]!;
    assert.equal(restart.type, "recipeRestart");
    assert.equal(restart.stepId, "s2");
    assert.equal(restart.nodeId, "node-7");
    assert.deepEqual(restart.keptSteps, ["s1"]);
    assert.deepEqual(restart.regeneratedSteps, ["s2", "s3"]);
    assert.match(restart.reason, /user edited the input of step 2/);
  });

  it("rebuilds the recipe row from a persisted task step", () => {
    const task = {
      id: "t1",
      title: "task",
      status: "done",
      createdAt: new Date().toISOString(),
      messages: [],
      steps: [{ at: new Date().toISOString(), type: "recipe_update", data: recipeUpdateEvent() }],
    } as unknown as Task;

    const history = buildHistoryFromTask(task, "s1");
    const recipe = history.find((event) => event.type === "recipeUpdate");
    assert.ok(recipe, "the persisted recipe step must render as a recipe row");
    assert.deepEqual(recipe.steps[0], RECIPE_STEP);
    assert.equal(recipe.remainingEstimate, 1);
  });

  it("rebuilds the restart card from a persisted task step", () => {
    const task = {
      id: "t1",
      title: "task",
      status: "done",
      createdAt: new Date().toISOString(),
      messages: [],
      steps: [{ at: new Date().toISOString(), type: "recipe_restart", data: recipeRestartEvent() }],
    } as unknown as Task;

    const history = buildHistoryFromTask(task, "s1");
    const restart = history.find((event) => event.type === "recipeRestart");
    assert.ok(restart, "the persisted restart step must render as a restart card");
    assert.deepEqual(restart.keptSteps, ["s1"]);
    assert.deepEqual(restart.regeneratedSteps, ["s2", "s3"]);
  });
});
