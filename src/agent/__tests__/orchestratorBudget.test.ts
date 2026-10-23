// Must come before any import that evaluates `config.js`: `runOrchestratedAgent`
// reads `DATA_DIR` at module scope, and `loadConfig()` mkdirs `data/`, `evals/`
// and `workspace/` under whatever root it resolves to.
import "../../test/isolation.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createComputeBudget, totalTokens } from "../computeBudget.js";
import { loadConfig } from "../../config.js";
import { ToolRegistry } from "../../tools/registry.js";
import { runOrchestratedAgent } from "../orchestrator.js";
import type { AgentEvent, VerdictInfo } from "../events.js";
import type { ChatOptions, ChatResult, OllamaClient, OllamaToolCall } from "../../ollama.js";
import type { CooldownStore, FailoverProvider } from "../../llm/failover.js";

/**
 * D19: the session compute budget must be enforced on the orchestrated path.
 * A run that crosses the ceiling stops instead of burning unlimited work, and
 * the orchestrator must not replan (a replan would only burn more of an already
 * exhausted budget). Fixtures drive a mock Ollama client, so no model or
 * external API is contacted.
 */

type Role = "planner" | "critic" | "final" | "worker";

const VERDICT_PASS: VerdictInfo = { verdict: "pass", reason: "fixture", fixes: [] };
const VERDICT_REVISE: VerdictInfo = {
  verdict: "revise",
  reason: "fixture needs a fix",
  fixes: ["redo the step"],
};

function roleOf(messages: { role: string; content: string }[]): Role {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  if (system.includes("planner role")) return "planner";
  if (system.includes("COMPLETED task as a whole")) return "final";
  if (system.includes("ONE executed plan step")) return "critic";
  return "worker";
}

interface StepScript {
  title: string;
  instruction: string;
  successCriteria: string;
  /** "revise" makes the verifier reject the first attempt so a second runs. */
  outcome: "pass" | "revise";
}

interface ScriptedRun {
  client: OllamaClient;
  calls: number;
  verdicts: VerdictInfo[];
  stepRequests: number[];
}

/**
 * Fake Ollama backend that walks a scripted plan. The worker always returns a
 * tool-free text answer, so the run advances one step per attempt. The attempt
 * counter is local to the current step, so a revision never leaks into the next.
 */
function scriptedClient(steps: StepScript[]): ScriptedRun {
  let calls = 0;
  const verdicts: VerdictInfo[] = [];
  const stepRequests: number[] = [];
  let stepIndex = 0;
  let attempt = 0;

  const chat = async (opts: ChatOptions): Promise<ChatResult> => {
    calls += 1;
    const role = roleOf(opts.messages);
    const step = steps[stepIndex] ?? steps[steps.length - 1]!;
    let content = "done";
    let toolCalls: OllamaToolCall[] = [];

    if (role === "planner") {
      content = JSON.stringify({
        goal: "scripted goal",
        trivial: false,
        steps: steps.map((s, i) => ({
          id: `s${i + 1}`,
          title: s.title,
          instruction: s.instruction,
          successCriteria: s.successCriteria,
        })),
      });
    } else if (role === "final") {
      content = JSON.stringify(VERDICT_PASS);
      verdicts.push(VERDICT_PASS);
    } else if (role === "critic") {
      stepRequests.push(stepIndex);
      // The first critique honours the script; a later one always passes so the
      // run can advance within the step budget.
      const verdict = step.outcome === "revise" && attempt === 0 ? VERDICT_REVISE : VERDICT_PASS;
      verdicts.push(verdict);
      content = JSON.stringify(verdict);
      attempt += 1;
      if (verdict.verdict !== "revise") {
        stepIndex += 1;
        attempt = 0;
      }
    }

    return {
      content,
      toolCalls,
      model: "fixture-model",
      usage: { promptTokens: 100, completionTokens: 50, durationMs: 1 },
    };
  };

  return {
    client: { chat, listModels: async () => [] } as unknown as OllamaClient,
    get calls() {
      return calls;
    },
    verdicts,
    stepRequests,
  };
}

function fixtureTools(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "file_read",
    description: "orchestrator budget test observation",
    parameters: {},
    run: async () => ({ ok: true, content: "Observed result" }),
  });
  return registry;
}

function fixtureCfg(): ReturnType<typeof loadConfig> {
  const cfg = loadConfig();
  cfg.workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-orch-budget-"));
  cfg.fallbackModel = cfg.model;
  cfg.orchestrator.maxStepsPerWorker = 1;
  cfg.orchestrator.maxReplans = 5;
  cfg.orchestrator.maxRevisionsPerStep = 1;
  // Keep the suite hermetic: with an empty failover chain the coding router has
  // no coder to pick, so a coding turn (a revision prompt names the fix and the
  // files involved) is answered by the injected fake client instead of escaping
  // to a real provider over the network.
  cfg.coding = { enabled: true, chain: [], logEdits: false };
  cfg.failover = { providers: [] };
  return cfg;
}

/** In-memory cooldown store: a failing provider must not leave a process-wide
 *  mark behind, and routing must not touch the real data folder. */
function memoryStore(): CooldownStore {
  const map = new Map<string, { expiresAt: number; backoffCount: number }>();
  return {
    get: (key) => map.get(key),
    set: (key, entry) => void map.set(key, entry),
    entries: () => [...map.entries()],
    save: () => {},
  };
}

async function run(options: {
  budget: { stepLimit?: number; tokenLimit?: number };
  steps: StepScript[];
}): Promise<{ events: AgentEvent[]; script: ScriptedRun; error?: string }> {
  const cfg = fixtureCfg();
  const script = scriptedClient(options.steps);
  const budget = createComputeBudget(options.budget);
  const events: AgentEvent[] = [];

  try {
    await runOrchestratedAgent({
      cfg,
      ollama: script.client,
      tools: fixtureTools(),
      prompt: "Scripted task",
      emit: (e: AgentEvent) => events.push(e),
      // Routing seams: no real provider, no real cooldown store, no real
      // environment. The revision prompt trips the coding heuristic, so the
      // worker would otherwise be routed to the network.
      createProviderClient: (_provider: FailoverProvider) => script.client as never,
      cooldownStore: memoryStore(),
      env: {} as Record<string, string | undefined>,
      onCodingRoute: () => {},
      budget,
    });
  } catch (e) {
    // D19: an exhausted budget ends the run with a reportable error.
    return { events, script, error: e instanceof Error ? e.message : String(e) };
  }
  return { events, script };
}

function manySteps(count: number, outcome: "pass" | "revise" = "pass"): StepScript[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `step ${i + 1}`,
    instruction: "advance",
    successCriteria: "advanced",
    outcome,
  }));
}

describe("orchestrator compute budget", () => {
  it("counts planner, worker, and verifier calls against the token ceiling", async () => {
    const { script, events } = await run({
      budget: { stepLimit: 100, tokenLimit: 1000 },
      steps: manySteps(1),
    });
    assert.equal(events.filter((e) => e.type === "done").length, 1, "the run completes");
    // The last model round-trip is the final verification; the whole run is charged.
    assert.ok(script.calls >= 4, `expected planner + worker + critic + final, got ${script.calls}`);
  });

  it("stops the run at the step ceiling instead of burning unlimited work", async () => {
    const { script, events, error } = await run({
      budget: { stepLimit: 4 },
      steps: manySteps(10),
    });
    assert.match(error ?? "", /Compute budget exhausted/, "the ceiling is reported");
    // Bounded: the run stops rather than consuming every scripted step.
    assert.ok(script.stepRequests.length <= 4, `expected <= 4 steps, got ${script.stepRequests.length}`);
  });

  it("stops before spending the whole token ceiling", async () => {
    const { script, error } = await run({
      budget: { stepLimit: 100, tokenLimit: 250 },
      steps: manySteps(10),
    });
    assert.match(error ?? "", /Compute budget exhausted.*tokens/, "the token ceiling is reported");
    // The run stops near the ceiling; it never burns the whole scripted plan.
    assert.ok(script.stepRequests.length < 10, `unexpectedly consumed the whole plan: ${script.stepRequests.length}`);
  });

  it("does not replan after the budget is exhausted", async () => {
    const { events, script } = await run({
      budget: { stepLimit: 3 },
      steps: manySteps(6),
    });
    assert.equal(events.filter((e) => e.type === "replan").length, 0, "no replan on an exhausted budget");
    // The budget runs out before the final verification, so every completed
    // worker step got exactly one verifier critique and nothing more.
    assert.equal(script.verdicts.length, script.stepRequests.length, "no final verdict once the budget is spent");
  });

  it("counts a verifier revision as real work", async () => {
    const { script } = await run({
      budget: { stepLimit: 100, tokenLimit: 1000 },
      steps: [{ title: "do it", instruction: "do it", successCriteria: "done", outcome: "revise" }],
    });
    // worker + critic + revise worker + critic = 4 round-trips for one step.
    assert.equal(script.stepRequests.length, 2, "the step is critiqued twice (attempt + revision)");
    assert.ok(script.calls >= 5, `expected planner + 4 step calls + final, got ${script.calls}`);
  });

  it("keeps a tiny budget from completing the task", async () => {
    const { events, error } = await run({
      budget: { stepLimit: 1, tokenLimit: 1 },
      steps: manySteps(1),
    });
    assert.match(error ?? "", /Compute budget exhausted/);
    assert.equal(events.filter((e) => e.type === "done").length, 0, "the task is not completed");
  });
});
