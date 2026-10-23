import type { ChatMessage } from "../ollama.js";
import type { Config } from "../config.js";
import type { Emit, PlanStepInfo, RecipeChange, RecipeStepInfo, ToolTraceItem, Usage, VerdictInfo } from "./events.js";
import { log } from "../log.js";
import { runAgent, type RunOptions, type RunResult } from "./loop.js";
import { extractJson, planTask, proposeNextSteps, type Plan, type PlanResult } from "./planner.js";
import { critiqueStep, verifyFinal, formatExecutorMessage, type VerdictOutcome } from "./verifier.js";
import { CancelledError, isCancelled, isCancelledError, throwIfCancelled } from "../server/runControl.js";
import type { ExecutionCheckpoint, WorkerCheckpoint } from "./checkpoint.js";
import { AcceptanceGuard } from "./acceptanceGuard.js";
import { IndependentAcceptanceGuard, independentRequirements } from "./independentAcceptance.js";
import { taskScopedTools, fileOnlyRequested } from "./taskToolScope.js";
import { missionSection, fillMasterSlots, deriveMasterSlots } from "./masterPrompt.js";
import { checkBudget, consumeTokens, type ComputeBudget } from "./computeBudget.js";
import { addUsage, sumUsage } from "./usageAccounting.js";
import { openSession, closeSession, cancelled, type SessionEndReason } from "./sessionHooks.js";
import { runLifecycleHooks } from "../policy/hooks.js";
import { needsAskUser } from "../tools/askUserGate.js";
import { createAskUser, getAskUser, waitForAskUser } from "../tools/askUserStore.js";
import {
  applyProposal,
  beginStep,
  finishStep,
  initRecipe,
  observationsFromTrace,
  parseProposal,
  pendingCount,
  planStepsOf,
  remainingEstimate,
  reseedRecipe,
  restartFrom,
  restartEventReason,
  restoreTail,
  stepContract,
  type RecipeState,
} from "./recipe.js";

export interface VerdictRecord extends VerdictInfo {
  scope: string;
}

export interface OrchestratorOptions extends RunOptions {
  /** Collector: every verifier verdict (per step and final) is appended here. */
  verdicts?: VerdictRecord[];
  resume?: ExecutionCheckpoint;
  saveCheckpoint?: (checkpoint: ExecutionCheckpoint) => void;
  /** Session lifecycle hooks run only for a top-level orchestrated task;
   *  nested runs (workers, subagent children) omit this so they stay silent. */
  lifecycleHooks?: boolean;
  /**
   * Neo N4: incremental Recipe mode. The upfront plan is only the seed; after
   * every step the planner proposes what comes next from that step's results,
   * so the recipe grows, shrinks and re-routes instead of executing a frozen
   * list. The remaining-work estimate and the restart seam are part of it.
   */
  recipeMode?: boolean;
  /** Run-graph node id the user asked to restart from. Applies once, at the
   *  first opportunity, and never re-runs the steps before it. */
  recipeRestart?: { stepId: string; nodeId?: string; reason: string };
  /** Recipe state restored from a checkpoint, so a resume continues the same
   *  recipe instead of restarting from the seed plan. */
  recipeState?: RecipeState;
  /** Persist the recipe with every checkpoint so a resume keeps its shape. */
  saveRecipe?: (state: RecipeState) => void;
}

/** How many times a blocked Stop hook may force the orchestrated run to
 *  continue before the run ends instead of looping forever. */
const STOP_CONTINUATION_ROUNDS = 2;

const WORKER_SUFFIX = [
  "You are the executor (worker) sub-agent of an orchestrated task.",
  "Execute ONLY the current plan step below; later steps run separately as their own sub-agents.",
  "Leave concrete evidence (file paths, command output, URLs) because a verifier checks your work against the success criteria.",
  "If the current step is the last one, end with the complete, user-facing answer.",
].join("\n");

/** §25 (long-horizon missions) sent only to recipe-mode workers.
 *
 *  A plain plan run has no Recipe, so it must not pay for the mission rules;
 *  the orchestrator is the only place that knows the run is a mission. The
 *  section carries runtime `{{slots}}`, so they are filled here with the same
 *  derivation the assembled master prompt uses; a raw placeholder must never
 *  reach the model. */
function missionSuffix(cfg: Config): string {
  return fillMasterSlots(missionSection(), deriveMasterSlots(cfg));
}

function oneLine(text: string, max = 300): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

interface WorkerOutcome {
  text: string;
  messages: ChatMessage[];
  model: string;
  steps: number;
  usage: Usage;
  trace: ToolTraceItem[];
  error?: string;
  /** Set when the worker stopped on the session compute budget ceiling. */
  budgetStopped?: boolean;
}

async function runWorker(o: OrchestratorOptions, prompt: string, systemSuffix: string, maxSteps: number): Promise<WorkerOutcome> {
  const trace: ToolTraceItem[] = [];
  const preferredModel = o.model && o.model.trim() ? o.model.trim() : o.cfg.model;
  let progress = o.resumeWorker
    ? { steps: o.resumeWorker.steps, model: o.resumeWorker.model, usage: { ...o.resumeWorker.usage } }
    : { steps: 0, model: preferredModel, usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 } };
  const emit: Emit = (event) => {
    o.emit(event);
  };
  const inherited = o.systemSuffix && o.systemSuffix.trim().length > 0 ? `${o.systemSuffix.trim()}\n\n` : "";
  try {
    // Each worker is its own agent session: a file one worker writes must be
    // reported to a later worker that read it (jcode J8 file-touch).
    const res = await runAgent({
      cfg: o.cfg,
      ollama: o.ollama,
      tools: o.tools,
      emit,
      prompt,
      sessionId: `orch-${o.taskId ?? "task"}-w${++workerSeq}`,
      ...(o.history ? { history: o.history } : {}),
      ...(o.memories ? { memories: o.memories } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    ...(o.taskId ? { taskId: o.taskId } : {}),
      systemSuffix: `${inherited}${systemSuffix}`,
      maxSteps,
      ...(o.model && o.model.trim() ? { model: o.model.trim() } : {}),
      suppressFinal: true,
      onToolEvidence: (item) => trace.push(item),
      onProgress: (value) => { progress = value; },
      // A worker can itself be a coding turn (a repair instruction names files
      // and tools), so the routing seams must reach the child run or that call
      // escapes the injected client and the outer cooldown store.
      ...(o.createProviderClient ? { createProviderClient: o.createProviderClient } : {}),
      ...(o.cooldownStore ? { cooldownStore: o.cooldownStore } : {}),
      ...(o.env ? { env: o.env } : {}),
      ...(o.onCodingRoute ? { onCodingRoute: o.onCodingRoute } : {}),
      ...(o.resumeWorker ? { resumeWorker: o.resumeWorker } : {}),
      ...(o.saveWorker ? { saveWorker: o.saveWorker } : {}),
      // O5: workers append their own tool-call lifecycle rows to the same durable
      // log, so a crash inside a worker is visible to the resume gate too.
      ...(o.eventLogSession ? { eventLogSession: o.eventLogSession } : {}),
      // D19 compute budget: workers inherit the session budget so the ceiling
      // is enforced on the default (orchestrated) path, not only the linear one.
      ...(o.budget ? { budget: o.budget } : {}),
    });
    return { text: res.text, messages: res.messages, model: res.model, steps: res.steps, usage: res.usage, trace };
  } catch (err) {
    // Cancellation is not a step failure — propagate it so the whole run stops now.
    if (o.signal?.aborted || isCancelled(o.taskId) || isCancelledError(err)) {
      throw err instanceof Error ? err : new CancelledError();
    }
    // D19: a budget stop is a distinct outcome: the session must stay idle and
    // raisable, so the orchestrator reports it instead of retrying the step.
    const message = err instanceof Error ? err.message : String(err);
    if (o.budget && checkBudget(o.budget).action === "stop") {
      return { text: "", messages: [], model: progress.model, steps: progress.steps, usage: progress.usage, trace, error: message, budgetStopped: true };
    }
    return {
      text: "",
      messages: [],
      model: progress.model,
      steps: progress.steps,
      usage: progress.usage,
      trace,
      error: message,
    };
  }
}

/** Distinguishes executor workers of one orchestrated run for file-touch tracking. */
let workerSeq = 0;

function stepPrompt(o: OrchestratorOptions, plan: Plan, step: PlanStepInfo, index: number, completed: string[], critique: VerdictInfo | null): string {
  const lines: string[] = [];
  lines.push("=== Orchestrated task ===");
  lines.push("ORIGINAL USER REQUEST:");
  lines.push(o.prompt);
  lines.push("");
  lines.push(`PLAN GOAL: ${plan.goal}`);
  lines.push("");
  lines.push("COMPLETED STEPS:");
  lines.push(completed.length > 0 ? completed.map((c) => `- ${c}`).join("\n") : "(none yet)");
  lines.push("");
  lines.push(`CURRENT STEP ${index + 1}/${plan.steps.length}: ${step.title}`);
  lines.push("INSTRUCTION:");
  lines.push(step.instruction);
  lines.push("SUCCESS CRITERIA:");
  lines.push(step.successCriteria);
  if (critique) {
    lines.push("");
    lines.push("VERIFIER CRITIQUE OF YOUR PREVIOUS ATTEMPT:");
    lines.push(critique.reason);
    if (critique.fixes.length > 0) {
      lines.push("REQUIRED FIXES:");
      for (const f of critique.fixes) lines.push(`- ${f}`);
    }
    lines.push("Address every fix; do not repeat the previous mistakes.");
  }
  return lines.join("\n");
}

function replanPrompt(o: OrchestratorOptions, completed: string[], failure: string): string {
  return [
    "ORIGINAL USER REQUEST:",
    o.prompt,
    "",
    "ALREADY COMPLETED (do not redo):",
    completed.length > 0 ? completed.map((c) => `- ${c}`).join("\n") : "(nothing yet)",
    "",
    `THE PREVIOUS PLAN FAILED AT: ${failure}`,
    "Produce a NEW plan that reuses the completed work and finishes the remaining task. The last step must produce the complete final answer.",
  ].join("\n");
}

function finalFixPrompt(o: OrchestratorOptions, goal: string, finalText: string, v: VerdictInfo): string {
  return [
    "The task was attempted but final verification did not pass. It is not complete.",
    "",
    "ORIGINAL USER REQUEST:",
    o.prompt,
    "",
    `PLAN GOAL: ${goal}`,
    "",
    "CURRENT FINAL ANSWER:",
    formatExecutorMessage(finalText),
    "",
    "VERIFIER VERDICT:",
    v.reason,
    ...(v.fixes.length > 0 ? ["REQUIRED FIXES:", ...v.fixes.map((f) => `- ${f}`)] : []),
    "",
    "Fix the final answer now. If evidence is missing, use tools to obtain it. Deliver the complete corrected final answer.",
  ].join("\n");
}

function stopContinuePrompt(o: OrchestratorOptions, reason: string, context: string): string {
  return [
    "The run was about to finish, but a Stop hook blocked completion.",
    ...(context.trim().length > 0 ? [context.trim()] : []),
    `REASON: ${reason}`,
    "",
    "ORIGINAL USER REQUEST:",
    o.prompt,
    "",
    "Continue working toward the original request. Do not claim completion yet.",
  ].join("\n");
}

/** Planner -> executor workers -> verifier with the reflection loop
 *  (plan -> act -> observe -> critique -> revise), replacing the linear agent loop.
 *  Same signature as runAgent so it can be injected anywhere RunOptions is accepted. */
async function runOrchestratedAgentImpl(o: OrchestratorOptions): Promise<RunResult> {
  const fileOnlyTools = o.resume?.fileOnlyTools === true || fileOnlyRequested(o.prompt, o.history);
  o = { ...o, tools: taskScopedTools(o.tools, o.prompt, o.history, fileOnlyTools) };
  const oc = o.cfg.orchestrator;
  const restored = o.resume;
  const acceptanceGuard = new AcceptanceGuard(restored?.acceptanceContract, o.prompt);
  const independentRequest = restored?.independentRequirements ?? independentRequirements(o.prompt, o.history);
  const independentGuard = new IndependentAcceptanceGuard(independentRequest, restored?.independentAcceptance);
  const usage: Usage = { ...(restored?.usage ?? { promptTokens: 0, completionTokens: 0, durationMs: 0 }) };
  let totalSteps = restored?.totalSteps ?? 0;
  let usedModel = restored?.model ?? o.cfg.model;
  let lastMessages: ChatMessage[] = [];
  /** Stops the orchestrated run the moment the user presses cancel. */
  const guard = (): void => throwIfCancelled(o.signal, o.taskId);

  // Neo N9 auto-trigger: a vague request or missing context raises an ask-user
  // node BEFORE the planner runs, so the run never guesses around an answer the
  // user has to give. The user's answer is appended to the prompt the planner
  // and workers see. Manual `ask_user` calls inside the loop still work through
  // the same pending store.
  let clarifiedPrompt = o.prompt;
  if (!restored && o.taskId) {
    const trigger = needsAskUser(o.prompt, o.history);
    if (trigger) {
      guard();
      // The stored title/reason are the English fallback; the client localizes
      // the auto-trigger chrome from `reasonCode` so an Arabic user never sees
      // English and an English user never sees Arabic.
      const request = createAskUser({
        taskId: o.taskId,
        title: "Before I start, I need one clarification",
        reason: trigger.explanation,
        questions: trigger.questions,
        source: "auto",
        reasonCode: trigger.reason,
      });
      o.emit({ type: "ask_user_required", askUserId: request.id, taskId: o.taskId, tool: "ask_user", title: request.title, reason: request.reason, questions: request.questions, source: "auto", reasonCode: trigger.reason });
      const status = await waitForAskUser(request.id, o.signal);
      guard();
      const answered = getAskUser(request.id)?.answer;
      if (status === "answered" && answered) {
        const parts = [`The clarification was answered: ${request.title}`];
        if (answered.text.trim()) parts.push(answered.text.trim());
        for (const q of request.questions) {
          const a = answered.answers[q.id]?.trim();
          if (a) parts.push(`- ${q.prompt} → ${a}`);
        }
        for (const f of answered.files) parts.push(`- Attached file: ${f.name} (${f.path})`);
        clarifiedPrompt = `${o.prompt}\n\n[USER ANSWER TO THE CLARIFICATION]\n${parts.join("\n")}`;
        log.info(`ask_user auto-trigger answered (${request.id}); continuing with the clarified prompt`);
      } else {
        // Dismissed or expired: keep going, but tell the agent the user did not
        // answer so it states its assumptions instead of inventing them.
        clarifiedPrompt = `${o.prompt}\n\n[THE CLARIFICATION WAS NOT ANSWERED — proceed with what you have and state your assumptions explicitly]`;
        log.info(`ask_user auto-trigger ${status} (${request.id}); continuing without an answer`);
      }
    }
  }

  const planned: PlanResult = restored ? { plan: restored.plan, model: restored.model, usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 } } : await planTask({
    cfg: o.cfg,
    ollama: o.ollama,
    prompt: clarifiedPrompt,
    history: o.history,
    maxPlanSteps: oc.maxPlanSteps,
    availableTools: o.tools.names(),
    ...(oc.plannerModel ? { model: oc.plannerModel } : {}),
    ...(o.memories ? { memories: o.memories } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.taskId ? { taskId: o.taskId } : {}),
  });
  guard();
  let plan = planned.plan;
  usedModel = planned.model || usedModel;
  addUsage(usage, planned.usage);
  // D19 compute budget: the planner call is real work, so it counts against the
  // session ceiling just like a worker step.
  if (o.budget) consumeTokens(o.budget, planned.usage.promptTokens, planned.usage.completionTokens);
  if (!restored) totalSteps += 1;
  const completed = [...(restored?.completed ?? [])];
  const allTrace = [...(restored?.trace ?? [])];
  let lastText = restored?.lastText ?? "";
  let round = restored?.round ?? 1;
  let nextStep = restored?.nextStep ?? 0;
  let finalRepairUsed = restored?.finalRepairUsed ?? false;
  let finalRepairAttempts = restored?.finalRepairAttempts ?? (finalRepairUsed ? 1 : 0);
  if (!Number.isInteger(finalRepairAttempts) || finalRepairAttempts < 0 || finalRepairAttempts > 2) throw new Error("Invalid final repair attempt checkpoint");
  let pendingFinalRepair = restored?.finalRepairPrompt;
  let worker: WorkerCheckpoint | undefined = restored?.worker;
  const checkpoint = (inFlight: boolean, complete = false, pendingUsage?: Usage): void => {
    o.saveCheckpoint?.(structuredClone({ version: 1, plan, nextStep, completed, lastText,
      trace: allTrace, round, usage: pendingUsage ? sumUsage(usage, pendingUsage) : usage, totalSteps, model: usedModel, inFlight, complete, finalRepairUsed, finalRepairAttempts, finalRepairPrompt: pendingFinalRepair, acceptanceContract: acceptanceGuard.snapshot(), independentAcceptance: independentGuard.snapshot(), independentRequirements: independentRequest, fileOnlyTools, worker }));
  };
  checkpoint(restored?.inFlight ?? false);

  const emitPlan = (): void => {
    o.emit({ type: "plan", goal: plan.goal, trivial: plan.trivial, steps: plan.steps, source: plan.source });
  };

  // ---------------------------------------------------------------------
  // Neo N4 incremental Recipe engine.
  //
  // In recipe mode the plan above is only the SEED. After every step the planner
  // is asked what the recipe needs next, from that step's tool results, so the
  // recipe can grow (add), change (rewrite) or shrink (drop) while the run is
  // still going. The plan is kept as the projection of the recipe so the frozen
  // "plan" event and the live recipe never describe two different tasks.
  // ---------------------------------------------------------------------
  let recipeMode = o.recipeMode === true;
  let recipe: RecipeState = o.recipeState ?? initRecipe(plan.goal, plan.steps);
  // The plan is the recipe's projection from the very first event: the recipe
  // de-duplicates the planner's ids, and the run graph, the frozen plan and the
  // restart target all resolve a step by `id`, so the seed plan has to carry the
  // same ids the recipe does. A plan whose two steps shared one id would
  // otherwise put both steps on one canvas node while the recipe tracked them
  // apart, and a restart from the second step would target the first.
  if (recipeMode) plan = { ...plan, steps: planStepsOf(recipe) };
  let restartRequest = o.recipeRestart;
  let restartApplied = false;

  const emitRecipe = (change: RecipeChange, source: "planner" | "restart" | "auto"): void => {
    o.emit({
      type: "recipe_update",
      goal: recipe.goal,
      steps: recipe.steps.map((step) => ({ ...step })),
      remainingEstimate: remainingEstimate(recipe.steps),
      change,
      source,
    });
  };

  emitPlan();
  log.info(`orchestrator: plan (${plan.source}, trivial=${plan.trivial}) steps=${plan.steps.length}`);
  if (recipeMode) {
    // The seed plan is the first recipe snapshot: the client renders it before
    // the first step even starts.
    emitRecipe("init", "auto");
    o.saveRecipe?.(structuredClone(recipe));
    log.info(`orchestrator: recipe mode on; seed steps=${recipe.steps.length}`);
  }

  /**
   * Propose the next recipe step(s) from the results of the step that just ran.
   *
   * A round is real work, so it is charged to the session budget like any other
   * model call. An unparseable or failed round is not fatal: the recipe is kept
   * as it is and the run continues with the next open step.
   */
  const proposeNext = async (stepIndex: number, digest: string, evidence: ToolTraceItem[]): Promise<void> => {
    guard();
    if (o.budget && checkBudget(o.budget).action === "stop") return;
    // The step that just ran is the observation source, not a precondition: a
    // round is also asked for when a step failed, because a failure is exactly
    // the result that decides what comes next.
    const step = stepIndex >= 0 ? recipe.steps[stepIndex] : undefined;
    const stepId = step?.id ?? "";
    const next = await proposeNextSteps({
      cfg: o.cfg,
      ollama: o.ollama,
      context: {
        goal: recipe.goal,
        steps: recipe.steps.map((item) => ({ ...item })),
        currentIndex: stepIndex,
        completed: [digest],
        observations: observationsFromTrace(evidence, stepId),
        availableTools: o.tools.names(),
      },
      ...(oc.plannerModel ? { model: oc.plannerModel } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.taskId ? { taskId: o.taskId } : {}),
    });
    addUsage(usage, next.usage);
    if (o.budget) consumeTokens(o.budget, next.usage.promptTokens, next.usage.completionTokens);
    totalSteps += 1;
    // A model that could not be understood is not evidence: the recipe is kept
    // exactly as it is and the run continues with the next open step.
    if (next.unparsed) {
      emitRecipe("advance", "auto");
      return;
    }

    const applied = applyProposal(recipe, parseProposal(extractJson(next.content)));
    recipe = applied.state;
    // The frozen plan is the recipe's projection, so a client that renders the
    // original plan sees the same steps the run is actually executing.
    plan = { ...plan, steps: planStepsOf(recipe) };
    emitRecipe(applied.change, "planner");
    o.saveRecipe?.(structuredClone(recipe));
    checkpoint(false);
    log.info(
      `orchestrator: recipe round (change=${applied.change}, +${applied.replaced.length} rewritten, ${applied.dropped.length} dropped) steps=${recipe.steps.length} remaining=${applied.remainingEstimate}`,
    );
    // The planner's `complete` verdict is deliberately not a control signal: a
    // recipe is finished when it has no open step left, which the loop derives
    // from the recipe itself. Honouring `complete: true` while steps are still
    // pending would let a planner skip work it had just proposed.
  };

  /**
   * Restart the recipe from one step, if the user asked for one.
   *
   * Everything before the restart point is kept verbatim, so the steps that
   * already ran are never re-run: the run simply continues at the step the user
   * picked. Applied at most once per run.
   */
  const maybeRestart = async (): Promise<void> => {
    if (!recipeMode || restartApplied || !restartRequest) return;
    restartApplied = true;
    const request = restartRequest;
    restartRequest = undefined;
    const stepId = request.stepId;
    const target = recipe.steps.find((step) => step.id === stepId);
    if (!target) {
      log.warn(`orchestrator: recipe restart ignored, unknown step ${stepId}`);
      return;
    }
    // The steps the restart is about to discard, kept so they can be restored if
    // the regeneration round cannot produce their replacement.
    const restartIndex = recipe.steps.findIndex((step) => step.id === stepId);
    const discarded = recipe.steps.slice(restartIndex + 1).map((step) => ({ ...step }));
    const result = restartFrom(recipe, stepId, request.reason);
    recipe = result.state;
    plan = { ...plan, steps: planStepsOf(recipe), goal: recipe.goal };
    nextStep = recipe.steps.findIndex((step) => step.id === stepId);
    // A restart discards the tail, so a step the user asked to keep can end up
    // with nothing after it. Report the restart before fixing that up, so the
    // client sees the discard it asked for and then the regeneration.
    o.emit({
      type: "recipe_restart",
      stepId,
      nodeId: target.nodeId ?? request.nodeId ?? stepId,
      keptSteps: result.kept,
      regeneratedSteps: result.regenerated,
      reason: restartEventReason(request.reason),
    });
    // A restart is a request for a fresh result, and a restart that discarded
    // downstream steps leaves nothing after the restart point for the planner to
    // propose from. Ask it directly what the recipe needs next instead, so the
    // discarded steps are regenerated rather than silently lost. A restart that
    // discarded nothing (the restart point was already the last step) is left
    // alone: the recipe already says what comes next.
    if (result.regenerated.length > 1) {
      await proposeNext(recipe.steps.findIndex((step) => step.id === stepId), `${target.title}: ${restartEventReason(request.reason)}`, []);
      // The regeneration round is best-effort: an unparsed reply or an exhausted
      // compute budget leaves the recipe holding nothing but the reopened step,
      // even though the restart event just reported the discarded tail as
      // regenerated. Put that tail back as pending work rather than finishing a
      // recipe that silently shrank.
      if (recipe.steps.length === restartIndex + 1 && discarded.length > 0) {
        log.warn(`orchestrator: recipe restart at ${stepId} could not regenerate ${discarded.length} step(s); restoring them`);
        recipe = restoreTail(recipe, discarded);
      }
      plan = { ...plan, steps: planStepsOf(recipe), goal: recipe.goal };
    }
    emitRecipe("restart", "restart");
    o.saveRecipe?.(structuredClone(recipe));
    checkpoint(false);
    log.info(`orchestrator: recipe restarted at ${stepId}; kept ${result.kept.length}, regenerated ${result.regenerated.length}`);
  };

  const runStepWorker = async (prompt: string, suffix: string): Promise<WorkerOutcome> => {
    const resumeWorker = worker?.prompt === prompt ? worker : undefined;
    worker = resumeWorker;
    checkpoint(true);
    // An explicit checkpoint resume must be able to continue a budget-exhausted
    // worker, without replaying completed tools. Grant one bounded additional
    // slice for this resume only; ordinary execution never auto-extends itself.
    const workerLimit = restored && resumeWorker && resumeWorker.steps >= oc.maxStepsPerWorker
      ? resumeWorker.steps + oc.maxStepsPerWorker
      : oc.maxStepsPerWorker;
    const w = await runWorker(
      { ...o, resumeWorker, saveWorker: value => { worker = value; checkpoint(true); } },
      prompt,
      recipeMode ? `${suffix}\n\n${missionSuffix(o.cfg)}` : suffix,
      workerLimit,
    );
    worker = undefined;
    totalSteps += w.steps;
    addUsage(usage, w.usage);
    if (w.model) usedModel = w.model;
    if (w.messages.length > 0) lastMessages = w.messages;
    return w;
  };

  const finish = (text: string): RunResult => {
    guard();
    if (!text.trim()) throw new Error("executor returned an empty answer");
    lastText = text;
    checkpoint(false, true);
    const finalText = text.trim().length > 0 ? text : "(no output)";
    o.emit({ type: "assistant_message", text: finalText });
    o.emit({ type: "done", text: finalText, steps: totalSteps, model: usedModel });
    return { text: finalText, messages: lastMessages, steps: totalSteps, model: usedModel, usage, verified: true };
  };

  const runFinalRepair = async (prompt: string): Promise<void> => {
    const fixed = await runStepWorker(prompt, WORKER_SUFFIX);
    allTrace.push(...fixed.trace);
    if (fixed.error) throw new Error(`final revision worker failed: ${fixed.error}`);
    if (!fixed.text.trim()) throw new Error("final revision worker returned an empty answer");
    lastText = fixed.text;
    completed.push(`final revision: ${oneLine(fixed.text, 200)}`);
    pendingFinalRepair = undefined;
    checkpoint(false);
  };

  // A restored completion is rechecked against current state without replaying
  // effects. Neither trivial plans nor planner failures bypass verification.

  let failure: string | null = null;
  /** D19: set when a worker stopped on the compute-budget ceiling. */
  let budgetExhausted = false;

  for (;;) {
    let failedStep: string | null = null;

    await maybeRestart();

    for (let i = nextStep; i < plan.steps.length; i++) {
      guard();
      // Recipe mode: a step the planner dropped is not work, so the run skips it
      // instead of executing a step that no longer belongs to the recipe.
      const recipeStep = recipeMode ? recipe.steps.find((item) => item.id === plan.steps[i]!.id) : undefined;
      if (recipeStep && (recipeStep.status === "skipped" || recipeStep.status === "blocked")) {
        if (recipeStep.status === "blocked" && plan.steps[i]!.successCriteria) {
          // A blocked step is terminal evidence: the planner re-routes around
          // it in the next proposal round, so it is never retried here.
          completed.push(`${plan.steps[i]!.title}: blocked`);
        }
        nextStep = i + 1;
        continue;
      }
      // D19 compute budget: orchestration-level work (planner, verifier, final
      // verification) is charged to the same session budget, so consult the
      // ceiling BEFORE dispatching another worker. Otherwise a long plan or a
      // token-heavy verifier could burn past 100% unchecked.
      if (o.budget) {
        const budgetDecision = checkBudget(o.budget);
        if (budgetDecision.action === "stop") {
          failedStep = budgetDecision.reason;
          budgetExhausted = true;
          break;
        }
      }
      if (recipeMode) {
        const index = recipe.steps.findIndex((item) => item.id === plan.steps[i]!.id);
        if (index >= 0) recipe = beginStep(recipe, index);
      }
      nextStep = i;
      checkpoint(true);
      const step = plan.steps[i]!;
      const emitStep = (phase: "start" | "done"): void => {
        o.emit({
          type: "plan_step",
          id: step.id,
          index: i + 1,
          total: plan.steps.length,
          title: step.title,
          phase,
        });
      };
      emitStep("start");
      if (recipeMode) emitRecipe("advance", "auto");

      const maxAttempts = Math.max(1, oc.maxRevisionsPerStep + 1);
      let attempt = 0;
      let outcome: WorkerOutcome | null = null;
      let verdict: VerdictOutcome | null = null;
      const stepEvidence: ToolTraceItem[] = [];

      while (attempt < maxAttempts) {
        guard();
        attempt += 1;
        outcome = await runStepWorker(stepPrompt(o, plan, step, i, completed, verdict), WORKER_SUFFIX);
        allTrace.push(...outcome.trace);
        stepEvidence.push(...outcome.trace);
        if (outcome.budgetStopped) {
          // D19: the session ceiling is hit. Do NOT retry or replan — that would
          // only burn more of a budget that is already exhausted. The session
          // stays idle and the user can raise the ceiling to continue.
          failedStep = outcome.error ?? "compute budget exhausted";
          budgetExhausted = true;
          break;
        }
        if (outcome.error) {
          failedStep = `${step.title}: ${outcome.error}`;
          break;
        }

        const workerText = outcome.text || `(executor failed: ${outcome.error ?? "unknown error"})`;
        verdict = await critiqueStep({
          tools: o.tools,
          emit: o.emit,
          history: o.history,
          cfg: o.cfg,
          ollama: o.ollama,
          goal: plan.goal,
          request: o.prompt,
          step,
          stepIndex: i,
          totalSteps: plan.steps.length,
          attempt,
          maxAttempts,
          workerText,
          trace: stepEvidence,
          ...(oc.verifierModel ? { model: oc.verifierModel } : {}),
          ...(o.signal ? { signal: o.signal } : {}),
          ...(o.taskId ? { taskId: o.taskId } : {}),
        });
        addUsage(usage, verdict.usage);
        // D19 compute budget: the verifier critique is real work and counts too.
        if (o.budget) consumeTokens(o.budget, verdict.usage.promptTokens, verdict.usage.completionTokens);
        totalSteps += 1;
        o.verdicts?.push({ scope: `step ${step.id}`, verdict: verdict.verdict, reason: verdict.reason, fixes: verdict.fixes });
        o.emit({ type: "critique", id: step.id, verdict: verdict.verdict, reason: verdict.reason });

        if (verdict.verdict !== "revise") break;
        if (attempt < maxAttempts) o.emit({ type: "revise", id: step.id, attempt: attempt + 1, fixes: verdict.fixes });
      }

      if (failedStep || verdict?.verdict !== "pass") {
        failedStep ??= `${step.title}: ${verdict?.reason ?? "verification missing"}`;
        if (recipeMode) {
          // Recipe mode: a failed step is EVIDENCE, not a reason to rebuild the
          // whole plan. Mark it blocked, ask the planner what to do about the
          // result it just saw, and continue with whatever it proposes (a
          // re-route through another tool, an extra step, a reworded one).
          const recipeIndex = recipe.steps.findIndex((item) => item.id === step.id);
          if (recipeIndex >= 0) recipe = finishStep(recipe, recipeIndex, false);
          await proposeNext(recipeIndex, `${step.title}: ${failedStep}`, stepEvidence);
          plan = { ...plan, steps: planStepsOf(recipe) };
          emitRecipe("advance", "auto");
          // The planner found another way forward: keep going instead of falling
          // back to a whole-plan replan, which would discard the recipe.
          const rerouted = recipe.steps.some(
            (item, index) =>
              index !== recipeIndex &&
              item.status !== "done" &&
              item.status !== "skipped" &&
              item.status !== "blocked",
          );
          if (rerouted) {
            failedStep = null;
            nextStep = i + 1;
            checkpoint(false);
            continue;
          }
        }
        break;
      }
      completed.push(`${step.title}: ${oneLine(outcome?.text ?? "", 200) || "(no output)"}`);
      // Worker drafts may claim whole-task success. Keep them in the private
      // review/checkpoint state, never in a public progress event before the
      // mandatory final gate has approved delivery.
      emitStep("done");
      if (outcome && outcome.text.trim().length > 0) lastText = outcome.text;
      nextStep = i + 1;
      checkpoint(false);

      if (recipeMode) {
        // The step's results are now evidence. Ask the planner what the recipe
        // needs next and let the loop pick up whatever it decided: a step that
        // was just proposed, a rewritten one, or a recipe that is now complete.
        const recipeIndex = recipe.steps.findIndex((item) => item.id === step.id);
        if (recipeIndex >= 0) recipe = finishStep(recipe, recipeIndex, true);
        const digest = `${step.title}: ${oneLine(outcome?.text ?? "", 200) || "(no output)"}`;
        await proposeNext(recipeIndex, digest, stepEvidence);
        // The recipe may have grown, in which case the frozen plan has to grow
        // with it or the loop would stop early.
        plan = { ...plan, steps: planStepsOf(recipe) };
        emitRecipe("advance", "auto");
      }
    }

    if (!failedStep) break;
    if (budgetExhausted) {
      // No replan on an exhausted budget: report the ceiling and stop.
      failure = failedStep;
      break;
    }
    if (round > oc.maxReplans) {
      failure = failedStep;
      break;
    }

    o.emit({ type: "replan", round, reason: failedStep });
    guard();
    log.info(`orchestrator: replanning (round ${round}) after: ${failedStep}`);
    const replanned = await planTask({
      cfg: o.cfg,
      ollama: o.ollama,
      prompt: replanPrompt(o, completed, failedStep),
      history: o.history,
      maxPlanSteps: oc.maxPlanSteps,
      availableTools: o.tools.names(),
      ...(oc.plannerModel ? { model: oc.plannerModel } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    ...(o.taskId ? { taskId: o.taskId } : {}),
    });
    plan = replanned.plan;
    usedModel = replanned.model || usedModel;
    addUsage(usage, replanned.usage);
    // D19 compute budget: a replan is real work and counts against the ceiling.
    if (o.budget) consumeTokens(o.budget, replanned.usage.promptTokens, replanned.usage.completionTokens);
    totalSteps += 1;
    if (recipeMode) {
      // A replan replaces the plan, so the recipe is re-seeded from it: the
      // steps that already ran stay, the ones the new plan does not mention are
      // dropped, and the rest are taken as the new plan has them.
      recipe = reseedRecipe(recipe, replanned.plan.goal, replanned.plan.steps);
      emitRecipe("advance", "planner");
    }
    emitPlan();
    round += 1;
    nextStep = 0;
    checkpoint(false);
  }

  // Resume the already-authorized repair before judging the stale pre-repair
  // draft. This is the same repair attempt, not a fresh verification bypass.
  if (!failure && finalRepairUsed && pendingFinalRepair) {
    guard();
    await runFinalRepair(pendingFinalRepair);
  }

  // A Stop hook may force the run to keep working after the first verified
  // answer. That replacement answer has to be verified again before the run may
  // finish, so a block loops back into verification instead of returning at once.
  let stopContinuation = false;
  for (;;) {
    while (!failure && lastText.trim().length > 0) {
      guard();
      const v = await verifyFinal({
        acceptanceGuard,
        independentGuard, independentRequest, saveIndependentAcceptance: pendingUsage => checkpoint(false, false, pendingUsage),
        history: o.history,
        cfg: o.cfg,
        ollama: o.ollama,
        request: o.prompt,
        goal: plan.goal,
        finalText: lastText,
        completedSteps: completed,
        trace: allTrace,
        tools: o.tools,
        emit: o.emit,
        ...(oc.verifierModel ? { model: oc.verifierModel } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      ...(o.taskId ? { taskId: o.taskId } : {}),
      });
      addUsage(usage, v.usage);
      totalSteps += 1;
      o.verdicts?.push({ scope: "final", verdict: v.verdict, reason: v.reason, fixes: v.fixes });
      o.emit({ type: "verify", verdict: v.verdict, reason: v.reason });
      if (v.verdict === "pass" && v.finalAnswer) lastText = v.finalAnswer;

      if (v.verdict !== "pass") {
        if (v.unavailable) throw new Error(`Independent verification unavailable; preserve output and resume verification when the environment is ready: ${v.reason}`);
        if (finalRepairAttempts >= 2) throw new Error(`orchestrator: task incomplete: final verification still failed: ${v.reason}`);
        finalRepairAttempts++;
        o.emit({ type: "revise", id: "final", attempt: finalRepairAttempts, fixes: v.fixes });
        guard();
        finalRepairUsed = true;
        pendingFinalRepair = finalFixPrompt(o, plan.goal, lastText, v);
        checkpoint(true);
        await runFinalRepair(pendingFinalRepair);
      } else break;
    }

    if (failure) {
      throw new Error(`orchestrator: task incomplete: ${failure}`);
    }

    // Stop: a hook may force the orchestrated run to keep working instead of
    // finishing. The continuation is bounded so a hook that always blocks still
    // ends the run, and its revised answer is re-verified by looping back.
    if (o.lifecycleHooks !== true || stopContinuation) break;
    let continued = false;
    for (let round = 0; round < STOP_CONTINUATION_ROUNDS; round++) {
      const stop = await runLifecycleHooks("Stop", "", { stopReason: "completed" }, o.cfg.workspace);
      if (!stop.blocked) break;
      o.emit({ type: "error", message: `Stop hook blocked completion: ${stop.message}` });
      if (lastText.trim().length === 0) break;
      await runFinalRepair(stopContinuePrompt(o, stop.message, stop.additionalContext));
      continued = true;
    }
    if (!continued) break;
    stopContinuation = true;
  }

  return finish(lastText);
}

/** Session lifecycle boundary for the orchestrated run. SessionStart and
 *  UserPromptSubmit run before planning; SessionEnd reports the real terminal
 *  reason. Nested runs (workers, subagent children) omit `lifecycleHooks`. */
export async function runOrchestratedAgent(o: OrchestratorOptions): Promise<RunResult> {
  const enabled = o.lifecycleHooks === true;
  const workspace = o.cfg.workspace;
  let reason: SessionEndReason = "failed";
  try {
    const session = await openSession({ workspace, prompt: o.prompt, signal: o.signal, taskId: o.taskId, enabled });
    if (session.injected) o = { ...o, prompt: o.prompt + "\n\n" + session.injected };
    const result = await runOrchestratedAgentImpl(o);
    reason = "completed";
    return result;
  } catch (err) {
    reason = cancelled(o.signal, o.taskId) ? "cancelled" : "failed";
    throw err;
  } finally {
    if (enabled) await closeSession(workspace, reason);
  }
}
