import type { ChatMessage } from "../ollama.js";
import type { Emit, PlanStepInfo, ToolTraceItem, Usage, VerdictInfo } from "./events.js";
import { log } from "../log.js";
import { runAgent, type RunOptions, type RunResult } from "./loop.js";
import { planTask, type Plan, type PlanResult } from "./planner.js";
import { critiqueStep, verifyFinal, type VerdictOutcome } from "./verifier.js";
import { CancelledError, isCancelled, isCancelledError, throwIfCancelled } from "../server/runControl.js";
import type { ExecutionCheckpoint } from "./checkpoint.js";

export interface VerdictRecord extends VerdictInfo {
  scope: string;
}

export interface OrchestratorOptions extends RunOptions {
  /** Collector: every verifier verdict (per step and final) is appended here. */
  verdicts?: VerdictRecord[];
  resume?: ExecutionCheckpoint;
  saveCheckpoint?: (checkpoint: ExecutionCheckpoint) => void;
}

const WORKER_SUFFIX = [
  "You are the executor (worker) sub-agent of an orchestrated task.",
  "Execute ONLY the current plan step below; later steps run separately as their own sub-agents.",
  "Leave concrete evidence (file paths, command output, URLs) because a verifier checks your work against the success criteria.",
  "If the current step is the last one, end with the complete, user-facing answer.",
].join("\n");

function oneLine(text: string, max = 300): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function addUsage(target: Usage, add: Usage): void {
  target.promptTokens += add.promptTokens;
  target.completionTokens += add.completionTokens;
  target.durationMs += add.durationMs;
}

interface WorkerOutcome {
  text: string;
  messages: ChatMessage[];
  model: string;
  steps: number;
  usage: Usage;
  trace: ToolTraceItem[];
  error?: string;
}

async function runWorker(o: OrchestratorOptions, prompt: string, systemSuffix: string, maxSteps: number): Promise<WorkerOutcome> {
  const trace: ToolTraceItem[] = [];
  const emit: Emit = (event) => {
    o.emit(event);
    if (event.type === "tool_result") {
      trace.push({ name: event.name, ok: event.ok, summary: event.summary, ms: event.ms });
    }
  };
  const inherited = o.systemSuffix && o.systemSuffix.trim().length > 0 ? `${o.systemSuffix.trim()}\n\n` : "";
  try {
    const res = await runAgent({
      cfg: o.cfg,
      ollama: o.ollama,
      tools: o.tools,
      emit,
      prompt,
      ...(o.history ? { history: o.history } : {}),
      ...(o.memories ? { memories: o.memories } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    ...(o.taskId ? { taskId: o.taskId } : {}),
      systemSuffix: `${inherited}${systemSuffix}`,
      maxSteps,
      suppressFinal: true,
    });
    return { text: res.text, messages: res.messages, model: res.model, steps: res.steps, usage: res.usage, trace };
  } catch (err) {
    // Cancellation is not a step failure — propagate it so the whole run stops now.
    if (o.signal?.aborted || isCancelled(o.taskId) || isCancelledError(err)) {
      throw err instanceof Error ? err : new CancelledError();
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      text: "",
      messages: [],
      model: o.cfg.model,
      steps: 0,
      usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
      trace,
      error: message,
    };
  }
}

function stepPrompt(o: OrchestratorOptions, plan: Plan, step: PlanStepInfo, index: number, completed: string[], critique: VerdictInfo | null): string {
  const lines: string[] = [];
  lines.push("=== Orchestrated task ===");
  lines.push("ORIGINAL USER REQUEST:");
  lines.push(o.prompt.slice(0, 2000));
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
    o.prompt.slice(0, 2000),
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
    "The task is complete but the final verification did not pass.",
    "",
    "ORIGINAL USER REQUEST:",
    o.prompt.slice(0, 2000),
    "",
    `PLAN GOAL: ${goal}`,
    "",
    "CURRENT FINAL ANSWER:",
    finalText.slice(0, 3000),
    "",
    "VERIFIER VERDICT:",
    v.reason,
    ...(v.fixes.length > 0 ? ["REQUIRED FIXES:", ...v.fixes.map((f) => `- ${f}`)] : []),
    "",
    "Fix the final answer now. If evidence is missing, use tools to obtain it. Deliver the complete corrected final answer.",
  ].join("\n");
}

/** Planner -> executor workers -> verifier with the reflection loop
 *  (plan -> act -> observe -> critique -> revise), replacing the linear agent loop.
 *  Same signature as runAgent so it can be injected anywhere RunOptions is accepted. */
export async function runOrchestratedAgent(o: OrchestratorOptions): Promise<RunResult> {
  const oc = o.cfg.orchestrator;
  const restored = o.resume;
  const usage: Usage = { ...(restored?.usage ?? { promptTokens: 0, completionTokens: 0, durationMs: 0 }) };
  let totalSteps = restored?.totalSteps ?? 0;
  let usedModel = restored?.model ?? o.cfg.model;
  let lastMessages: ChatMessage[] = [];
  /** Stops the orchestrated run the moment the user presses cancel. */
  const guard = (): void => throwIfCancelled(o.signal, o.taskId);

  const planned: PlanResult = restored ? { plan: restored.plan, model: restored.model, usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 } } : await planTask({
    cfg: o.cfg,
    ollama: o.ollama,
    prompt: o.prompt,
    history: o.history,
    maxPlanSteps: oc.maxPlanSteps,
    ...(oc.plannerModel ? { model: oc.plannerModel } : {}),
    ...(o.memories ? { memories: o.memories } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.taskId ? { taskId: o.taskId } : {}),
  });
  guard();
  let plan = planned.plan;
  usedModel = planned.model || usedModel;
  addUsage(usage, planned.usage);
  if (!restored) totalSteps += 1;
  const completed = [...(restored?.completed ?? [])];
  const allTrace = [...(restored?.trace ?? [])];
  let lastText = restored?.lastText ?? "";
  let round = restored?.round ?? 1;
  let nextStep = restored?.nextStep ?? 0;
  let finalRepairUsed = restored?.finalRepairUsed ?? false;
  const checkpoint = (inFlight: boolean, complete = false): void => {
    o.saveCheckpoint?.(structuredClone({ version: 1, plan, nextStep, completed, lastText,
      trace: allTrace, round, usage, totalSteps, model: usedModel, inFlight, complete, finalRepairUsed }));
  };
  checkpoint(false, restored?.complete ?? false);

  const emitPlan = (): void => {
    o.emit({ type: "plan", goal: plan.goal, trivial: plan.trivial, steps: plan.steps, source: plan.source });
  };
  emitPlan();
  log.info(`orchestrator: plan (${plan.source}, trivial=${plan.trivial}) steps=${plan.steps.length}`);

  const runStepWorker = async (prompt: string, suffix: string): Promise<WorkerOutcome> => {
    const w = await runWorker(o, prompt, suffix, oc.maxStepsPerWorker);
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
    return { text: finalText, messages: lastMessages, steps: totalSteps, model: usedModel, usage };
  };

  if (restored?.complete) return finish(lastText);

  const trivialStep = plan.steps[0];
  if (plan.trivial && trivialStep && plan.steps.length === 1) {
    if (nextStep === 1) return finish(lastText);
    guard();
    checkpoint(true);
    o.emit({ type: "plan_step", id: trivialStep.id, index: 1, total: 1, title: trivialStep.title, phase: "start" });
    const w = await runStepWorker(o.prompt, "");
    o.emit({
      type: "plan_step",
      id: trivialStep.id,
      index: 1,
      total: 1,
      title: trivialStep.title,
      phase: "done",
      summary: oneLine(w.error ? `executor failed: ${w.error}` : w.text),
    });
    if (w.error) throw new Error(`executor failed: ${w.error}`);
    nextStep = 1;
    allTrace.push(...w.trace);
    return finish(w.text);
  }

  let failure: string | null = null;

  for (;;) {
    let failedStep: string | null = null;

    for (let i = nextStep; i < plan.steps.length; i++) {
      guard();
      nextStep = i;
      checkpoint(true);
      const step = plan.steps[i]!;
      const emitStep = (phase: "start" | "done", summary?: string): void => {
        o.emit({
          type: "plan_step",
          id: step.id,
          index: i + 1,
          total: plan.steps.length,
          title: step.title,
          phase,
          ...(summary !== undefined ? { summary } : {}),
        });
      };
      emitStep("start");

      const maxAttempts = Math.max(1, oc.maxRevisionsPerStep + 1);
      let attempt = 0;
      let outcome: WorkerOutcome | null = null;
      let verdict: VerdictOutcome | null = null;

      while (attempt < maxAttempts) {
        guard();
        attempt += 1;
        outcome = await runStepWorker(stepPrompt(o, plan, step, i, completed, verdict), WORKER_SUFFIX);
        allTrace.push(...outcome.trace);
        emitStep("done", oneLine(outcome.error ? `executor failed: ${outcome.error}` : outcome.text));
        if (outcome.error) {
          failedStep = `${step.title}: ${outcome.error}`;
          break;
        }

        const workerText = outcome.text || `(executor failed: ${outcome.error ?? "unknown error"})`;
        verdict = await critiqueStep({
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
          trace: outcome.trace,
          ...(oc.verifierModel ? { model: oc.verifierModel } : {}),
          ...(o.signal ? { signal: o.signal } : {}),
          ...(o.taskId ? { taskId: o.taskId } : {}),
        });
        addUsage(usage, verdict.usage);
        totalSteps += 1;
        o.verdicts?.push({ scope: `step ${step.id}`, verdict: verdict.verdict, reason: verdict.reason, fixes: verdict.fixes });
        o.emit({ type: "critique", id: step.id, verdict: verdict.verdict, reason: verdict.reason });

        if (verdict.verdict !== "revise") break;
        if (attempt < maxAttempts) o.emit({ type: "revise", id: step.id, attempt: attempt + 1, fixes: verdict.fixes });
      }

      if (failedStep || verdict?.verdict !== "pass") {
        failedStep ??= `${step.title}: ${verdict?.reason ?? "verification missing"}`;
        break;
      }
      completed.push(`${step.title}: ${oneLine(outcome?.text ?? "", 200) || "(no output)"}`);
      if (outcome && outcome.text.trim().length > 0) lastText = outcome.text;
      nextStep = i + 1;
      checkpoint(false);
    }

    if (!failedStep) break;
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
      ...(oc.plannerModel ? { model: oc.plannerModel } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    ...(o.taskId ? { taskId: o.taskId } : {}),
    });
    plan = replanned.plan;
    usedModel = replanned.model || usedModel;
    addUsage(usage, replanned.usage);
    totalSteps += 1;
    emitPlan();
    round += 1;
    nextStep = 0;
    checkpoint(false);
  }

  if (!failure && oc.verifyFinal && lastText.trim().length > 0) {
    guard();
    const v = await verifyFinal({
      history: o.history,
      cfg: o.cfg,
      ollama: o.ollama,
      request: o.prompt,
      goal: plan.goal,
      finalText: lastText,
      completedSteps: completed,
      trace: allTrace,
      ...(oc.verifierModel ? { model: oc.verifierModel } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    ...(o.taskId ? { taskId: o.taskId } : {}),
    });
    addUsage(usage, v.usage);
    totalSteps += 1;
    o.verdicts?.push({ scope: "final", verdict: v.verdict, reason: v.reason, fixes: v.fixes });
    o.emit({ type: "verify", verdict: v.verdict, reason: v.reason });

    if (v.verdict !== "pass") {
      if (finalRepairUsed) throw new Error(`final verification still failed: ${v.reason}`);
      o.emit({ type: "revise", id: "final", attempt: 1, fixes: v.fixes });
      guard();
      finalRepairUsed = true;
      checkpoint(true);
      const fixed = await runStepWorker(finalFixPrompt(o, plan.goal, lastText, v), WORKER_SUFFIX);
      allTrace.push(...fixed.trace);
      if (fixed.text.trim().length > 0) {
        lastText = fixed.text;
        completed.push(`final revision: ${oneLine(fixed.text, 200)}`);
      }
      if (fixed.error) throw new Error(`final revision worker failed: ${fixed.error}`);
      checkpoint(false);
      const checked = await verifyFinal({
        history: o.history,
        cfg: o.cfg, ollama: o.ollama, request: o.prompt, goal: plan.goal,
        finalText: lastText, completedSteps: completed, trace: allTrace,
        ...(oc.verifierModel ? { model: oc.verifierModel } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      });
      addUsage(usage, checked.usage);
      totalSteps += 1;
      o.verdicts?.push({ scope: "final", verdict: checked.verdict, reason: checked.reason, fixes: checked.fixes });
      o.emit({ type: "verify", verdict: checked.verdict, reason: checked.reason });
      if (checked.verdict !== "pass") failure = `final verification: ${checked.reason}`;
    }
  }

  if (failure) {
    throw new Error(`orchestrator: task incomplete: ${failure}`);
  }
  return finish(lastText);
}
