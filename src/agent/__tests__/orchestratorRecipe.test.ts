/**
 * Neo N4: the orchestrator's incremental Recipe mode, end to end.
 *
 * The seed plan is only the seed. After every step the planner is asked what the
 * recipe needs next, from that step's tool results, so a failed tool re-routes to
 * an alternate one instead of rebuilding the whole plan, a restart from a step
 * never re-calls the tools of the steps before it, and the remaining-work
 * estimate is emitted and falls as the run proceeds.
 *
 * Every model call is served by a scripted fake client and every tool by a
 * counting registry, so no provider and no network is contacted.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../../config.js";
import { ToolRegistry, type ToolContext, type ToolResult } from "../../tools/registry.js";
import { runOrchestratedAgent } from "../orchestrator.js";
import { finishStep, initRecipe, type RecipeState } from "../recipe.js";
import { consumeTokens, createComputeBudget, type ComputeBudget } from "../computeBudget.js";
import type { AgentEvent, RecipeChange } from "../events.js";
import type { ChatMessage, ChatOptions, ChatResult, OllamaClient, OllamaToolCall } from "../../ollama.js";

type Role = "planner" | "recipe" | "critic" | "final" | "worker" | "inspector";

/** Which model role a turn belongs to, from the system prompt it received. */
function roleOf(messages: ChatMessage[]): Role {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  if (system.includes("planner role")) return "planner";
  if (system.includes("recipe planner")) return "recipe";
  // The inspector shares the final verifier's system prompt plus the inspection
  // instruction, so it has to be told apart before the plain final check.
  if (system.includes("Independently inspect the actual result")) return "inspector";
  if (system.includes("COMPLETED task as a whole")) return "final";
  if (system.includes("ONE executed plan step")) return "critic";
  return "worker";
}

/** The read-only tool the independent verifier uses to inspect the result. */
const INSPECTION_TOOL = "file_read";

/** The step a worker prompt is about, as the orchestrator names it. */
function stepTitle(prompt: string): string | undefined {
  return /CURRENT STEP \d+\/\d+: (.+)/.exec(prompt)?.[1];
}

interface ToolSpec {
  name: string;
  /** The observable effect the tool produces, as its result content. */
  output: string;
  /** When set, the tool reports failure instead of success. */
  fail?: boolean;
}

interface StepSpec {
  id: string;
  title: string;
  instruction: string;
  criteria: string;
  /** The tool this step's worker calls. Defaults to the first registered tool. */
  tool?: string;
}

interface Harness {
  calls: Record<Role, number>;
  /** Tool results of the recipe-planner rounds, in order. */
  plannerRounds: string[];
  toolRuns: Map<string, number>;
  run: (options?: {
    recipeMode?: boolean;
    recipeRestart?: { stepId: string; nodeId?: string; reason: string };
    recipeState?: RecipeState;
    budget?: ComputeBudget;
  }) => Promise<{
    events: AgentEvent[];
    text: string;
    error?: string;
  }>;
}

/** The recipe planner's decisions, in the order the rounds arrive. */
interface RecipeScript {
  /**
   * One reply per proposal round, in order. The last entry repeats, so a script
   * can end with the terminal "complete" reply and stay terminal.
   */
  rounds: string[];
}

function planJson(steps: StepSpec[]): string {
  return JSON.stringify({
    goal: "finish the request",
    trivial: false,
    steps: steps.map((step) => ({
      id: step.id,
      title: step.title,
      instruction: step.instruction,
      success_criteria: step.criteria,
    })),
  });
}

function recipeJson(add: unknown[] = [], rewrite: Record<string, unknown> = {}, drop: string[] = [], remaining = 1, complete = false): string {
  return JSON.stringify({ add, rewrite, drop, remaining_estimate: remaining, complete });
}

/** A script whose rounds all say "keep going", ending with the terminal reply. */
function keepGoingScript(terminal: string, rounds = 3): RecipeScript {
  return { rounds: Array.from({ length: rounds }, () => recipeJson([], {}, [], 1, false)).concat([terminal]) };
}

function verdictJson(verdict: "pass" | "revise" | "fail", reason: string, fixes: string[] = []): string {
  return JSON.stringify({ verdict, reason, fixes });
}

/**
 * Build a harness whose planner, recipe planner, verifier and worker are all
 * scripted.
 *
 * A step's worker works in two turns: it first returns the tool call the step
 * names, then (once that tool has run) it returns the step output. That is what
 * a real executor does, and it keeps the loop from demanding more turns than a
 * step needs. Every tool call is counted, so the tool counter is a faithful
 * record of what actually ran.
 */
function harness(steps: StepSpec[], tools: ToolSpec[], script: RecipeScript): Harness {
  const calls: Record<Role, number> = { planner: 0, recipe: 0, critic: 0, final: 0, worker: 0, inspector: 0 };
  const plannerRounds: string[] = [];
  const toolRuns = new Map<string, number>();
  /** Replies the recipe planner still owes, in order; the last one repeats. */
  const scriptQueue = [...script.rounds];
  /** Titles of the steps whose worker already made its one tool call. */
  const workerActed = new Set<string>();
  /** The independent verifier inspects the result at most once per run. */
  let inspected = false;

  const cfg = loadConfig();
  cfg.workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-recipe-mode-"));
  cfg.orchestrator.maxStepsPerWorker = 6;
  cfg.orchestrator.maxReplans = 2;
  cfg.orchestrator.maxRevisionsPerStep = 1;
  // Keep the harness hermetic: no provider may serve a coding turn from the
  // network, and the injected fake client is the only candidate.
  cfg.coding = { enabled: true, chain: [], logEdits: false };
  cfg.failover = { providers: [] };
  cfg.fallbackModel = cfg.model;

  const registry = new ToolRegistry();
  for (const spec of tools) {
    registry.register({
      name: spec.name,
      description: `${spec.name} test tool`,
      parameters: { type: "object", properties: {} },
      run: async (_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => {
        toolRuns.set(spec.name, (toolRuns.get(spec.name) ?? 0) + 1);
        return spec.fail ? { ok: false, content: `${spec.name} failed` } : { ok: true, content: spec.output };
      },
    });
  }
  // The independent verifier needs a read-only inspection tool, or it refuses to
  // pass the run. It is registered last so it never shadows a step's own tool.
  registry.register({
    name: INSPECTION_TOOL,
    description: "read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    run: async () => ({ ok: true, content: "file contents" }),
  });

  const chat = async (opts: ChatOptions): Promise<ChatResult> => {
    const role = roleOf(opts.messages);
    calls[role] += 1;
    const last = opts.messages[opts.messages.length - 1]?.content ?? "";
    let content = "done";
    let toolCalls: OllamaToolCall[] = [];

    if (role === "planner") {
      content = planJson(steps);
    } else if (role === "recipe") {
      plannerRounds.push(last);
      // Each round consumes the next scripted reply, so a run that takes an
      // unexpected number of rounds still gets the reply it should.
      const next = scriptQueue.length > 1 ? scriptQueue.shift()! : scriptQueue[0]!;
      content = next;
    } else if (role === "final") {
      content = JSON.stringify({ verdict: "pass", reason: "the answer satisfies the request", fixes: [] });
    } else if (role === "critic") {
      content = verdictJson("pass", "the step's criteria are met");
    } else if (role === "inspector") {
      // Inspect the result with the read-only tool, then pass on the evidence.
      if (!inspected) {
        inspected = true;
        toolCalls = [{ function: { name: INSPECTION_TOOL, arguments: {} } }];
      } else {
        content = JSON.stringify({ verdict: "pass", reason: "independently inspected the result", fixes: [] });
      }
    } else {
      const title = stepTitle(last);
      const step = steps.find((candidate) => candidate.title === title);
      // The executor calls the tool its step names. Resolve it from the prompt
      // itself so a step the planner added later still gets its own tool.
      const name =
        tools.map((tool) => tool.name).find((tool) => last.includes(tool)) ??
        step?.tool ??
        steps[0]?.tool ??
        tools[0]!.name;
      // The executor calls its one tool, and only once: a step whose worker
      // keeps calling tools would make the loop spin without bound.
      if (title && !workerActed.has(title)) {
        workerActed.add(title);
        toolCalls = [{ function: { name, arguments: {} } }];
      } else {
        content = "step output";
      }
    }

    return { content, toolCalls, model: "fixture-model", usage: { promptTokens: 10, completionTokens: 5, durationMs: 1 } };
  };

  const client = { chat, listModels: async () => [] } as unknown as OllamaClient;

  return {
    calls,
    plannerRounds,
    toolRuns,
    async run(options = {}) {
      const events: AgentEvent[] = [];
      try {
        const result = await runOrchestratedAgent({
          cfg,
          ollama: client,
          tools: registry,
          prompt: "run the recipe",
          emit: (event) => events.push(event),
          ...(options.recipeMode === undefined ? {} : { recipeMode: options.recipeMode }),
          ...(options.recipeRestart ? { recipeRestart: options.recipeRestart } : {}),
          ...(options.recipeState ? { recipeState: options.recipeState } : {}),
          ...(options.budget ? { budget: options.budget } : {}),
        });
        return { events, text: result.text };
      } catch (error) {
        return { events, text: "", error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** Recipe steps, as the client renders them. */
function recipeUpdates(events: AgentEvent[]) {
  return events.filter((event): event is Extract<AgentEvent, { type: "recipe_update" }> => event.type === "recipe_update");
}

/** The round kinds the client observed, in order. */
function roundKinds(events: AgentEvent[]): RecipeChange[] {
  return recipeUpdates(events).map((update) => update.change);
}

describe("orchestrator recipe mode", () => {
  it("re-routes a failed tool instead of rebuilding the whole plan", async () => {
    const h = harness(
      [
        { id: "s1", title: "gather", instruction: "gather with web_fetch", criteria: "the source is fetched", tool: "web_fetch" },
        { id: "s2", title: "deliver", instruction: "deliver with file_write", criteria: "the answer is delivered", tool: "file_write" },
      ],
      [
        { name: "web_fetch", output: "fetch failed", fail: true },
        { name: "web_search", output: "three sources found" },
        { name: "file_write", output: "written" },
      ],
      {
        // The recipe planner sees the failed fetch and proposes a re-route to a
        // different available tool, then lets the delivery step finish the task.
        rounds: [
          recipeJson(
            [{ id: "s3", title: "retry the source", instruction: "retry with web_search", success_criteria: "the source is found" }],
            {},
            [],
            2,
            false,
          ),
          recipeJson([], {}, [], 1, false),
          recipeJson([], {}, [], 1, true),
        ],
      },
    );

    const { events, error } = await h.run({ recipeMode: true });
    assert.equal(error, undefined, `the run completed: ${error ?? ""}`);
    assert.equal(events.filter((event) => event.type === "done").length, 1, "the run finished");

    // The recipe planner was consulted for the failure: the round is real work.
    assert.ok(h.calls.recipe >= 1, `expected a recipe proposal round, got ${h.calls.recipe}`);

    // The failing tool ran once and the alternate tool the planner chose ran once:
    // a failure is evidence, not a reason to replay the whole plan.
    assert.equal(h.toolRuns.get("web_fetch"), 1, "the failing tool ran once");
    assert.equal(h.toolRuns.get("web_search"), 1, "the re-route tool ran once");

    // The re-route reached the client as a recipe change, and the new step ran.
    assert.ok(roundKinds(events).includes("propose"), "the added step is reported as a recipe change");
    assert.ok(
      recipeUpdates(events).some((update) => update.steps.some((step) => step.id === "s3" && step.status === "done")),
      "the re-route step ran and finished",
    );

    // No whole-plan replan happened: the recipe absorbed the failure.
    assert.equal(events.filter((event) => event.type === "replan").length, 0, "no full replan on a re-route");
  });

  it("emits a remaining estimate that decreases as the recipe is consumed", async () => {
    const h = harness(
      [
        { id: "s1", title: "one", instruction: "do the first thing", criteria: "one is done", tool: "file_write" },
        { id: "s2", title: "two", instruction: "do the second thing", criteria: "two is done", tool: "file_write" },
        { id: "s3", title: "three", instruction: "do the third thing", criteria: "three is done", tool: "file_write" },
      ],
      [{ name: "file_write", output: "written" }],
      keepGoingScript(recipeJson([], {}, [], 1, true)),
    );

    const { events, error } = await h.run({ recipeMode: true });
    assert.equal(error, undefined, `the run completed: ${error ?? ""}`);

    const estimates = recipeUpdates(events).map((update) => update.remainingEstimate);
    assert.ok(estimates.length >= 2, "the recipe was reported more than once");
    assert.equal(estimates[0], 3, "the seed recipe reports three steps of work");
    // The estimate is monotone and ends at zero: the user sees the work shrink.
    for (let i = 1; i < estimates.length; i++) {
      assert.ok(estimates[i]! <= estimates[i - 1]!, `the estimate must not rise: ${estimates.join(" -> ")}`);
    }
    assert.equal(estimates[estimates.length - 1], 0, "a finished recipe reports no remaining work");

    // The client-visible recipe row carries the per-step status and the completed count.
    const last = recipeUpdates(events)[recipeUpdates(events).length - 1]!;
    assert.equal(last.steps.length, 3);
    assert.equal(last.steps.filter((step) => step.status === "done").length, 3);
    assert.equal(last.steps[0]!.completedCount, 3);
  });

  it("keeps the upstream steps of a restart verbatim and never re-calls their tools", async () => {
    const h = harness(
      [
        { id: "s1", title: "one", instruction: "do the first thing", criteria: "one is done", tool: "file_write" },
        { id: "s2", title: "two", instruction: "do the second thing", criteria: "two is done", tool: "file_write" },
        { id: "s3", title: "three", instruction: "do the third thing", criteria: "three is done", tool: "file_write" },
      ],
      [{ name: "file_write", output: "written" }],
      keepGoingScript(recipeJson([], {}, [], 1, true)),
    );

    // The steps before the restart point already ran: their tools produced the
    // outputs the restart keeps, so they are done before the run resumes.
    let recipeState = initRecipe("finish the request", [
      { id: "s1", title: "one", instruction: "do the first thing", successCriteria: "one is done" },
      { id: "s2", title: "two", instruction: "do the second thing", successCriteria: "two is done" },
      { id: "s3", title: "three", instruction: "do the third thing", successCriteria: "three is done" },
    ]);
    recipeState = finishStep(recipeState, 0, true);
    recipeState = finishStep(recipeState, 1, true);

    // Restart from step 3: steps 1 and 2 already ran, so their tools must not run
    // again. Only step 3 is re-executed.
    const { events, error } = await h.run({
      recipeMode: true,
      recipeRestart: { stepId: "s3", reason: "user edited the input of step 3" },
      recipeState,
    });
    assert.equal(error, undefined, `the run completed: ${error ?? ""}`);

    const restart = events.find((event): event is Extract<AgentEvent, { type: "recipe_restart" }> => event.type === "recipe_restart");
    assert.ok(restart, "a recipe_restart event was emitted");
    assert.equal(restart!.stepId, "s3");
    assert.deepEqual(restart!.keptSteps, ["s1", "s2"], "the upstream steps are kept");
    assert.deepEqual(restart!.regeneratedSteps, ["s3"], "only the restart point is regenerated");
    assert.match(restart!.reason, /user edited the input of step 3/);

    // The run starts at the restart point: the upstream steps never run again.
    const starts = events.filter((event): event is Extract<AgentEvent, { type: "plan_step" }> => event.type === "plan_step" && event.phase === "start");
    assert.deepEqual(starts.map((event) => event.id), ["s3"], "the run resumes at the restart point");

    // Tool calls: only the restart step's tool ran.
    assert.equal(h.toolRuns.get("file_write"), 1, "the restart re-runs only the restart step's tool");

    // The recipe row after the restart keeps the upstream steps as done.
    const afterRestart = recipeUpdates(events).filter((update) => update.change === "restart")[0];
    assert.ok(afterRestart, "the restart produced a recipe row");
    assert.deepEqual(afterRestart!.steps.map((step) => step.id), ["s1", "s2", "s3"]);
    assert.equal(afterRestart!.steps[0]!.status, "done", "the kept step keeps its finished status");
    assert.equal(afterRestart!.steps[1]!.status, "done");
    assert.equal(afterRestart!.steps[2]!.status, "ready", "the restart point is reopened");
    assert.equal(afterRestart!.remainingEstimate, 1);
  });

  it("regenerates the downstream steps a restart discarded instead of dropping them", async () => {
    // A restart reopens the restart point and discards everything after it. If
    // nothing is regenerated in its place, the run finishes the reopened step
    // and stops, silently losing the rest of the recipe. The planner is therefore
    // asked what comes next and its proposal is appended before the loop runs.
    const h = harness(
      [
        { id: "s1", title: "one", instruction: "do the first thing", criteria: "one is done", tool: "file_write" },
        { id: "s2", title: "two", instruction: "do the second thing", criteria: "two is done", tool: "file_write" },
        { id: "s3", title: "three", instruction: "do the third thing", criteria: "three is done", tool: "file_write" },
      ],
      [{ name: "file_write", output: "written" }],
      {
        rounds: [
          // The restart's regeneration round: s2 was reopened, so s3 has to come
          // back before the run can finish the recipe.
          recipeJson(
            [{ id: "s3", title: "three", instruction: "do the third thing", success_criteria: "three is done" }],
            {},
            [],
            1,
            false,
          ),
          recipeJson([], {}, [], 1, true),
        ],
      },
    );

    const { events, error } = await h.run({
      recipeMode: true,
      recipeRestart: { stepId: "s2", reason: "user edited the input of step 2" },
      recipeState: (() => {
        let state = initRecipe("finish the request", [
          { id: "s1", title: "one", instruction: "do the first thing", successCriteria: "one is done" },
          { id: "s2", title: "two", instruction: "do the second thing", successCriteria: "two is done" },
          { id: "s3", title: "three", instruction: "do the third thing", successCriteria: "three is done" },
        ]);
        state = finishStep(state, 0, true);
        state = finishStep(state, 1, true);
        return state;
      })(),
    });
    assert.equal(error, undefined, `the run completed: ${error ?? ""}`);

    const starts = events.filter((event): event is Extract<AgentEvent, { type: "plan_step" }> => event.type === "plan_step" && event.phase === "start");
    assert.deepEqual(starts.map((event) => event.id), ["s2", "s3"], "the discarded downstream step is regenerated and run");
    assert.equal(h.toolRuns.get("file_write"), 2, "only the restart step and the regenerated step run");

    const last = recipeUpdates(events)[recipeUpdates(events).length - 1]!;
    assert.deepEqual(last.steps.map((step) => step.id), ["s1", "s2", "s3"]);
    assert.equal(last.steps.filter((step) => step.status === "done").length, 3);
  });

  it("restores a restart's discarded tail when the regeneration round is unparseable", async () => {
    // A restart reopens its step and drops everything after it, then asks the
    // planner to regenerate that tail. An unparseable round proposes nothing, and
    // the run would otherwise finish holding only the reopened step while the
    // recipe_restart event already reported the tail as regenerated. The dropped
    // steps have to come back as work instead of silently disappearing.
    const h = harness(
      [
        { id: "s1", title: "one", instruction: "do the first thing", criteria: "one is done", tool: "file_write" },
        { id: "s2", title: "two", instruction: "do the second thing", criteria: "two is done", tool: "file_write" },
        { id: "s3", title: "three", instruction: "do the third thing", criteria: "three is done", tool: "file_write" },
      ],
      [{ name: "file_write", output: "written" }],
      // The regeneration round is not JSON, so the planner proposes nothing.
      { rounds: ["not json at all", recipeJson([], {}, [], 0, true)] },
    );

    const { events, error } = await h.run({
      recipeMode: true,
      recipeRestart: { stepId: "s2", reason: "user edited the input of step 2" },
      recipeState: (() => {
        let state = initRecipe("finish the request", [
          { id: "s1", title: "one", instruction: "do the first thing", successCriteria: "one is done" },
          { id: "s2", title: "two", instruction: "do the second thing", successCriteria: "two is done" },
          { id: "s3", title: "three", instruction: "do the third thing", successCriteria: "three is done" },
        ]);
        state = finishStep(state, 0, true);
        state = finishStep(state, 1, true);
        return state;
      })(),
    });
    assert.equal(error, undefined, `the run completed: ${error ?? ""}`);

    const restart = events.find((event): event is Extract<AgentEvent, { type: "recipe_restart" }> => event.type === "recipe_restart");
    assert.deepEqual(restart!.regeneratedSteps, ["s2", "s3"], "the restart reports the tail as regenerated");

    // The discarded step is restored and run, so the recipe does not shrink.
    const starts = events.filter((event): event is Extract<AgentEvent, { type: "plan_step" }> => event.type === "plan_step" && event.phase === "start");
    assert.deepEqual(starts.map((event) => event.id), ["s2", "s3"], "the discarded tail is restored and executed");
    assert.equal(h.toolRuns.get("file_write"), 2, "the reopened step and the restored step both run");

    const last = recipeUpdates(events)[recipeUpdates(events).length - 1]!;
    assert.deepEqual(last.steps.map((step) => step.id), ["s1", "s2", "s3"], "the recipe keeps its three steps");
    assert.equal(last.steps.filter((step) => step.status === "done").length, 3);
  });

  it("restores a restart's discarded tail when the regeneration round is unaffordable", async () => {
    // An exhausted compute budget skips the regeneration round entirely. That is
    // the same "no replacement proposed" outcome as an unparseable reply, so the
    // discarded tail has to be restored rather than lost. The run then stops on
    // the ceiling, which is what the budget is for.
    const h = harness(
      [
        { id: "s1", title: "one", instruction: "do the first thing", criteria: "one is done", tool: "file_write" },
        { id: "s2", title: "two", instruction: "do the second thing", criteria: "two is done", tool: "file_write" },
        { id: "s3", title: "three", instruction: "do the third thing", criteria: "three is done", tool: "file_write" },
      ],
      [{ name: "file_write", output: "written" }],
      { rounds: [recipeJson([], {}, [], 0, true)] },
    );

    // Burn the ceiling before the run starts, so every orchestration call is
    // refused and the restart cannot regenerate anything.
    const budget = createComputeBudget({ tokenLimit: 1_000_000 });
    consumeTokens(budget, 2_000_000, 0);

    const { events, error } = await h.run({
      recipeMode: true,
      budget,
      recipeRestart: { stepId: "s2", reason: "user edited the input of step 2" },
      recipeState: (() => {
        let state = initRecipe("finish the request", [
          { id: "s1", title: "one", instruction: "do the first thing", successCriteria: "one is done" },
          { id: "s2", title: "two", instruction: "do the second thing", successCriteria: "two is done" },
          { id: "s3", title: "three", instruction: "do the third thing", successCriteria: "three is done" },
        ]);
        state = finishStep(state, 0, true);
        state = finishStep(state, 1, true);
        return state;
      })(),
    });
    assert.match(error ?? "", /budget exhausted/i, "the run stops on the ceiling");

    const last = recipeUpdates(events)[recipeUpdates(events).length - 1]!;
    assert.deepEqual(
      last.steps.map((step) => `${step.id}:${step.status}`),
      ["s1:done", "s2:ready", "s3:proposed"],
      "the discarded tail is restored as pending work instead of being lost",
    );
  });

  it("emits the seed plan with the recipe's unique step ids", async () => {
    // A step id keys the run-graph canvas node, the frozen `plan` and the restart
    // target, and the recipe de-duplicates the planner's ids. The `plan` event
    // therefore has to carry the recipe's ids, not the planner's raw ones: a plan
    // whose two steps shared one id would put both steps on one canvas node and a
    // restart from the second step would target the first.
    const h = harness(
      [
        { id: "s1", title: "one", instruction: "do the first thing", criteria: "one is done", tool: "file_write" },
        { id: "s1", title: "two", instruction: "do the second thing", criteria: "two is done", tool: "file_write" },
      ],
      [{ name: "file_write", output: "written" }],
      keepGoingScript(recipeJson([], {}, [], 1, true)),
    );

    const { events, error } = await h.run({ recipeMode: true });
    assert.equal(error, undefined, `the run completed: ${error ?? ""}`);

    const planEvent = events.find((event): event is Extract<AgentEvent, { type: "plan" }> => event.type === "plan");
    assert.ok(planEvent, "the run emitted a plan");
    assert.deepEqual(planEvent.steps.map((step) => step.id), ["s1", "s1-2"], "the plan carries the recipe's unique ids");

    // Both steps really ran, so neither was collapsed onto the other's node.
    const starts = events.filter((event): event is Extract<AgentEvent, { type: "plan_step" }> => event.type === "plan_step" && event.phase === "start");
    assert.deepEqual(starts.map((event) => event.id), ["s1", "s1-2"], "both steps are executed as distinct steps");
  });

  it("does not consult the recipe planner when recipe mode is off", async () => {
    const h = harness(
      [{ id: "s1", title: "one", instruction: "do the first thing", criteria: "one is done", tool: "file_write" }],
      [{ name: "file_write", output: "written" }],
      keepGoingScript(recipeJson([], {}, [], 1, true), 1),
    );

    const { events, error } = await h.run({ recipeMode: false });
    assert.equal(error, undefined, `the run completed: ${error ?? ""}`);
    assert.equal(h.calls.recipe, 0, "the recipe planner is not used outside recipe mode");
    assert.equal(events.filter((event) => event.type === "recipe_update").length, 0);
  });
});
