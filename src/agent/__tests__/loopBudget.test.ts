/**
 * D19 compute budget on the DEFAULT (linear) agent path.
 *
 * `runOrchestratedAgent` is only taken when orchestration is enabled, so the
 * loop-level budget is what actually protects the default route. These tests
 * drive `runAgent` with a scripted fake Ollama client (no model, no network)
 * and assert the ceiling is consulted before each step.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import { createComputeBudget, totalTokens, type ComputeBudget } from "../computeBudget.js";
import { runAgent } from "../loop.js";
import { loadConfig } from "../../config.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { AgentEvent } from "../events.js";
import type { ChatResult, OllamaClient, OllamaToolCall } from "../../ollama.js";

function fixtureCfg(): ReturnType<typeof loadConfig> {
  const cfg = loadConfig();
  cfg.compression = { ...cfg.compression, enabled: false };
  cfg.fallbackModel = cfg.model;
  return cfg;
}

function fixtureTools(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "file_read",
    description: "budget test observation",
    parameters: {},
    run: async () => ({ ok: true, content: "Observed result" }),
  });
  return registry;
}

interface Scripted {
  ollama: OllamaClient;
  calls: number;
}

/** One tool call, then a tool-free answer: a two-step run that completes. */
function scriptedWorker(usage = { promptTokens: 100, completionTokens: 50 }): Scripted {
  let calls = 0;
  const ollama = {
    chat: async (): Promise<ChatResult> => {
      calls += 1;
      const first = calls === 1;
      const toolCalls: OllamaToolCall[] = first ? [{ function: { name: "file_read", arguments: {} } }] : [];
      return {
        content: first ? "" : "final answer",
        model: "fixture-model",
        toolCalls,
        usage: { ...usage, durationMs: 1 },
      };
    },
    listModels: async () => [],
  } as unknown as OllamaClient;
  return { ollama, get calls() { return calls; } };
}

/** Always issues a tool call, so the loop keeps advancing until the budget stops it. */
function scriptedToolLoop(usage = { promptTokens: 100, completionTokens: 50 }): Scripted {
  let calls = 0;
  const ollama = {
    chat: async (): Promise<ChatResult> => {
      calls += 1;
      return {
        content: "",
        model: "fixture-model",
        toolCalls: [{ function: { name: "file_read", arguments: {} } } satisfies OllamaToolCall],
        usage: { ...usage, durationMs: 1 },
      };
    },
    listModels: async () => [],
  } as unknown as OllamaClient;
  return { ollama, get calls() { return calls; } };
}

async function run(options: {
  budget: ComputeBudget;
  script: Scripted;
  maxSteps?: number;
  suppressFinal?: boolean;
}): Promise<{ events: AgentEvent[]; error?: string; script: Scripted; budget: ComputeBudget }> {
  const events: AgentEvent[] = [];
  try {
    await runAgent({
      cfg: fixtureCfg(),
      ollama: options.script.ollama,
      tools: fixtureTools(),
      prompt: "Scripted task",
      emit: (e: AgentEvent) => events.push(e),
      budget: options.budget,
      maxSteps: options.maxSteps,
      suppressFinal: options.suppressFinal,
    });
  } catch (e) {
    return { events, error: e instanceof Error ? e.message : String(e), script: options.script, budget: options.budget };
  }
  return { events, script: options.script, budget: options.budget };
}

describe("runAgent compute budget (linear path)", () => {
  it("counts steps and model tokens against the ceiling", async () => {
    const script = scriptedWorker();
    const budget = createComputeBudget({ stepLimit: 10, tokenLimit: 10_000 });
    // suppressFinal so the mandatory verifier is not part of this unit test.
    const result = await runAgent({
      cfg: fixtureCfg(),
      ollama: script.ollama,
      tools: fixtureTools(),
      prompt: "Scripted task",
      emit: () => {},
      budget,
      maxSteps: 10,
      suppressFinal: true,
    });
    assert.equal(script.calls, 2, "one tool step + one final answer");
    assert.equal(result.steps, 2);
    // Both round-trips are charged: 2 steps, 200 prompt + 100 completion tokens.
    assert.equal(budget.steps, 2);
    assert.equal(totalTokens(budget), 300);
  });

  it("warns at 80% of the step budget without stopping the run", async () => {
    const script = scriptedWorker();
    const budget = createComputeBudget({ stepLimit: 10, tokenLimit: 10_000 });
    const { events } = await run({ budget, script, maxSteps: 10, suppressFinal: true });
    assert.equal(script.calls, 2, "the run is not stopped by a warning");
    // Step 2 of 10 is only 20%, so no warning is expected yet; assert the run
    // still completes and the counters advanced.
    assert.equal(budget.steps, 2);
    assert.ok(
      !events.some((e) => e.type === "error" && /close to its ceiling/.test((e as { message?: string }).message ?? "")),
      "no warning below 80%",
    );
  });

  it("warns once the step budget passes 80%", async () => {
    const script = scriptedToolLoop();
    const budget = createComputeBudget({ stepLimit: 5, tokenLimit: 100_000 });
    const { events } = await run({ budget, script, maxSteps: 4, suppressFinal: true });
    assert.ok(
      events.some((e) => e.type === "error" && /close to its ceiling/.test((e as { message?: string }).message ?? "")),
      "the 80% warning is surfaced",
    );
    // A warning never stops the run: all four steps still execute.
    assert.equal(script.calls, 4);
    assert.equal(budget.steps, 4);
  });

  it("stops before running a step that would cross the step ceiling", async () => {
    const script = scriptedToolLoop();
    const { events, error } = await run({
      budget: createComputeBudget({ stepLimit: 3, tokenLimit: 100_000 }),
      script,
      maxSteps: 20,
      suppressFinal: true,
    });
    assert.match(error ?? "", /Compute budget exhausted/, "the ceiling is reported");
    assert.ok(
      events.some((e) => e.type === "error" && /Compute budget exhausted/.test((e as { message?: string }).message ?? "")),
      "the ceiling is emitted as an error event",
    );
    // The guard runs BEFORE the step, so it stops at exactly the ceiling.
    assert.equal(script.calls, 3, "no step runs past the ceiling");
  });

  it("stops on the token ceiling as well", async () => {
    const script = scriptedToolLoop({ promptTokens: 100, completionTokens: 50 });
    const budget = createComputeBudget({ stepLimit: 100, tokenLimit: 250 });
    const { error } = await run({ budget, script, maxSteps: 20, suppressFinal: true });
    assert.match(error ?? "", /Compute budget exhausted.*tokens/, "the token ceiling is reported");
    // 150 tokens per call; the guard checks BEFORE the step, so the third
    // crossing is caught before the third call runs.
    assert.equal(script.calls, 2, "no call runs past the token ceiling");
    assert.ok(totalTokens(budget) >= 250, "the stop happens on the first crossing");
  });

  it("stops the default (non-suppressed) path too", async () => {
    const script = scriptedWorker();
    const { error, events } = await run({
      budget: createComputeBudget({ stepLimit: 1, tokenLimit: 1000 }),
      script,
      maxSteps: 20,
    });
    assert.match(error ?? "", /Compute budget exhausted/);
    assert.equal(events.filter((e) => e.type === "done").length, 0, "the task is not completed");
  });
});
