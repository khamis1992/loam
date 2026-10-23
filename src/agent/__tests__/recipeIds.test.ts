import test from "node:test";
import assert from "node:assert/strict";
import { applyProposal, initRecipe, restartFrom, withUniqueIdsForTest } from "../recipe.js";
import type { PlanStepInfo, RecipeStepInfo, RecipeStepStatus } from "../events.js";

function plan(id: string): PlanStepInfo {
  return { id, title: id, instruction: id, successCriteria: id };
}

function step(id: string, status: RecipeStepStatus = "proposed"): RecipeStepInfo {
  return { id, title: id, instruction: id, successCriteria: id, status, completedCount: 0 };
}

/**
 * A recipe step id is the recipe's identity. It keys the run-graph canvas node,
 * the frozen `plan` projection and the restart target, and the orchestrator
 * resolves a step by `id`, so two steps sharing an id collapse into one canvas
 * node and the second step's work is silently dropped while the run still
 * reports success. Uniqueness is therefore enforced on every recipe mutation,
 * not trusted from the planner.
 */
test("initRecipe renumbers a duplicate planner step id instead of collapsing it", () => {
  const state = initRecipe("goal", [plan("s1"), plan("s1")]);
  assert.deepEqual(state.steps.map((s) => s.id), ["s1", "s1-2"]);
});

test("initRecipe renumbers an id-less step that collides with an earlier step id", () => {
  // No id means "positional": the second step falls back to s2, which the first
  // step already took, so it has to be renumbered rather than collide.
  const state = initRecipe("goal", [plan("s2"), plan("")]);
  assert.deepEqual(state.steps.map((s) => s.id), ["s2", "s2-2"]);
});

test("applyProposal renumbers a proposal whose added step reuses a live id", () => {
  const state = initRecipe("goal", [plan("s1"), plan("s2")]);
  const applied = applyProposal(state, {
    add: [{ id: "s1", title: "again", instruction: "again", successCriteria: "again" }],
    rewrite: {},
    drop: [],
    remainingEstimate: 3,
    hasMore: true,
  });
  assert.deepEqual(applied.state.steps.map((s) => s.id), ["s1", "s2", "s1-2"]);
});

test("applyProposal renumbers a rewrite whose incoming id collides with a live step", () => {
  const state = initRecipe("goal", [plan("s1"), plan("s2"), plan("s3")]);
  const applied = applyProposal(state, {
    add: [],
    rewrite: { s3: { id: "s1", title: "s3", instruction: "s3", successCriteria: "s3" } },
    drop: [],
    remainingEstimate: 3,
    hasMore: true,
  });
  assert.deepEqual(applied.state.steps.map((s) => s.id), ["s1", "s2", "s1-2"]);
  assert.deepEqual(applied.replaced, ["s3"]);
  // The collision came from a *rewritten* step, so the collision record points at
  // the step that kept its id, which is what the UI highlights.
  assert.deepEqual(applied.state.steps[2]?.replaces, ["s3"]);
});

/**
 * The recipe a restart starts from: the steps above `target` have run, and the
 * target itself has a result the user is about to reject.
 */
function restartedAt(planIds: readonly string[], target: string) {
  const state = initRecipe("goal", planIds.map(plan));
  const index = state.steps.findIndex((step) => step.id === target);
  for (let i = 0; i <= index; i++) {
    state.steps[i] = { ...state.steps[i]!, status: "done", completedCount: i + 1 };
  }
  return state;
}

test("restartFrom reopens the target and drops the steps after it", () => {
  // Restart keeps the target only: a downstream step was planned from an input
  // the restart discards, so it is not kept even though it is reported as
  // regenerated for the client to redraw.
  const result = restartFrom(restartedAt(["s1", "s2", "s3"], "s1"), "s1", "redo");
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.regenerated, ["s1", "s2", "s3"]);
  assert.deepEqual(result.state.steps.map((s) => s.id), ["s1"]);
  assert.equal(result.state.steps[0]?.status, "ready");
  // The restart reopened the step: it must not still claim the rejected node.
  assert.equal(result.state.steps[0]?.nodeId, undefined);
});

test("restartFrom keeps the steps above the restart point verbatim", () => {
  const result = restartFrom(restartedAt(["s1", "s2", "s3"], "s2"), "s2", "redo");
  assert.deepEqual(result.kept, ["s1"]);
  assert.deepEqual(result.regenerated, ["s2", "s3"]);
  // The kept step keeps its id, status and node, so its output stays on canvas.
  assert.equal(result.state.steps[0]?.status, "done");
  assert.equal(result.state.steps[1]?.status, "ready");
});

test("restartFrom on an unknown step is a no-op", () => {
  const state = restartedAt(["s1", "s2"], "s1");
  const result = restartFrom(state, "s9", "redo");
  assert.deepEqual(result.state.steps, state.steps);
  assert.deepEqual(result.regenerated, []);
});

test("withUniqueIds preserves order, count and every field other than the id", () => {
  const steps = [step("s1", "done"), step("s1", "proposed"), step("s1", "proposed")];
  steps[1]!.completedCount = 3;
  const unique = withUniqueIdsForTest(steps);
  assert.deepEqual(unique.map((s) => s.id), ["s1", "s1-2", "s1-3"]);
  assert.deepEqual(unique.map((s) => s.status), ["done", "proposed", "proposed"]);
  assert.equal(unique[1]?.completedCount, 3);
});
