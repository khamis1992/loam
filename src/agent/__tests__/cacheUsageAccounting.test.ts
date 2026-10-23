/**
 * Cache-accounting regression tests (J10 follow-up).
 *
 * Prompt-cache telemetry was silently dropped at every stage that re-sums usage
 * (verifier inspection, contract audit, orchestration checkpoints), so a
 * verified run reported fewer reused tokens than the requests actually read.
 * These tests pin the two invariants the fix depends on:
 *   1. A reported `cachedTokens` survives the real loop -> verifyFinal path.
 *   2. A provider that reports no telemetry leaves `cachedTokens` undefined,
 *      never a fabricated 0 that clients would read as "nothing reused".
 * The model is replaced by a deterministic scripted fake; no network is used.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runAgent } from "../loop.js";
import { ToolRegistry } from "../../tools/registry.js";
import { addUsage, sumUsage } from "../usageAccounting.js";
import type { Config } from "../../config.js";
import type { ChatResult, OllamaClient } from "../../ollama.js";
import type { Emit, Usage } from "../events.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "test-model",
    fallbackModel: "test-fallback",
    ollamaUrl: "http://localhost:11434",
    server: { host: "127.0.0.1", port: 3939 },
    agent: { maxSteps: 10, temperature: 0.2, requestTimeoutMs: 600000 },
    workspace: fs.mkdtempSync(path.join(os.tmpdir(), "loam-cache-")),
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
    skills: { autoSuggest: false, suggestModel: "" },
    ...overrides,
  };
}

/** Replays queued chat results in order and fails loudly on an extra call. */
function scriptedOllama(results: ChatResult[]): OllamaClient {
  let index = 0;
  return {
    async chat(): Promise<ChatResult> {
      const result = results[index++];
      if (!result) throw new Error(`unexpected extra model call #${index}`);
      return result;
    },
  } as unknown as OllamaClient;
}

const noop = (() => {}) as Emit;

describe("prompt-cache usage accounting through the agent loop", () => {
  it("carries reported cachedTokens through both the worker request and final verification", async () => {
    const ollama = scriptedOllama([
      { content: "done", toolCalls: [], model: "test-model", usage: { promptTokens: 100, completionTokens: 10, durationMs: 5, cachedTokens: 100 } },
      { content: JSON.stringify({ verdict: "pass", reason: "ok", finalAnswer: "done" }), toolCalls: [], model: "test-model", usage: { promptTokens: 50, completionTokens: 4, durationMs: 3, cachedTokens: 40 } },
    ]);
    const result = await runAgent({ cfg: makeConfig(), ollama, tools: new ToolRegistry(), emit: noop, prompt: "say done" });
    assert.equal(result.verified, true);
    assert.equal(result.usage.cachedTokens, 140, "cache reads from the worker and the verifier must both survive");
  });

  it("leaves cachedTokens absent when the provider reports no cache telemetry", async () => {
    const ollama = scriptedOllama([
      { content: "done", toolCalls: [], model: "test-model", usage: { promptTokens: 55, completionTokens: 35, durationMs: 65 } },
      { content: JSON.stringify({ verdict: "pass", reason: "ok", finalAnswer: "done" }), toolCalls: [], model: "test-model", usage: { promptTokens: 12, completionTokens: 3, durationMs: 4 } },
    ]);
    const result = await runAgent({ cfg: makeConfig(), ollama, tools: new ToolRegistry(), emit: noop, prompt: "say done" });
    assert.equal(result.usage.promptTokens, 67);
    assert.ok(!("cachedTokens" in result.usage), "no telemetry must stay undefined, not become an explicit zero");
  });
});

describe("usage accumulation helpers", () => {
  it("keeps an absent cache counter absent", () => {
    const target: Usage = { promptTokens: 0, completionTokens: 0, durationMs: 0 };
    addUsage(target, { promptTokens: 1, completionTokens: 2, durationMs: 3 });
    assert.deepEqual(target, { promptTokens: 1, completionTokens: 2, durationMs: 3 });
  });

  it("sums cache reads and writes without mutating the base snapshot", () => {
    const base: Usage = { promptTokens: 1, completionTokens: 1, durationMs: 1, cachedTokens: 10, cacheWriteTokens: 2 };
    const total = sumUsage(base, { promptTokens: 1, completionTokens: 1, durationMs: 1, cachedTokens: 5 });
    assert.equal(total.cachedTokens, 15);
    assert.equal(total.cacheWriteTokens, 2);
    assert.equal(base.cachedTokens, 10, "the checkpoint base must not be mutated");
  });
});
