/**
 * Unit tests: the context compressor.
 *
 * The compressor triggers when the estimated token count exceeds a fraction of
 * the model's context window or the window minus the safety buffer. It protects
 * a head and tail, prunes old tool outputs to an elision marker, then summarizes
 * the middle with an auxiliary model call using eight numbered sections. A
 * tool_call is never separated from its tool_result, a PreCompact hook can veto
 * the compaction, and a summarizer failure degrades to pruning only.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, mock } from "node:test";

import {
  compressContext,
  estimateTokens,
  getContextWindow,
  getCompressionThreshold,
  ELISION_MARKER,
  SUMMARY_LABEL,
  EMERGENCY_TRUNCATION_MARKER,
  criticalThreshold,
  emergencyKeepTurns,
  emergencyMinTurns,
  emergencyToolResultMaxChars,
  emergencyTruncateToolResults,
  SUMMARY_SECTIONS,
  isSummaryMessage,
  extractSummary,
  hasAllSummarySections,
  buildReattachReminder,
} from "../contextCompressor.js";
import { ReadState } from "../../tools/readState.js";
import { reminderMessage } from "../reminders.js";
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
      sandboxMode: "workspace-write",
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
      bufferTokens: 20000,
      reattachFiles: 5,
      reattachFileChars: 4000,
      criticalThresholdPercent: 0.95,
      recentTurnsToKeep: 10,
      minTurnsToKeep: 2,
      emergencyToolResultMaxChars: 4000,
      model: "",
      contextWindow: { "qwen2.5": 32768 },
    },
    sessionLog: { enabled: false },
    subagent: { maxDepth: 2, maxConcurrentChildren: 4 },
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

function isToolCall(message: ChatMessage): boolean {
  return message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function sentPrompt(chat: { mock: { calls: Array<{ arguments: any[] }> } }): string {
  const opts = chat.mock.calls[0]?.arguments[0] as { messages: ChatMessage[] } | undefined;
  return (opts?.messages ?? []).map((m) => m.content).join("\n");
}

/** A transcript big enough to cross the trigger threshold. */
function bigTranscript(): ChatMessage[] {
  const long = "z".repeat(40000);
  return [
    sysMsg("System"),
    userMsg(long),
    asstMsg(long),
    userMsg(long),
    asstMsg(long),
    userMsg("latest user"),
    asstMsg("final answer"),
  ];
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

  it("triggers on the window minus the buffer when that is earlier than the ratio", () => {
    const cfg = makeConfig();
    const window = getContextWindow(cfg, "qwen2.5:14b");
    // ratio 0.5 -> 16384; window - buffer = 32768 - 20000 = 12768 -> earlier.
    assert.equal(getCompressionThreshold(cfg, "qwen2.5:14b"), 12768);
    assert.equal(getCompressionThreshold(makeConfig({ compression: { ...cfg.compression, bufferTokens: 1000 } }), "qwen2.5:14b"), 16384);
    void window;
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
      compression: {
        ...makeConfig().compression,
        thresholdPercent: 0.01,
        protectLead: 1,
        protectTail: 1,
        contextWindow: { "qwen2.5": 1000000 },
      },
    });
    const { ollama, chat } = makeOllama(() => okResult("Compact summary of the segment."));
    const { emit, events } = makeEmit();

    const result = await compressContext(cfg, ollama, bigTranscript(), emit);

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

  it("asks the summarizer for the eight required sections", async () => {
    const cfg = makeConfig({
      compression: {
        ...makeConfig().compression,
        thresholdPercent: 0.01,
        protectLead: 1,
        protectTail: 1,
        // A large window keeps the transcript below the critical ratio so the
        // summarizer path is reached instead of the emergency hard-compact.
        contextWindow: { "qwen2.5": 1000000 },
      },
    });
    const { ollama, chat } = makeOllama(() => okResult("summary"));
    const { emit } = makeEmit();

    await compressContext(cfg, ollama, bigTranscript(), emit);

    const prompt = sentPrompt(chat);
    for (const header of SUMMARY_SECTIONS) assert.match(prompt, new RegExp(header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("updates an existing summary instead of re-summarizing", async () => {
    const cfg = makeConfig({
      compression: {
        ...makeConfig().compression,
        thresholdPercent: 0.01,
        protectLead: 1,
        protectTail: 1,
        contextWindow: { "qwen2.5": 1000000 },
      },
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

  it("recognises and extracts its own summary label", () => {
    assert.equal(isSummaryMessage(asstMsg(`[${SUMMARY_LABEL}]\nbody`)), true);
    assert.equal(isSummaryMessage(userMsg(`[${SUMMARY_LABEL}]\nbody`)), false);
    assert.equal(isSummaryMessage(asstMsg("plain answer")), false);

    assert.equal(extractSummary(`[${SUMMARY_LABEL}]\nhello`), "hello");
    assert.equal(extractSummary(`[${SUMMARY_LABEL}]:`), null);
    assert.equal(extractSummary("no label here"), null);
  });

  it("checks the eight-section schema", () => {
    const complete = SUMMARY_SECTIONS.join("\n");
    assert.equal(hasAllSummarySections(complete), true);
    assert.equal(hasAllSummarySections("1. Primary Request and Intent\nonly"), false);
  });

  it("falls back to pruning only when the summarizer fails", async () => {
    const cfg = makeConfig({
      compression: {
        ...makeConfig().compression,
        thresholdPercent: 0.01,
        protectLead: 1,
        protectTail: 1,
        contextWindow: { "qwen2.5": 1000000 },
      },
    });
    const { ollama } = makeOllama(() => {
      throw new Error("summarizer unavailable");
    });
    const { emit, events } = makeEmit();

    const result = await compressContext(cfg, ollama, bigTranscript(), emit);

    assert.equal(result.compressed, true);
    assert.equal(result.step, 1);
    assert.equal(result.messages.some((m) => m.content?.includes(SUMMARY_LABEL)), false);
    const event = events.find((e) => e.type === "compaction");
    assert.equal(event?.type === "compaction" && event.fallback, true);
  });

  it("falls back to pruning when the summarizer returns an empty summary", async () => {
    const cfg = makeConfig({
      compression: {
        ...makeConfig().compression,
        thresholdPercent: 0.01,
        protectLead: 1,
        protectTail: 1,
        // A large window keeps the transcript below the critical ratio so the
        // summarizer is reached (and can return an empty summary) instead of
        // the emergency hard-compact.
        contextWindow: { "qwen2.5": 1000000 },
      },
    });
    const { ollama } = makeOllama(() => okResult("   "));
    const { emit, events } = makeEmit();

    const result = await compressContext(cfg, ollama, bigTranscript(), emit);

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

  it("defaults match the jcode compaction constants", () => {
    const cfg = makeConfig();
    assert.equal(cfg.compression.criticalThresholdPercent, 0.95);
    assert.equal(cfg.compression.recentTurnsToKeep, 10);
    assert.equal(cfg.compression.minTurnsToKeep, 2);
    assert.equal(cfg.compression.emergencyToolResultMaxChars, 4000);
    assert.equal(criticalThreshold(cfg), 0.95);
    assert.equal(emergencyKeepTurns(cfg), 10);
    assert.equal(emergencyMinTurns(cfg), 2);
    assert.equal(emergencyToolResultMaxChars(cfg), 4000);
  });

  it("clamps malformed emergency constants to the jcode defaults", () => {
    const cfg = makeConfig({
      compression: {
        ...makeConfig().compression,
        criticalThresholdPercent: Number.NaN,
        recentTurnsToKeep: 0,
        minTurnsToKeep: -5,
        emergencyToolResultMaxChars: 0,
      },
    });
    assert.equal(criticalThreshold(cfg), 0.95);
    assert.equal(emergencyKeepTurns(cfg), 10);
    assert.equal(emergencyMinTurns(cfg), 2);
    assert.equal(emergencyToolResultMaxChars(cfg), 4000);
  });

  it("clamps the critical ratio so it can never exceed the trigger", () => {
    // Above the trigger it is capped, otherwise the emergency path would be
    // dead code. Below the trigger it is raised to the trigger in compressContext.
    const cfg = makeConfig({
      compression: { ...makeConfig().compression, criticalThresholdPercent: 1.5 },
    });
    assert.equal(criticalThreshold(cfg), 0.99);
    const high = makeConfig({
      compression: { ...makeConfig().compression, thresholdPercent: 0.1, criticalThresholdPercent: 0.05 },
    });
    assert.equal(criticalThreshold(high), 0.05);
  });

  it("truncates an oversized tool result to a head and tail with a marker", () => {
    const big = "x".repeat(10000);
    const { messages, truncated } = emergencyTruncateToolResults([toolMsg("read", big)], 4000);
    assert.equal(truncated, 1);
    assert.equal(messages.length, 1);
    const content = messages[0]!.content;
    assert.ok(content.length < big.length, "truncated content is smaller than the input");
    assert.match(content, /chars truncated for context recovery/);
    assert.match(content, new RegExp(EMERGENCY_TRUNCATION_MARKER(7000).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(content.startsWith("x".repeat(2000)), true);
  });

  it("leaves short tool results and non-tool messages untouched", () => {
    const messages = [userMsg("hello"), toolMsg("read", "short"), asstMsg("done")];
    const { messages: out, truncated } = emergencyTruncateToolResults(messages, 4000);
    assert.equal(truncated, 0);
    assert.deepEqual(out, messages);
  });

  it("emergency hard-compacts when the estimate passes the critical threshold", async () => {
    // A small window makes it trivial to exceed 95% of it.
    const cfg = makeConfig({
      compression: {
        ...makeConfig().compression,
        thresholdPercent: 0.01,
        criticalThresholdPercent: 0.5,
        recentTurnsToKeep: 2,
        minTurnsToKeep: 2,
        emergencyToolResultMaxChars: 4000,
        contextWindow: { "qwen2.5": 2000 },
      },
    });
    const { ollama, chat } = makeOllama(() => okResult("unused"));
    const { emit, events } = makeEmit();

    const long = "y".repeat(12000);
    const messages: ChatMessage[] = [
      sysMsg("System prompt"),
      userMsg("task"),
      asstMsg("r1"),
      userMsg(long),
      asstMsg(long),
      userMsg("latest user"),
      asstMsg("final answer"),
    ];

    const result = await compressContext(cfg, ollama, messages, emit);

    assert.equal(result.compressed, true);
    assert.equal(result.step, 3);
    assert.equal(result.emergency, true);
    assert.equal(result.usage.promptTokens, 0, "no auxiliary summarizer call");
    assert.equal(chat.mock.callCount(), 0, "emergency path must be synchronous");
    assert.ok(result.droppedTurns! > 0, "older turns were dropped");
    assert.ok(result.tokensAfter! < result.tokensBefore!, "recovery reduced the estimate");
    assert.equal(result.messages[0]!.content, "System prompt");
    assert.match(result.messages[result.messages.length - 1]!.content, /final answer/);

    const event = events.find((e) => e.type === "compaction");
    assert.equal(event?.type === "compaction" && event.step, 3);
    assert.equal(event?.type === "compaction" && event.emergency, true);
  });

  it("emergency compaction never splits a tool_call from its tool_result", async () => {
    const cfg = makeConfig({
      compression: {
        ...makeConfig().compression,
        thresholdPercent: 0.01,
        criticalThresholdPercent: 0.5,
        recentTurnsToKeep: 3,
        minTurnsToKeep: 2,
        emergencyToolResultMaxChars: 4000,
        contextWindow: { "qwen2.5": 2000 },
      },
    });
    const { ollama } = makeOllama(() => okResult("unused"));
    const { emit } = makeEmit();

    const long = "z".repeat(6000);
    const messages: ChatMessage[] = [
      sysMsg("System prompt"),
      userMsg("task"),
      asstMsg("", [{ function: { name: "tool_a", arguments: {} } }]),
      toolMsg("tool_a", long),
      userMsg("next"),
      asstMsg("final answer"),
    ];

    const result = await compressContext(cfg, ollama, messages, emit);

    assert.equal(result.step, 3);
    for (let i = 0; i < result.messages.length; i++) {
      const m = result.messages[i]!;
      if (m.role === "tool") {
        const prev = result.messages[i - 1];
        assert.ok(prev && isToolCall(prev), "every kept tool result keeps its tool_call");
      }
    }
  });

  it("re-attaches the live todo list as a hidden reminder after compaction", async () => {
    const cfg = makeConfig({
      compression: {
        ...makeConfig().compression,
        thresholdPercent: 0.01,
        protectLead: 1,
        protectTail: 1,
        // A large window keeps the transcript below the critical ratio so the
        // summarizer path runs and emits its re-attach reminder.
        contextWindow: { "qwen2.5": 1000000 },
      },
    });
    const { ollama } = makeOllama(() => okResult("Summary."));
    const { emit } = makeEmit();

    const todos = [
      { id: "todo-0", content: "Write the parser", status: "completed" as const },
      { id: "todo-1", content: "Add tests", status: "in_progress" as const },
    ];
    const result = await compressContext(cfg, ollama, bigTranscript(), emit, undefined, { todos });

    assert.equal(result.reminders.length, 1);
    const reminder = result.reminders[0]!;
    assert.equal(reminder.role, "user");
    assert.match(reminder.content, /<system-reminder>/);
    assert.match(reminder.content, /Live task list/);
    assert.match(reminder.content, /Add tests/);
    assert.equal(reminderMessage("probe").content.includes("<system-reminder>"), true);
  });

  it("re-attaches the todo list even when compaction finishes with pruning only", async () => {
    // Pruning alone can drop the working context, so a step-1 compaction needs the
    // re-attach reminder as much as a step-2 one does.
    const cfg = makeConfig({
      compression: { ...makeConfig().compression, thresholdPercent: 0.01, protectLead: 1, protectTail: 1 },
    });
    const { ollama } = makeOllama(() => okResult("Summary."));
    const { emit } = makeEmit();

    const messages: ChatMessage[] = [
      sysMsg("System"),
      userMsg("Go"),
      asstMsg("", [{ function: { name: "tool_a", arguments: {} } }]),
      toolMsg("tool_a", "z".repeat(20000)),
      userMsg("Next"),
      asstMsg("End"),
    ];

    const todos = [{ id: "todo-0", content: "Ship it", status: "in_progress" as const }];
    const result = await compressContext(cfg, ollama, messages, emit, undefined, { todos });

    assert.equal(result.step, 1, "pruning brought the transcript under the threshold");
    assert.equal(result.reminders.length, 1);
    assert.match(result.reminders[0]!.content, /Live task list/);
    assert.match(result.reminders[0]!.content, /Ship it/);
  });

  it("re-attaches the most recently read files (newest first, truncated)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-c8-"));
    try {
      const file = path.join(dir, "config.ts");
      fs.writeFileSync(file, "const a = 1;\n".repeat(2000), "utf8");
      const readState = new ReadState();
      readState.record(file);

      const body = buildReattachReminder({
        readState,
        workspace: dir,
        todos: [],
        reattachFiles: 5,
        reattachFileChars: 4000,
      });
      assert.match(body, /Recently read files/);
      assert.match(body, /config\.ts/);
      assert.match(body, /snapshot truncated/);
      assert.equal(body.length < fs.statSync(file).size, true, "the snapshot must be truncated");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("orders re-attached files newest first", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-c8-"));
    try {
      const older = path.join(dir, "older.ts");
      const newer = path.join(dir, "newer.ts");
      fs.writeFileSync(older, "older", "utf8");
      fs.writeFileSync(newer, "newer", "utf8");
      const readState = new ReadState();
      readState.record(older, undefined, 1_000);
      readState.record(newer, undefined, 2_000);

      const body = buildReattachReminder({
        readState,
        workspace: dir,
        todos: [],
        reattachFiles: 5,
        reattachFileChars: 4000,
      });
      const olderIdx = body.indexOf("older.ts");
      const newerIdx = body.indexOf("newer.ts");
      assert.ok(olderIdx >= 0 && newerIdx >= 0);
      assert.ok(newerIdx < olderIdx, "the newest read must be re-attached first");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
