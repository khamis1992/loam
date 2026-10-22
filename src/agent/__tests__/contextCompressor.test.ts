/**
 * Unit tests: the context compressor.
 *
 * The compressor triggers when the estimated token count exceeds a fraction of
 * the model's context window. It protects a head and tail, prunes old tool
 * outputs to an elision marker, then summarizes the middle with an auxiliary
 * model call. A tool_call is never separated from its tool_result, and a
 * summarizer failure degrades to pruning only.
 */
import assert from "node:assert";
import { describe, it, mock } from "node:test";

import {
  compressContext,
  estimateTokens,
  getContextWindow,
  ELISION_MARKER,
  SUMMARY_LABEL,
} from "../contextCompressor.js";
import type { Config } from "../../config.js";
import type { ChatMessage, ChatResult, OllamaClient } from "../../ollama.js";
import type { AgentEvent, Emit } from "../events.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "qwen2.5:14b",
    fallbackModel: "qwen2.5:7b",
    ollamaUrl: "http://localhost:11434",
    server: { host: "127.0.0.1", port: 3939 },
    agent: { maxSteps: 40, temperature: 0.2, requestTimeoutMs: 600000 },
    workspace: "/tmp/workspace",
    policy: {
      networkEnabled: true,
      allowOutsideWorkspaceRead: true,
      denyCommandPatterns: [],
      allowCommandPatterns: [],
      maxCommandSeconds: 180,
    },
    browser: { channel: "msedge", headless: false, viewport: { width: 1280, height: 800 } },
    computerUse: { enabled: true, screenshotDir: "/tmp/screenshots" },
    memory: {
      enabled: true,
      model: "nomic-embed-text:latest",
      file: "/tmp/memory.json",
      autoStore: false,
      recallTop: 3,
      minScore: 0.45,
      maxEntries: 2000,
      dedupeThreshold: 0.97,
    },
    screen: { enabled: true, fps: 1, quality: 60, maxWidth: 1280 },
    vision: { enabled: true, maxImagesPerStep: 2 },
    selfImprove: { enabled: true, reviewEvery: 1, model: "", maxSteps: 10, writeApproval: false },
    evaluation: { enabled: false, intervalMinutes: 360, suite: "core", critique: true, keepRuns: 30, transcripts: true },
    selfPlay: { maxCases: 5 },
    orchestrator: { enabled: true, plannerModel: "", verifierModel: "", maxPlanSteps: 8, maxStepsPerWorker: 24, maxRevisionsPerStep: 1, maxReplans: 1, verifyFinal: true },
    mcpServers: {},
    compression: {
      enabled: true,
      thresholdPercent: 0.5,
      protectLead: 3,
      protectTail: 20,
      targetRatio: 0.2,
      model: "",
      contextWindow: { "qwen2.5": 32768 },
    },
    ...overrides,
  };
}

function makeOllama(handler: (...args: any[]) => ChatResult) {
  const chat = mock.fn(handler);
  const ollama = { chat } as unknown as OllamaClient;
  return { ollama, chat };
}

function okResult(content: string, usage = { promptTokens: 11, completionTokens: 7, durationMs: 42 }): ChatResult {
  return { content, toolCalls: [], model: "qwen2.5:14b", usage };
}

function makeEmit(): { emit: Emit; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return { emit: ((e: AgentEvent) => events.push(e)) as Emit, events };
}

function sysMsg(content: string): ChatMessage {
  return { role: "system", content };
}
function userMsg(content: string): ChatMessage {
  return { role: "user", content };
}
function asstMsg(content: string, toolCalls?: ChatMessage["tool_calls"]): ChatMessage {
  return { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
}
function toolMsg(name: string, content: string): ChatMessage {
  return { role: "tool", tool_name: name, content };
}

function sentPrompt(chat: { mock: { calls: Array<{ arguments: any[] }> } }): string {
  const opts = chat.mock.calls[0]?.arguments[0] as { messages: ChatMessage[] } | undefined;
  return (opts?.messages ?? []).map((m) => m.content).join("\n");
}

describe("context compressor", () => {
  it("estimates tokens from text length", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
  });

  it("does nothing when under the threshold", async () => {
    const cfg = makeConfig();
    const { ollama } = makeOllama(() => okResult("unused"));
    const { emit, events } = makeEmit();

    const messages = [sysMsg("You are helpful."), userMsg("Hello"), asstMsg("Hi")];
    const result = await compressContext(cfg, ollama, messages, emit);

    assert.equal(result.compressed, false);
    assert.equal(result.step, 0);
    assert.deepEqual(result.messages, messages);
    assert.equal(events.length, 0);
  });

  it("matches the context window by longest prefix", () => {
    const cfg = makeConfig({
      compression: {
        ...makeConfig().compression,
        contextWindow: { qwen: 16384, "qwen2.5": 32768 },
      },
    });
    assert.equal(getContextWindow(cfg, "qwen2.5:14b"), 32768);
    assert.equal(getContextWindow(cfg, "qwen2:7b"), 16384);
  });

  it("prunes old tool outputs to an elision marker (step 1)", async () => {
    const cfg = makeConfig({
      compression: { ...makeConfig().compression, thresholdPercent: 0.01, protectLead: 1, protectTail: 1 },
    });
    const { ollama, chat } = makeOllama(() => okResult("unused"));
    const { emit, events } = makeEmit();

    const longOutput = "tool output ".repeat(2000);
    const messages: ChatMessage[] = [
      sysMsg("System"),
      userMsg("Read the file"),
      asstMsg("", [{ function: { name: "file_read", arguments: { path: "a.txt" } } }]),
      toolMsg("file_read", longOutput),
      userMsg("Next"),
      asstMsg("Done"),
    ];

    const result = await compressContext(cfg, ollama, messages, emit);

    assert.equal(result.compressed, true);
    assert.equal(result.step, 1);
    const tool = result.messages.find((m) => m.role === "tool");
    assert.ok(tool, "tool result survives");
    assert.equal(tool!.content, ELISION_MARKER(longOutput.length));
    assert.equal(chat.mock.callCount(), 0, "no auxiliary call needed");
    assert.equal(events.some((e) => e.type === "compaction" && e.step === 1), true);
  });

  it("never splits a tool_call from its tool_result", async () => {
    const cfg = makeConfig({
      compression: { ...makeConfig().compression, thresholdPercent: 0.01, protectLead: 1, protectTail: 1 },
    });
    const { ollama } = makeOllama(() => okResult("unused"));
    const { emit } = makeEmit();

    const longOutput = "x".repeat(20000);
    const messages: ChatMessage[] = [
      sysMsg("System"),
      userMsg("Go"),
      asstMsg("", [{ function: { name: "tool_a", arguments: {} } }]),
      toolMsg("tool_a", longOutput),
      asstMsg("", [{ function: { name: "tool_b", arguments: {} } }]),
      toolMsg("tool_b", longOutput),
      userMsg("Next"),
      asstMsg("End"),
    ];

    const result = await compressContext(cfg, ollama, messages, emit);

    for (let i = 0; i < result.messages.length; i++) {
      const m = result.messages[i]!;
      if (m.role === "assistant" && m.tool_calls?.length) {
        assert.equal(result.messages[i + 1]?.role, "tool", "tool_call must be followed by its tool_result");
        assert.match(result.messages[i + 1]!.content, /chars elided/);
      }
    }
  });

  it("keeps a tool pair together when the boundary would split it", async () => {
    const cfg = makeConfig({
      compression: { ...makeConfig().compression, thresholdPercent: 0.01, protectLead: 3, protectTail: 1 },
    });
    const { ollama } = makeOllama(() => okResult("Summarized."));
    const { emit } = makeEmit();

    const longOutput = "y".repeat(20000);
    const messages: ChatMessage[] = [
      sysMsg("System"),
      userMsg("Go"),
      asstMsg("", [{ function: { name: "tool_a", arguments: {} } }]),
      toolMsg("tool_a", longOutput),
      userMsg("Next"),
      asstMsg("End"),
    ];

    const result = await compressContext(cfg, ollama, messages, emit);

    const tool = result.messages.find((m) => m.role === "tool");
    assert.ok(tool, "the tool_result is retained with its tool_call");
    assert.equal(tool!.content, longOutput, "the pair was not elided across the boundary");
    assert.equal(result.messages.some((m) => m.content?.includes("chars elided")), false);
    assert.equal(result.messages[0]!.content, "System");
  });

  it("summarizes the middle with an auxiliary call (step 2)", async () => {
    const cfg = makeConfig({
      compression: { ...makeConfig().compression, thresholdPercent: 0.01, protectLead: 1, protectTail: 1 },
    });
    const { ollama, chat } = makeOllama(() => okResult("Compact summary of the segment."));
    const { emit, events } = makeEmit();

    const long = "z".repeat(40000);
    const messages: ChatMessage[] = [
      sysMsg("System"),
      userMsg(long),
      asstMsg(long),
      userMsg(long),
      asstMsg(long),
      userMsg("latest user"),
      asstMsg("final answer"),
    ];

    const result = await compressContext(cfg, ollama, messages, emit);

    assert.equal(result.compressed, true);
    assert.equal(result.step, 2);
    assert.equal(chat.mock.callCount(), 1);
    assert.deepEqual(result.usage, { promptTokens: 11, completionTokens: 7, durationMs: 42 });

    const summary = result.messages.find((m) => m.content?.includes(SUMMARY_LABEL));
    assert.ok(summary, "summary message is labelled");
    assert.match(summary!.content, /Compact summary of the segment\./);
    assert.equal(result.messages[0]!.content, "System");
    assert.equal(result.messages[result.messages.length - 1]!.content, "final answer");

    const event = events.find((e) => e.type === "compaction");
    assert.equal(event?.type === "compaction" && event.step, 2);
  });

  it("updates an existing summary instead of re-summarizing", async () => {
    const cfg = makeConfig({
      compression: { ...makeConfig().compression, thresholdPercent: 0.01, protectLead: 1, protectTail: 1 },
    });
    const { ollama, chat } = makeOllama(() => okResult("Updated summary with new facts."));
    const { emit } = makeEmit();

    const long = "z".repeat(40000);
    const messages: ChatMessage[] = [
      sysMsg("System"),
      userMsg(long),
      asstMsg(`[${SUMMARY_LABEL}]\nOld summary with old facts.`),
      userMsg(long),
      asstMsg(long),
      userMsg("latest user"),
      asstMsg("final answer"),
    ];

    const result = await compressContext(cfg, ollama, messages, emit);

    const summaries = result.messages.filter((m) => m.content?.includes(SUMMARY_LABEL));
    assert.equal(summaries.length, 1, "exactly one summary message");
    assert.match(summaries[0]!.content, /Updated summary with new facts\./);

    const prompt = sentPrompt(chat);
    assert.match(prompt, /Previous compaction summary/);
    assert.match(prompt, /Old summary with old facts\./);
  });

  it("falls back to pruning only when the summarizer fails", async () => {
    const cfg = makeConfig({
      compression: { ...makeConfig().compression, thresholdPercent: 0.01, protectLead: 1, protectTail: 1 },
    });
    const { ollama } = makeOllama(() => {
      throw new Error("summarizer unavailable");
    });
    const { emit, events } = makeEmit();

    const long = "z".repeat(40000);
    const messages: ChatMessage[] = [
      sysMsg("System"),
      userMsg(long),
      asstMsg(long),
      userMsg(long),
      asstMsg(long),
      userMsg("latest user"),
      asstMsg("final answer"),
    ];

    const result = await compressContext(cfg, ollama, messages, emit);

    assert.equal(result.compressed, true);
    assert.equal(result.step, 1);
    assert.equal(result.messages.some((m) => m.content?.includes(SUMMARY_LABEL)), false);
    const event = events.find((e) => e.type === "compaction");
    assert.equal(event?.type === "compaction" && event.fallback, true);
  });

  it("falls back to pruning when the summarizer returns an empty summary", async () => {
    const cfg = makeConfig({
      compression: { ...makeConfig().compression, thresholdPercent: 0.01, protectLead: 1, protectTail: 1 },
    });
    const { ollama } = makeOllama(() => okResult("   "));
    const { emit, events } = makeEmit();

    const long = "z".repeat(40000);
    const messages: ChatMessage[] = [
      sysMsg("System"),
      userMsg(long),
      asstMsg(long),
      userMsg("latest user"),
      asstMsg("final answer"),
    ];

    const result = await compressContext(cfg, ollama, messages, emit);

    assert.equal(result.step, 1);
    const event = events.find((e) => e.type === "compaction");
    assert.equal(event?.type === "compaction" && event.fallback, true);
  });

  it("never drops the system prompt or the latest user message", async () => {
    const cfg = makeConfig({
      compression: { ...makeConfig().compression, thresholdPercent: 0.01, protectLead: 3, protectTail: 2 },
    });
    const { ollama } = makeOllama(() => okResult("Summary."));
    const { emit } = makeEmit();

    const messages: ChatMessage[] = [
      sysMsg("Critical system prompt"),
      userMsg("First user"),
      asstMsg("Response 1"),
      userMsg("Second user"),
      asstMsg("Response 2"),
      userMsg("Latest user message - must keep"),
      asstMsg("Latest assistant"),
    ];

    const result = await compressContext(cfg, ollama, messages, emit);

    assert.equal(result.messages[0]!.content, "Critical system prompt");
    const latestUserIdx = result.messages.findLastIndex((m) => m.role === "user");
    assert.ok(latestUserIdx >= 0);
    assert.equal(result.messages[latestUserIdx]!.content, "Latest user message - must keep");
  });

  it("protects the configured head and tail", async () => {
    const cfg = makeConfig({
      compression: { ...makeConfig().compression, thresholdPercent: 0.01, protectLead: 2, protectTail: 2 },
    });
    const { ollama } = makeOllama(() => okResult("Summary."));
    const { emit } = makeEmit();

    const messages: ChatMessage[] = [
      sysMsg("System prompt"),
      userMsg("First user message"),
      asstMsg("First assistant response"),
      userMsg("Middle 1"),
      asstMsg("Middle 2"),
      userMsg("Last user message"),
      asstMsg("Last assistant response"),
    ];

    const result = await compressContext(cfg, ollama, messages, emit);

    assert.equal(result.messages[0]!.content, "System prompt");
    assert.equal(result.messages[1]!.content, "First user message");
    assert.equal(result.messages[result.messages.length - 1]!.content, "Last assistant response");
    assert.equal(result.messages[result.messages.length - 2]!.content, "Last user message");
  });
});
