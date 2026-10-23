/**
 * Neo N5: the long-horizon acceptance test.
 *
 * The N5 contract in the Neo plan names three properties of a 200-step synthetic
 * run:
 *
 *   1. the prompt never exceeds the model's context window;
 *   2. a needle fact recorded at an early step is still in the prompt at step 180
 *      (the compressor-only path loses it, because compaction folds the whole
 *      middle away and the exact string is gone);
 *   3. token use per step stays flat instead of growing with the step count.
 *
 * This drives the production `runAgent` loop with a scripted fake client (no
 * model, no network) and a real tool registry, so the selector is exercised
 * through the same per-step wiring the app uses. Each step appends a large
 * observation to the transcript, which is exactly the growth the selector is
 * meant to stop.
 *
 * The control arm disables the selector but leaves the compressor on, so the
 * same fixture shows what the compressor alone does: it compacts (property 1
 * survives) and loses the needle (property 2 fails).
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadConfig, type Config } from "../../config.js";
import { runAgent } from "../loop.js";
import { ContextSelector } from "../contextSelector.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { AgentEvent } from "../events.js";
import type { ChatMessage, ChatOptions, ChatResult, OllamaClient, OllamaToolCall } from "../../ollama.js";

/** How many steps the synthetic long-horizon run takes. */
const STEPS = 200;
/** The step at which the needle fact is recorded. */
const NEEDLE_STEP = 5;
/** The step at which the needle must still be retrievable. */
const RECALL_STEP = 180;
/** The model's context window for the fixture.
 *
 * It has to be larger than the run's own system prompt (the real prompt for this
 * model is ~32k tokens). A smaller window makes the compressor's ratio threshold
 * degenerate, because the window minus its 20k safety buffer is negative, and
 * the selector's protected lead alone exceeds the window. The window is the
 * model's limit, not a tuning knob, so the fixture uses a realistic value and
 * measures the selector against it.
 */
const WINDOW = 65536;
/** The compressor's trigger for this fixture (30% of the window). */
const COMPRESSOR_TRIGGER = 19660;

/** The needle: a short, distinctive string no other artefact contains. */
const NEEDLE = "LEDGER-NEEDLE-7f3a: the Q3 ledger closing balance is 41,283.61 EUR";

/** Large filler appended each step, so the transcript grows if nothing bounds it. */
const FILLER = "observation filler ".repeat(40);

/** Rough token count of a transcript, matching the harness's own estimate. */
function transcriptTokens(messages: readonly ChatMessage[]): number {
  const chars = messages
    .map((m) => {
      const body = typeof m.content === "string" ? m.content : "";
      const calls = (m.tool_calls ?? []).reduce(
        (sum, call) => sum + (call.function?.name ?? "").length + JSON.stringify(call.function?.arguments ?? {}).length,
        0,
      );
      return body.length + calls;
    })
    .reduce((a, b) => a + b, 0);
  return Math.ceil(chars / 4);
}

/** One executor step's prompt, sampled from the fake client's own input. */
interface PromptSample {
  step: number;
  tokens: number;
  /** True when the compressor's summarizer answered instead of the executor. */
  summarizer: boolean;
}

/** The tool that appends one observation to the transcript and records its text. */
function observationTool(onResult: (step: number, content: string) => void): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "file_read",
    description: "read an observation file",
    parameters: {},
    run: async (args: Record<string, unknown>) => {
      const step = Number(args.step ?? 0);
      const content = step === NEEDLE_STEP ? `${NEEDLE}\n${FILLER}` : `${FILLER} step ${step}`;
      onResult(step, content);
      return { ok: true, content };
    },
  });
  return registry;
}

/** A scripted client that keeps issuing the observation tool until step N. */
function scriptedClient(samples: PromptSample[], needleSeenAt: number[], untilStep: number): OllamaClient {
  let call = 0;
  const ollama = {
    async chat(options: ChatOptions): Promise<ChatResult> {
      const messages = options.messages ?? [];
      const body = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      // The compressor's summarizer turn carries a different system prompt, so
      // it must be answered separately: it must not consume an executor step,
      // and its output is what the control arm loses the needle to.
      if (body.includes("context-compaction summarizer")) {
        samples.push({ step: 0, tokens: transcriptTokens(messages), summarizer: true });
        return {
          content: "compacted observation filler observations",
          model: "fixture-model",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 5, durationMs: 1 },
        };
      }
      call += 1;
      // The needle is judged on the prompt this step actually received, not on
      // the transcript the loop happens to return.
      if (body.includes("LEDGER-NEEDLE")) needleSeenAt.push(call);
      samples.push({ step: call, tokens: transcriptTokens(messages), summarizer: false });
      if (call > untilStep) {
        return {
          content: "done",
          model: "fixture-model",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 10, durationMs: 1 },
        };
      }
      const toolCalls: OllamaToolCall[] = [
        { function: { name: "file_read", arguments: { step: call } } },
      ];
      return {
        content: "",
        model: "fixture-model",
        toolCalls,
        usage: { promptTokens: 1, completionTokens: 10, durationMs: 1 },
      };
    },
    listModels: async () => [],
  } as unknown as OllamaClient;
  return ollama;
}

function fixtureCfg(workspace: string, selectorEnabled: boolean): Config {
  const cfg = loadConfig();
  cfg.workspace = workspace;
  cfg.model = "qwen2.5:14b";
  cfg.fallbackModel = cfg.model;
  // The compressor is the pre-N5 mechanism; the control arm keeps it so the
  // comparison is selector-on vs selector-off, not selector vs nothing.
  //
  // The window must be large enough for the run's own system prompt. The real
  // system prompt is far larger than this fixture's window, so a small window
  // makes the compressor's ratio threshold degenerate (the window minus its
  // 20k safety buffer is negative, so it fires on every step) and the
  // selector's protected lead alone exceeds the window. Raising the window to a
  // realistic size keeps both mechanisms meaningful.
  cfg.compression = {
    ...cfg.compression,
    enabled: true,
    thresholdPercent: 0.3,
    protectLead: 2,
    protectTail: 2,
    contextWindow: { ...cfg.compression.contextWindow, "qwen2.5": WINDOW },
  };
  // The selector's own cap. It must be below the compressor's trigger: the
  // selector is meant to keep the transcript bounded *before* the compressor
  // has to fire, so a cap at or above the trigger would leave the compressor
  // doing the work and the fixture would prove nothing.
  cfg.contextSelector = {
    enabled: selectorEnabled,
    maxContextTokens: 4000,
    activateAfterSteps: 4,
    protectLead: 2,
    protectTail: 2,
    storeBound: 1024,
  };
  cfg.agent = { ...cfg.agent, maxSteps: STEPS + 1 };
  return cfg;
}

interface ArmResult {
  samples: PromptSample[];
  /** Executor steps whose prompt still contained the needle. */
  needleSeenAt: number[];
  steps: number;
  /** The compressor folded the middle at least once. */
  compacted: boolean;
  /** Every `context_selected` event the loop emitted, in order. */
  selected: Extract<AgentEvent, { type: "context_selected" }>[];
}

/** Run one arm of the comparison and collect the evidence the contract names. */
async function runArm(selectorEnabled: boolean): Promise<ArmResult> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "neo-n5-long-"));
  const samples: PromptSample[] = [];
  const needleSeenAt: number[] = [];
  const events: AgentEvent[] = [];

  const tools = observationTool(() => {});
  const cfg = fixtureCfg(workspace, selectorEnabled);
  const selector = selectorEnabled ? new ContextSelector({ config: cfg.contextSelector }) : undefined;
  const client = scriptedClient(samples, needleSeenAt, STEPS);

  const result = await runAgent({
    cfg,
    ollama: client,
    tools,
    prompt: "Record the ledger closing balance across a long horizon.",
    emit: (event) => events.push(event),
    maxSteps: STEPS + 1,
    suppressFinal: true,
    contextSelector: selector,
    // A silent run nags about a stale task list every eight steps. The selector
    // folds those reminders, but the fixture must not rely on that to stay
    // bounded, so the run is told the task list is fresh enough not to nag.
    reminders: { todoStaleAfter: 10_000 },
  });

  fs.rmSync(workspace, { recursive: true, force: true });
  return {
    samples,
    needleSeenAt,
    steps: result.steps,
    compacted: events.some((e) => e.type === "compaction"),
    selected: events.filter((e): e is Extract<AgentEvent, { type: "context_selected" }> => e.type === "context_selected"),
  };
}

/** Mean of a list, which is where flatness is judged. */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Executor-step samples only (the summarizer's own turn is excluded). */
function executorSamples(arm: ArmResult): PromptSample[] {
  return arm.samples.filter((s) => !s.summarizer);
}

describe("N5 long-horizon selector acceptance", () => {
  it("keeps the prompt bounded across 200 steps", { timeout: 120_000 }, async () => {
    const arm = await runArm(true);
    assert.ok(arm.steps >= RECALL_STEP, `the run reached step ${RECALL_STEP} (got ${arm.steps})`);
    const tail = executorSamples(arm).slice(-10);
    assert.ok(tail.length > 0, "the tail was sampled");
    for (const sample of tail) {
      assert.ok(sample.tokens <= WINDOW, `step ${sample.step} used ${sample.tokens} tokens (window ${WINDOW})`);
    }
  });

  it("keeps per-step token use flat instead of growing", { timeout: 120_000 }, async () => {
    const arm = await runArm(true);
    const samples = executorSamples(arm);
    assert.ok(samples.length >= 50, `enough steps to judge flatness (got ${samples.length})`);
    const head = mean(samples.slice(10, 30).map((s) => s.tokens));
    const tail = mean(samples.slice(-20).map((s) => s.tokens));
    assert.ok(
      Math.abs(tail - head) <= head * 0.2,
      `tail tokens ${tail.toFixed(0)} drifted more than 20% from head ${head.toFixed(0)}`,
    );
  });

  it("retrieves the needle recorded at step 5 at step 180", { timeout: 120_000 }, async () => {
    const arm = await runArm(true);
    // The needle is recorded as an artefact at step 5 and must still be in the
    // bounded view the model receives at the recall step.
    assert.ok(
      arm.needleSeenAt.includes(RECALL_STEP),
      `the needle was not in the prompt at step ${RECALL_STEP} (present at ${arm.needleSeenAt.join(",") || "no step"})`,
    );
  });

  it("the compressor alone cannot hold the same contract", { timeout: 120_000 }, async () => {
    const arm = await runArm(false);
    const samples = executorSamples(arm);
    assert.ok(samples.length >= 50, `enough steps (got ${samples.length})`);
    assert.ok(arm.compacted, "the compressor fired in the control arm");
    // Compaction fires (property 1 survives) but the needle's exact string is
    // folded away, which is the failure mode the selector removes.
    assert.ok(
      !arm.needleSeenAt.includes(RECALL_STEP),
      "with the selector disabled the compressor folds the needle away",
    );
  });

  // The wiring itself is asserted here rather than assumed: the loop only emits
  // `context_selected` when the selector actually re-shaped the transcript, so a
  // regression that skips `apply` (or silently stops emitting) is caught even
  // though the three properties above could still pass on their own.
  it("emits context_selected each step it re-shapes, and never when disabled", { timeout: 120_000 }, async () => {
    const on = await runArm(true);
    assert.ok(on.selected.length > 0, "the selector reported at least one applied step");
    for (const event of on.selected) {
      // It must start after the activation step, not from step 1.
      assert.ok(event.step > 4, `context_selected fired at step ${event.step}, before activation`);
      assert.ok(event.step <= on.steps, `context_selected step ${event.step} exceeds the run's ${on.steps} steps`);
      // A real selection carries a token count and at least one artefact.
      assert.ok(event.tokens > 0, `context_selected at step ${event.step} reported ${event.tokens} tokens`);
      assert.ok(event.artefacts > 0, `context_selected at step ${event.step} reported ${event.artefacts} artefacts`);
      assert.ok(event.reason.length > 0, `context_selected at step ${event.step} had an empty reason`);
    }
    // The control arm must stay silent: no selector, no signal.
    const off = await runArm(false);
    assert.equal(off.selected.length, 0, "a disabled selector emitted context_selected");
  });
});
