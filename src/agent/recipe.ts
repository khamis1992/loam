/**
 * Neo N4: the incremental Recipe engine.
 *
 * The orchestrator's upfront `plan` answers "what should I do?" once. A long
 * horizon task needs the answer to keep moving: after every step the planner
 * looks at the results that step produced and decides what comes next
 * (add / rewrite / drop), instead of executing a list that was frozen before the
 * first tool ran.
 *
 * This module owns that state machine and nothing else. It is deliberately free
 * of model and tool dependencies: {@link proposeNextSteps} turns a model reply
 * into a new ordered recipe, {@link remainingEstimate} answers "how much work is
 * left", and {@link restartFrom} produces the state after the user restarts the
 * run from one node. The orchestrator calls them; the planner produces the raw
 * text; the run graph supplies node ids.
 *
 * Two rules keep the recipe honest:
 *   - a step that already ran is never silently reworded. A rewrite names the
 *     steps it replaces, so the UI can show the change and the run keeps the
 *     original evidence;
 *   - a restart keeps upstream outputs verbatim. Steps before the restart point
 *     keep their id, their status and their node; only the downstream is
 *     regenerated, because that is the whole point of restarting from a node.
 */
import type { PlanStepInfo, RecipeChange, RecipeStepInfo, RecipeStepStatus, ToolTraceItem } from "./events.js";

/** Internal state of one recipe-mode run. */
export interface RecipeState {
  goal: string;
  steps: RecipeStepInfo[];
  /** Index of the step currently executing; -1 before the first step starts. */
  current: number;
  /** Steps already finished (never counts the current step). */
  completedCount: number;
  /** Planner rounds spent so far; bounded by the orchestrator's budget. */
  rounds: number;
}

/** One step of a recipe as the planner proposes it. */
export interface RecipeProposal {
  id: string;
  title: string;
  instruction: string;
  successCriteria: string;
}

/** The planner's decision for one proposal round. */
export interface RecipeProposalResult {
  /** Steps to add to the end of the recipe, in order. */
  add: RecipeProposal[];
  /** Steps to rewrite in place, keyed by the id they replace. */
  rewrite: Record<string, RecipeProposal>;
  /** Step ids the planner no longer needs; they become `skipped`. */
  drop: string[];
  /** Estimated number of steps still to run, current step included. */
  remainingEstimate: number;
  /** False when the planner says the recipe is complete; the run may finish. */
  hasMore: boolean;
}

/** Why the recipe changed in a given round, as reported to the client. */
export type RecipeRoundKind = RecipeChange;

/** A raw tool result the planner is allowed to see when proposing the next step. */
export interface RecipeObservation {
  stepId: string;
  ok: boolean;
  summary: string;
  tool: string;
}

/** Context {@link proposeNextSteps} gives the planner for one proposal round. */
export interface RecipeProposeContext {
  goal: string;
  /** Every recipe step so far, in order, with the status it currently has. */
  steps: RecipeStepInfo[];
  /** Index of the step that just finished; -1 when there is no current step. */
  currentIndex: number;
  /** One-line digest of what each finished step produced. */
  completed: string[];
  /** Tool results of the step that just finished; the planner routes on these. */
  observations: RecipeObservation[];
  availableTools: string[];
}

/** Outcome of {@link applyProposal}: the new state plus what to report. */
export interface RecipeApplyResult {
  state: RecipeState;
  change: RecipeChange;
  /** Step ids that were rewritten, so the UI can mark the replacement. */
  replaced: string[];
  /** Step ids the planner dropped, in the order it dropped them. */
  dropped: string[];
  remainingEstimate: number;
}

/**
 * The recipe's plan projection, used to keep `plan` (the frozen plan) in step
 * with the recipe the run is actually executing.
 */
export function planStepsOf(state: RecipeState): PlanStepInfo[] {
  return state.steps.map((step) => ({
    id: step.id,
    title: step.title,
    instruction: step.instruction,
    successCriteria: step.successCriteria,
  }));
}

const STATUS_ORDER: readonly RecipeStepStatus[] = ["proposed", "ready", "doing", "done", "blocked", "skipped"];

/**
 * Steps that still represent work.
 *
 * A step that ran and came back `blocked` is terminal evidence, exactly like a
 * `done` step: the planner re-routes *around* it instead of retrying it, so it is
 * not something the user is still waiting for.
 */
function openSteps(steps: readonly RecipeStepInfo[]): RecipeStepInfo[] {
  return steps.filter((step) => step.status !== "done" && step.status !== "skipped" && step.status !== "blocked");
}

/**
 * How much of the recipe is left.
 *
 * A recipe can grow while the planner is deciding, so a naive "pending steps"
 * count can *increase* even though a step just finished, which would make the
 * estimate the user is watching tick the wrong way. The planner is therefore asked
 * for the remaining count it expects and the engine keeps the smaller of that and
 * the steps still open: the estimate can move up when a round reveals real new
 * work, and can never report more work than the recipe actually holds.
 */
export function remainingEstimate(steps: readonly RecipeStepInfo[], planned = pendingCount(steps)): number {
  return Math.max(0, Math.min(planned, pendingCount(steps)));
}

/** Steps the user still has to wait for. */
export function pendingCount(steps: readonly RecipeStepInfo[]): number {
  return openSteps(steps).length;
}

/** Number of steps the recipe counts as finished. */
export function completedCount(steps: readonly RecipeStepInfo[]): number {
  return steps.filter((step) => step.status === "done").length;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampId(value: unknown, fallback: string): string {
  const text = str(value);
  return text.length > 0 ? text : fallback;
}

/**
 * Normalize a planner reply into a decision.
 *
 * The reply is JSON shaped like
 * `{"add": [...], "rewrite": {"s2": {...}}, "drop": ["s3"], "remaining_estimate": 3, "complete": false}`.
 * Anything unusable is treated as "propose nothing": a bad round must never
 * destroy the recipe, it only means the engine falls back to the recipe it has.
 */
export function parseProposal(value: unknown): RecipeProposalResult {
  const add: RecipeProposal[] = [];
  const rewrite: Record<string, RecipeProposal> = {};
  const drop: string[] = [];
  let remainingEstimate = 0;
  let hasMore = true;

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const item of Array.isArray(obj["add"]) ? (obj["add"] as unknown[]) : []) {
      const proposal = parseProposalStep(item);
      if (proposal) add.push(proposal);
    }
    const rewrites = obj["rewrite"];
    if (rewrites && typeof rewrites === "object" && !Array.isArray(rewrites)) {
      for (const [id, item] of Object.entries(rewrites as Record<string, unknown>)) {
        const proposal = parseProposalStep(item);
        if (proposal) rewrite[clampId(id, "")] = proposal;
      }
    }
    for (const id of Array.isArray(obj["drop"]) ? (obj["drop"] as unknown[]) : []) {
      const text = str(id);
      if (text) drop.push(text);
    }
    const estimate = obj["remaining_estimate"] ?? obj["remainingEstimate"];
    if (typeof estimate === "number" && Number.isFinite(estimate)) {
      remainingEstimate = Math.max(0, Math.round(estimate));
    }
    if (obj["complete"] === true || obj["done"] === true || obj["has_more"] === false) hasMore = false;
  }

  return { add, rewrite, drop, remainingEstimate, hasMore };
}

function parseProposalStep(value: unknown): RecipeProposal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const instruction = str(obj["instruction"]) || str(obj["task"]) || str(obj["description"]);
  if (!instruction) return undefined;
  return {
    id: str(obj["id"]),
    title: str(obj["title"]) || instruction.slice(0, 60),
    instruction,
    successCriteria:
      str(obj["success_criteria"]) || str(obj["successCriteria"]) || str(obj["criteria"]) || str(obj["success"]) ||
      "the step's result is present and consistent with the instruction",
  };
}

/** Create the recipe a fresh recipe-mode run starts from. */
export function initRecipe(goal: string, steps: readonly PlanStepInfo[]): RecipeState {
  const recipe: RecipeStepInfo[] = steps.map((step, index) => ({
    id: step.id || `s${index + 1}`,
    title: step.title,
    instruction: step.instruction,
    successCriteria: step.successCriteria,
    status: index === 0 ? "ready" : "proposed",
    completedCount: 0,
  }));
  return { goal, steps: recipe, current: recipe.length > 0 ? 0 : -1, completedCount: 0, rounds: 0 };
}

/** Mark the step the engine is about to execute. */
export function beginStep(state: RecipeState, index: number): RecipeState {
  const steps = state.steps.map((step, i) => (i === index ? { ...step, status: "doing" as RecipeStepStatus } : step));
  return { ...state, steps, current: index };
}

/**
 * Record a finished step; the next open step becomes `ready`.
 *
 * A finished step is never reopened by this function: `restartFrom` is the only
 * way to run a step again, and it does so deliberately, at the user's request.
 */
export function finishStep(state: RecipeState, index: number, ok: boolean, nodeId?: string): RecipeState {
  const status: RecipeStepStatus = ok ? "done" : "blocked";
  const finished = state.steps.map((step, i) => {
    if (i !== index) return step;
    const next: RecipeStepInfo = { ...step, status, completedCount: state.completedCount };
    if (nodeId) next.nodeId = nodeId;
    return next;
  });
  const count = completedCount(finished);
  const steps = finished.map((step, i) => {
    if (i <= index || step.status === "done" || step.status === "skipped" || step.status === "blocked") return step;
    const next: RecipeStepInfo = { ...step, completedCount: count };
    if (next.status === "proposed") next.status = "ready";
    return next;
  });
  return { ...state, steps, current: index, completedCount: count };
}

/**
 * Apply one planner decision to the recipe.
 *
 * The new recipe keeps every step that already ran; a rewrite carries the ids it
 * replaced so the client can show "s2 became s2 (revised)" instead of silently
 * moving the goalposts. Only the tail of the recipe may grow, so pending steps
 * keep their order and ids and the user can still compare a restart against what
 * ran before.
 */
export function applyProposal(
  state: RecipeState,
  proposal: RecipeProposalResult,
  source: "planner" | "auto" = "planner",
): RecipeApplyResult {
  const replaced: string[] = [];
  const dropped: string[] = [];
  const next = state.steps.map((step) => ({ ...step }));

  const rewriteIds = new Set(Object.keys(proposal.rewrite));
  const rewritten = new Map<number, RecipeProposal>();
  for (let i = 0; i < next.length; i++) {
    const step = next[i]!;
    if (rewriteIds.has(step.id)) rewritten.set(i, proposal.rewrite[step.id]!);
  }
  for (const [index, incoming] of rewritten) {
    const step = next[index]!;
    // A step that already ran is evidence. Rewriting it would move the goalposts
    // without a new result, so only a step that has not run may be reworded.
    if (step.status === "done" || step.status === "skipped" || step.status === "blocked") continue;
    const merged: RecipeStepInfo = {
      ...step,
      id: incoming.id || step.id,
      title: incoming.title || step.title,
      instruction: incoming.instruction || step.instruction,
      successCriteria: incoming.successCriteria || step.successCriteria,
      replaces: [...(step.replaces ?? []), step.id],
    };
    next[index] = merged;
    replaced.push(step.id);
  }

  const dropIds = new Set(proposal.drop);
  for (const step of next) {
    if (dropIds.has(step.id) && step.status !== "done" && step.status !== "skipped" && step.status !== "blocked") {
      step.status = "skipped";
      dropped.push(step.id);
    }
  }

  const count = completedCount(next);
  // Only the tail of the recipe may grow, so the pending steps keep their order
  // and ids and the user can still compare a restart against what ran before.
  for (const incoming of proposal.add) {
    const id = incoming.id || `s${next.length + 1}`;
    const last = next[next.length - 1];
    next.push({
      id,
      title: incoming.title,
      instruction: incoming.instruction,
      successCriteria: incoming.successCriteria,
      status: last && (last.status === "done" || last.status === "blocked") ? "ready" : "proposed",
      completedCount: count,
    });
  }

  const steps = next.map((step) => ({ ...step, completedCount: step.status === "done" ? count : step.completedCount }));
  const nextState: RecipeState = { ...state, steps, completedCount: count, rounds: state.rounds + 1 };
  const change: RecipeChange =
    replaced.length > 0 ? "rewrite" : dropped.length > 0 ? "drop" : proposal.add.length > 0 ? "propose" : "advance";
  void source;
  return {
    state: nextState,
    change,
    replaced,
    dropped,
    remainingEstimate: remainingEstimate(steps, proposal.remainingEstimate),
  };
}

/** Build the prompt payload the planner receives for one proposal round. */
export function proposePrompt(context: RecipeProposeContext): string {
  const lines: string[] = [];
  lines.push("RECIPE MODE: the recipe below is not final. It grows step by step.");
  lines.push("");
  lines.push(`RECIPE GOAL: ${context.goal}`);
  lines.push("");
  lines.push("CURRENT RECIPE (steps that already ran are fixed; do not reword them):");
  for (const step of context.steps) {
    lines.push(`- [${step.id}] (${step.status}) ${step.title}`);
    if (step.instruction) lines.push(`    ${step.instruction}`);
  }
  lines.push("");
  lines.push("RESULTS OF THE STEP THAT JUST FINISHED:");
  for (const digest of context.completed) lines.push(`- ${digest}`);
  lines.push("TOOL RESULTS (route on these):");
  if (context.observations.length === 0) lines.push("(none)");
  for (const observation of context.observations) {
    lines.push(`- ${observation.tool} (${observation.stepId}) ${observation.ok ? "ok" : "FAILED"}: ${observation.summary.slice(0, 400)}`);
  }
  lines.push("");
  lines.push("AVAILABLE TOOLS:");
  lines.push(context.availableTools.length > 0 ? context.availableTools.join(", ") : "(none)");
  lines.push("");
  lines.push("Decide what the recipe needs NEXT, from the results above. Reply with JSON only, no markdown fences:");
  lines.push('- {"add": [{"id": "s4", "title": "<short>", "instruction": "<what the executor must do>", "success_criteria": "<observable evidence>"}], "rewrite": {"<step id>": {<step>}}, "drop": ["<step id>"], "remaining_estimate": <int>, "complete": <true|false>}');
  lines.push('- Use "add" for genuinely new work. Use "rewrite" only for a step that has NOT run yet and only when the results change what it must do. Use "drop" for a step the results made unnecessary. Set "complete": true only when the user request is fully satisfied by the steps that already ran.');
  lines.push("- Write titles, instructions and success criteria in the user's language. Instructions must be concrete: files, commands, sources. No meta-work.");
  return lines.join("\n");
}

/** Turn the raw trace of one step into the observations the planner routes on. */
export function observationsFromTrace(trace: readonly ToolTraceItem[], stepId: string): RecipeObservation[] {
  return trace.map((item) => ({
    stepId,
    tool: item.name,
    ok: item.ok,
    summary: item.summary.slice(0, 800),
  }));
}

/** A step's success criteria, the one contract the verifier holds the step to. */
export function stepContract(step: RecipeStepInfo): { title: string; instruction: string; successCriteria: string } {
  return { title: step.title, instruction: step.instruction, successCriteria: step.successCriteria };
}

/** The recipe step a run-graph node belongs to, if the node carries one. */
export function stepIdOfNode(nodeId: string | undefined, state: RecipeState): number {
  if (!nodeId) return -1;
  return state.steps.findIndex((step) => step.nodeId === nodeId);
}

/**
 * Restart the recipe from one step.
 *
 * Everything before `stepId` is kept verbatim: same id, same status, same node,
 * so the outputs those steps produced stay on the canvas and are never
 * recomputed. From `stepId` onwards the recipe is regenerated: the step itself is
 * reopened and every step after it is dropped, because a downstream step that was
 * planned from a different input is no longer valid.
 */
export function restartFrom(
  state: RecipeState,
  stepId: string,
  reason: string,
): { state: RecipeState; change: RecipeChange; kept: string[]; regenerated: string[] } {
  const index = state.steps.findIndex((step) => step.id === stepId);
  if (index < 0) {
    // Unknown step: restarting from it is a no-op, not a silent re-plan of the
    // whole recipe. Report the recipe unchanged so the caller can say why.
    return { state, change: "restart", kept: state.steps.map((step) => step.id), regenerated: [] };
  }
  const kept = state.steps.slice(0, index).map((step) => step.id);
  const regenerated = state.steps.slice(index).map((step) => step.id);
  const steps: RecipeStepInfo[] = state.steps.slice(0, index).map((step) => ({ ...step }));
  const target = state.steps[index]!;
  steps.push({
    ...target,
    status: "ready",
    // A restart reopens the step: it has no fresh result yet, so it must not
    // still claim the node of the attempt the user rejected.
    nodeId: undefined,
  });
  const count = completedCount(steps);
  return {
    state: { goal: state.goal, steps, current: index, completedCount: count, rounds: state.rounds },
    change: "restart",
    kept,
    regenerated,
  };
}

/** The recipe as it should be reported after a restart. */
export function restartEventReason(reason: string): string {
  return reason.trim() || "restarted from a recipe step";
}

/**
 * Re-seed the recipe after a full replan.
 *
 * A replan exists because a step failed, so the plan is replaced. The steps that
 * already ran are evidence and keep their status; the new plan's steps are taken
 * as they are, and any old step the new plan does not mention is dropped, because
 * it was planned from the failure the replan is specifically avoiding.
 */
export function reseedRecipe(state: RecipeState, goal: string, steps: readonly PlanStepInfo[]): RecipeState {
  const known = new Map(state.steps.map((step) => [step.id, step]));
  const next: RecipeStepInfo[] = steps.map((step, index) => {
    const previous = known.get(step.id);
    if (previous && (previous.status === "done" || previous.status === "skipped")) return { ...previous };
    return {
      id: step.id || `s${index + 1}`,
      title: step.title,
      instruction: step.instruction,
      successCriteria: step.successCriteria,
      status: index === 0 ? "ready" : "proposed",
      completedCount: state.completedCount,
    };
  });
  return { ...state, goal, steps: next, current: -1, completedCount: completedCount(next) };
}

/** Order helper used by the UI to render a stable recipe list. */
export function statusRank(status: RecipeStepStatus): number {
  const rank = STATUS_ORDER.indexOf(status);
  return rank < 0 ? STATUS_ORDER.length : rank;
}
