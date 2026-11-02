/**
 * A local writing turn enables thinking. Some models then describe a tool
 * call in prose and emit no tool_calls. The loop must ask once more with
 * thinking off and run the tool the second answer names.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAgent } from "../loop.js";
import { ToolRegistry, type Tool } from "../../tools/registry.js";
import type { Config } from "../../config.js";
import type { ChatResult, OllamaClient } from "../../ollama.js";
import type { Emit } from "../events.js";

function cfg(): Config {
  return {
    model: "test-model",
    fallbackModel: "test-model",
    ollamaUrl: "http://127.0.0.1:9",
    server: { host: "127.0.0.1", port: 0 },
    agent: { maxSteps: 6, temperature: 0, requestTimeoutMs: 1000 },
    workspace: "/tmp/workspace",
    policy: { networkEnabled: false, allowOutsideWorkspaceRead: true, denyCommandPatterns: [], allowCommandPatterns: [], maxCommandSeconds: 30, sandboxMode: "workspace-write" },
    browser: { channel: "msedge", headless: true, viewport: { width: 800, height: 600 } },
    computerUse: { enabled: false, screenshotDir: "/tmp/shots" },
    memory: { enabled: false, model: "", file: "", autoStore: false, recallTop: 0, minScore: 0, maxEntries: 0, dedupeThreshold: 0 },
    screen: { enabled: false, fps: 1, quality: 1, maxWidth: 1 },
    vision: { enabled: false, maxImagesPerStep: 0 },
    selfImprove: { enabled: false, reviewEvery: 1, model: "", maxSteps: 1, writeApproval: false },
    evaluation: { enabled: false, intervalMinutes: 1, suite: "core", critique: false, keepRuns: 0, transcripts: false },
    selfPlay: { maxCases: 0 },
    orchestrator: { enabled: false, plannerModel: "", verifierModel: "", maxPlanSteps: 1, maxStepsPerWorker: 1, maxRevisionsPerStep: 1, maxReplans: 0, verifyFinal: false },
    mcpServers: {},
    compression: { enabled: false, thresholdPercent: 1, protectLead: 1, protectTail: 1, targetRatio: 1, bufferTokens: 1, reattachFiles: 0, reattachFileChars: 1, criticalThresholdPercent: 1, recentTurnsToKeep: 1, minTurnsToKeep: 1, emergencyToolResultMaxChars: 1, model: "", contextWindow: {} },
    sessionLog: { enabled: false },
    subagent: { maxDepth: 0, maxConcurrentChildren: 1 },
    skills: { autoSuggest: false, suggestModel: "" },
  } as Config;
}

describe("thinking tool retry", () => {
  it("runs the tool after a thinking turn that only described the call", async () => {
    let opened = false;
    const tool: Tool = {
      name: "office_craft",
      description: "open slides",
      parameters: { type: "object", properties: { app: { type: "string" }, action: { type: "string" } } },
      async run() {
        opened = true;
        return { ok: true, content: JSON.stringify({ ok: true, app: "slides" }) };
      },
    };
    const registry = new ToolRegistry();
    registry.registerAll([tool]);
    const tools = registry.forAllowlist(["office_craft"]);
    const thinks: Array<boolean | undefined> = [];
    const usage = { promptTokens: 1, completionTokens: 1, durationMs: 0 };
    let step = 0;
    const ollama = {
      async chat(options: { think?: boolean }): Promise<ChatResult> {
        thinks.push(options.think);
        step += 1;
        if (step === 1) return { content: "I called office_craft.", toolCalls: [], model: "test-model", usage };
        if (step === 2) return { content: "", toolCalls: [{ function: { name: "office_craft", arguments: { app: "slides", action: "open" } } }], model: "test-model", usage };
        return { content: "opened", toolCalls: [], model: "test-model", usage };
      },
    };
    await runAgent({
      cfg: cfg(),
      ollama: ollama as unknown as OllamaClient,
      tools,
      emit: (() => undefined) as Emit,
      prompt: "اعمل برزنتيشن من صفحة 1",
      taskId: "task_think_retry",
      suppressFinal: true,
      maxSteps: 4,
      systemOverride: "test",
    });
    assert.deepEqual(thinks.slice(0, 2), [true, false]);
    assert.equal(opened, true);
  });

  it("runs a tool the model only described inside thinking", async () => {
    let opened = false;
    const tool: Tool = {
      name: "office_craft",
      description: "open slides",
      parameters: { type: "object", properties: { app: { type: "string" }, action: { type: "string" } } },
      async run() {
        opened = true;
        return { ok: true, content: JSON.stringify({ ok: true, app: "slides" }) };
      },
    };
    const registry = new ToolRegistry();
    registry.registerAll([tool]);
    const usage = { promptTokens: 1, completionTokens: 1, durationMs: 0 };
    const ollama = {
      async chat(options: { think?: boolean; onThinking?: (text: string) => void }): Promise<ChatResult> {
        if (opened) return { content: "opened", toolCalls: [], model: "test-model", usage };
        if (options.think === true) {
          options.onThinking?.("Call `office_craft` with `action: \"open\"`, `app: \"slides\"`.");
          return { content: "", toolCalls: [], model: "test-model", usage };
        }
        return { content: "opened", toolCalls: [], model: "test-model", usage };
      },
    };
    await runAgent({
      cfg: cfg(),
      ollama: ollama as unknown as OllamaClient,
      tools: registry.forAllowlist(["office_craft"]),
      emit: (() => undefined) as Emit,
      prompt: "اعمل برزنتيشن من صفحة 1",
      taskId: "task_think_prose",
      suppressFinal: true,
      maxSteps: 4,
      systemOverride: "test",
    });
    assert.equal(opened, true);
  });

  it("runs the call named by the step when the model talks about a different app", async () => {
    let app = "";
    const tool: Tool = {
      name: "office_craft",
      description: "open slides",
      parameters: { type: "object", properties: { app: { type: "string" }, action: { type: "string" } } },
      async run(args) {
        app = String((args as { app?: string }).app ?? "");
        return { ok: true, content: JSON.stringify({ ok: true, app }) };
      },
    };
    const registry = new ToolRegistry();
    registry.registerAll([tool]);
    const usage = { promptTokens: 1, completionTokens: 1, durationMs: 0 };
    const ollama = {
      async chat(): Promise<ChatResult> {
        if (app) return { content: "opened", toolCalls: [], model: "test-model", usage };
        return { content: "I will create a document in Loam Docs.", thinking: "Call office_craft with action 'open' and app 'docs'.", toolCalls: [], model: "test-model", usage };
      },
    };
    await runAgent({
      cfg: cfg(),
      ollama: ollama as unknown as OllamaClient,
      tools: registry.forAllowlist(["office_craft"]),
      emit: (() => undefined) as Emit,
      prompt: "Call office_craft with action 'open' and app 'slides' to create a new presentation.",
      taskId: "task_step_call",
      suppressFinal: true,
      maxSteps: 4,
      systemOverride: "test",
    });
    assert.equal(app, "slides");
  });

  it("ends the step when the instructed call succeeds", async () => {
    let chats = 0;
    const tool: Tool = {
      name: "office_craft",
      description: "export slides",
      parameters: { type: "object", properties: { app: { type: "string" }, action: { type: "string" } } },
      async run() {
        return { ok: true, content: JSON.stringify({ ok: true, path: "uploads/deck.pptx" }) };
      },
    };
    const registry = new ToolRegistry();
    registry.registerAll([tool]);
    const usage = { promptTokens: 1, completionTokens: 1, durationMs: 0 };
    const ollama = {
      async chat(): Promise<ChatResult> {
        chats += 1;
        return { content: "", toolCalls: [], model: "test-model", usage };
      },
    };
    const outcome = await runAgent({
      cfg: cfg(),
      ollama: ollama as unknown as OllamaClient,
      tools: registry.forAllowlist(["office_craft"]),
      emit: (() => undefined) as Emit,
      prompt: "INSTRUCTION:\nCall office_craft with action 'export' and app 'slides'.\nSUCCESS CRITERIA:\nA pptx exists.",
      taskId: "task_step_done",
      suppressFinal: true,
      maxSteps: 4,
      systemOverride: "test",
    });
    assert.equal(chats, 0);
    assert.match(outcome.text, /uploads\/deck.pptx/);
  });
});
