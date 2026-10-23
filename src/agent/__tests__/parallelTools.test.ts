/**
 * C15 unit tests: parallel execution of independent read-only tool calls.
 *
 * Claude Code runs the read-only calls from a single assistant turn
 * concurrently (capped at 8) while writes stay serial. These tests pin the two
 * behaviours the parity work depends on:
 *   1. N reads finish in roughly max(t), not sum(t) — they really overlap.
 *   2. The tool results stay in the assistant's tool_call order, never in
 *      completion order.
 * The model is replaced by a deterministic fake; no network or real model is
 * contacted.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import { runAgent } from "../loop.js";
import { ToolRegistry, str, type Tool } from "../../tools/registry.js";
import type { Config } from "../../config.js";
import type { ChatResult, OllamaClient, OllamaToolCall } from "../../ollama.js";
import type { Emit } from "../events.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "test-model",
    fallbackModel: "test-fallback",
    ollamaUrl: "http://localhost:11434",
    server: { host: "127.0.0.1", port: 3939 },
    agent: { maxSteps: 10, temperature: 0.2, requestTimeoutMs: 600000 },
    workspace: "/tmp/workspace",
    policy: {
      networkEnabled: true,
      allowOutsideWorkspaceRead: true,
      denyCommandPatterns: [],
      allowCommandPatterns: [],
      maxCommandSeconds: 180,
      sandboxMode: "workspace-write",
    },
    browser: { channel: "msedge", headless: false, viewport: { width: 1280, height: 800 } },
    computerUse: { enabled: false, screenshotDir: "/tmp/screenshots" },
    memory: { enabled: false, model: "", file: "", autoStore: false, recallTop: 0, minScore: 0, maxEntries: 0, dedupeThreshold: 0 },
    screen: { enabled: false, fps: 1, quality: 60, maxWidth: 1280 },
    vision: { enabled: false, maxImagesPerStep: 0 },
    selfImprove: { enabled: false, reviewEvery: 1, model: "", maxSteps: 1, writeApproval: false },
    evaluation: { enabled: false, intervalMinutes: 360, suite: "core", critique: false, keepRuns: 0, transcripts: false },
    selfPlay: { maxCases: 0 },
    orchestrator: { enabled: false, plannerModel: "", verifierModel: "", maxPlanSteps: 1, maxStepsPerWorker: 1, maxRevisionsPerStep: 1, maxReplans: 1, verifyFinal: false },
    mcpServers: {},
    compression: { enabled: false, thresholdPercent: 0.5, protectLead: 3, protectTail: 20, targetRatio: 0.2, bufferTokens: 20000, reattachFiles: 5, reattachFileChars: 4000, criticalThresholdPercent: 0.95, recentTurnsToKeep: 10, minTurnsToKeep: 2, emergencyToolResultMaxChars: 4000, model: "", contextWindow: {} },
    sessionLog: { enabled: false },
    subagent: { maxDepth: 2, maxConcurrentChildren: 4 },
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Probe {
  active: number;
  maxActive: number;
}

/** A read-only tool that sleeps `delay` then returns `content`, tracking overlap. */
function fixedReadTool(name: string, delay: number, content: string, probe: Probe): Tool {
  return {
    name,
    description: "read-only test tool",
    parameters: { type: "object", properties: {} },
    async run() {
      probe.active++;
      probe.maxActive = Math.max(probe.maxActive, probe.active);
      try {
        await sleep(delay);
      } finally {
        probe.active--;
      }
      return { ok: true, content };
    },
  };
}

/** A single `file_read` tool whose result depends on the requested path. */
function pathReadTool(delay: number, probe: Probe): Tool {
  return {
    name: "file_read",
    description: "read-only test tool",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    async run(args) {
      const path = str(args, "path", "");
      probe.active++;
      probe.maxActive = Math.max(probe.maxActive, probe.active);
      try {
        await sleep(delay);
      } finally {
        probe.active--;
      }
      return { ok: true, content: `read-${path}` };
    },
  };
}

function readOnlyRegistry(tools: Tool[]): ToolRegistry {
  const base = new ToolRegistry();
  base.registerAll(tools);
  // forAllowlist marks the copy read-only, so the loop skips lifecycle hooks.
  return base.forAllowlist(base.names());
}

/** Fake model: first call emits `calls`, every later call returns a final answer. */
function fakeOllama(calls: OllamaToolCall[]): OllamaClient {
  let count = 0;
  return {
    async chat(): Promise<ChatResult> {
      count++;
      if (count === 1) {
        return { content: "", toolCalls: calls, model: "test-model", usage: { promptTokens: 1, completionTokens: 1, durationMs: 0 } };
      }
      return { content: "final answer", toolCalls: [], model: "test-model", usage: { promptTokens: 1, completionTokens: 1, durationMs: 0 } };
    },
  } as unknown as OllamaClient;
}

function toolContents(messages: Array<{ role: string; content: string }>): string[] {
  return messages.filter((m) => m.role === "tool").map((m) => m.content);
}

describe("parallel read-only tool execution", () => {
  it("runs three independent reads concurrently and preserves their order", async () => {
    const delays = [150, 300, 450];
    const names = ["file_read", "file_list", "file_stat"];
    const probe: Probe = { active: 0, maxActive: 0 };
    const tools = readOnlyRegistry(names.map((name, i) => fixedReadTool(name, delays[i]!, `read-${i}`, probe)));
    const calls = names.map((name, i) => ({ function: { name, arguments: { path: `p${i}` } } }));
    const emit = (() => {}) as Emit;
    const ctx = { cfg: makeConfig(), workspace: "/tmp/workspace", emit };

    // Serial baseline: the same three reads executed one after another. Measured
    // in-process so timer inflation from machine load cancels out of the ratio.
    const serialStart = Date.now();
    for (let i = 0; i < names.length; i++) {
      await tools.exec(names[i]!, { path: `p${i}` }, ctx);
    }
    const serialMs = Date.now() - serialStart;

    probe.active = 0;
    probe.maxActive = 0;
    const t0 = Date.now();
    const result = await runAgent({ cfg: makeConfig(), ollama: fakeOllama(calls), tools, emit, prompt: "read three files", suppressFinal: true, systemOverride: "test system" });
    const parallelMs = Date.now() - t0;

    const max = Math.max(...delays);
    // All three must genuinely overlap: peak concurrency 3, a wall time near the
    // slowest call, and far below the serial baseline.
    assert.equal(probe.maxActive, 3, `expected 3 concurrent reads, saw peak ${probe.maxActive}`);
    assert.ok(parallelMs >= max - 40, `elapsed ${parallelMs}ms should be at least ~max(${max}ms)`);
    assert.ok(parallelMs < serialMs * 0.7, `parallel ${parallelMs}ms should be well under serial baseline ${serialMs}ms`);

    // Order is preserved: results follow the assistant's tool_call order.
    assert.deepEqual(toolContents(result.messages), ["read-0", "read-1", "read-2"]);
  });

  it("caps a large read batch at eight concurrent calls and keeps order", async () => {
    const count = 12;
    const delay = 60;
    const probe: Probe = { active: 0, maxActive: 0 };
    const tools = readOnlyRegistry([pathReadTool(delay, probe)]);
    const calls = Array.from({ length: count }, (_, i) => ({ function: { name: "file_read", arguments: { path: `p${i}` } } }));
    const emit = (() => {}) as Emit;
    const ctx = { cfg: makeConfig(), workspace: "/tmp/workspace", emit };

    // Serial baseline for the same twelve reads.
    const serialStart = Date.now();
    for (let i = 0; i < count; i++) {
      await tools.exec("file_read", { path: `p${i}` }, ctx);
    }
    const serialMs = Date.now() - serialStart;

    probe.active = 0;
    probe.maxActive = 0;
    const t0 = Date.now();
    const result = await runAgent({ cfg: makeConfig(), ollama: fakeOllama(calls), tools, emit, prompt: "read many files", suppressFinal: true, systemOverride: "test system" });
    const parallelMs = Date.now() - t0;

    assert.ok(probe.maxActive > 1, `expected overlapping reads, saw peak ${probe.maxActive}`);
    assert.ok(probe.maxActive <= 8, `concurrency must stay within the limit of 8, saw peak ${probe.maxActive}`);
    // 12 reads at 8-wide concurrency need at least two waves.
    assert.ok(parallelMs >= delay - 20, `elapsed ${parallelMs}ms should cover at least one wave`);
    assert.ok(parallelMs < serialMs * 0.6, `parallel ${parallelMs}ms should be well under serial baseline ${serialMs}ms`);
    assert.deepEqual(toolContents(result.messages), Array.from({ length: count }, (_, i) => `read-p${i}`));
  });
});
