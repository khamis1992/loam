/**
 * Unit tests: the harness reminder channel.
 *
 * Reminders are model-facing context injected as user-role tagged blocks. They
 * must never reach the user interface: the loop appends them to the transcript
 * only, and `visibleMessages` filters them out of any rendered history.
 */
import assert from "node:assert";
import { describe, it, mock } from "node:test";

import {
  ReminderChannel,
  buildReminder,
  injectReminder,
  isReminderContent,
  isReminderMessage,
  reminderMessage,
  visibleMessages,
  REMINDER_OPEN,
  REMINDER_CLOSE,
  DEFAULT_TODO_STALE_STEPS,
} from "../reminders.js";
import { runAgent } from "../loop.js";
import { ToolRegistry } from "../../tools/registry.js";
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

function makeEmit(): { emit: Emit; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return { emit: ((e: AgentEvent) => events.push(e)) as Emit, events };
}

describe("reminder channel", () => {
  it("wraps free text in exactly one tagged block and trims it", () => {
    const block = injectReminder("  hello  ");
    assert.equal(block, `${REMINDER_OPEN}\nhello\n${REMINDER_CLOSE}`);
  });

  it("rejects empty reminder text", () => {
    assert.throws(() => injectReminder("   "), /must not be empty/);
  });

  it("builds a user-role tagged message", () => {
    const message = reminderMessage("note");
    assert.equal(message.role, "user");
    assert.ok(isReminderContent(message.content));
    assert.ok(isReminderMessage(message));
  });

  it("recognises only user-role tagged blocks as reminders", () => {
    assert.equal(isReminderContent(`<system-reminder>\nx\n</system-reminder>`), true);
    assert.equal(isReminderContent("plain text"), false);
    assert.equal(isReminderContent(`<system-reminder>\nx`), false);
    assert.equal(isReminderMessage({ role: "assistant", content: `<system-reminder>\nx\n</system-reminder>` }), false);
  });

  it("hides reminders from a rendered transcript but keeps real messages", () => {
    const reminder = reminderMessage("hidden");
    const user: ChatMessage = { role: "user", content: "visible question" };
    const assistant: ChatMessage = { role: "assistant", content: "visible answer" };
    const shown = visibleMessages([user, reminder, assistant]);
    assert.deepEqual(shown, [user, assistant]);
  });

  it("builds every built-in reminder kind", () => {
    assert.match(buildReminder("todo_stale", "9"), /task list has not been updated for 9 steps/);
    assert.match(buildReminder("file_changed", "src/a.ts"), /`src\/a\.ts` changed on disk/);
    assert.match(buildReminder("plan_mode"), /PLAN mode/);
    assert.match(buildReminder("memory_updated"), /memory was updated/);
  });
});

describe("ReminderChannel", () => {
  it("injects a stale-todo reminder after the threshold", () => {
    const channel = new ReminderChannel({ todoStaleAfter: 3 });
    assert.deepEqual(channel.drain(1), []);
    assert.deepEqual(channel.drain(2), []);
    const due = channel.drain(3);
    assert.equal(due.length, 1);
    assert.match(due[0]!, /task list has not been updated for 3 steps/);
    // It must not repeat every step.
    assert.deepEqual(channel.drain(4), []);
  });

  it("uses the default threshold of eight silent steps", () => {
    const channel = new ReminderChannel();
    for (let step = 1; step < DEFAULT_TODO_STALE_STEPS; step++) assert.deepEqual(channel.drain(step), []);
    assert.equal(channel.drain(DEFAULT_TODO_STALE_STEPS).length, 1);
  });

  it("restarts the staleness clock after a todo update", () => {
    const channel = new ReminderChannel({ todoStaleAfter: 2 });
    channel.noteTodoUpdate(2);
    assert.deepEqual(channel.drain(3), []);
    assert.equal(channel.drain(4).length, 1);
  });

  it("announces plan mode once per activation", () => {
    const channel = new ReminderChannel({ planMode: true });
    assert.match(channel.drain(1)[0]!, /PLAN mode/);
    assert.deepEqual(channel.drain(2), []);
    channel.setPlanMode(false);
    channel.setPlanMode(true);
    assert.match(channel.drain(3)[0]!, /PLAN mode/);
  });

  it("drains external file changes and memory updates as user messages", () => {
    const channel = new ReminderChannel({ todoStaleAfter: 99 });
    channel.fileChanged("src/b.ts");
    channel.memoryUpdated();
    const messages = channel.drainMessages(1);
    assert.equal(messages.length, 2);
    assert.ok(messages.every((m) => m.role === "user" && isReminderContent(m.content)));
    assert.match(messages[0]!.content, /`src\/b\.ts` changed on disk/);
    assert.match(messages[1]!.content, /memory was updated/);
    assert.equal(channel.pendingCount, 0);
  });
});

describe("runAgent reminder injection", () => {
  it("appends reminders as hidden user-role blocks and never emits them", async () => {
    const cfg = makeConfig({
      compression: { ...makeConfig().compression, enabled: false },
    });
    const tools = new ToolRegistry();
    tools.register({
      name: "file_read",
      description: "Read a file.",
      parameters: { type: "object" },
      async run() {
        return { ok: true, content: "file body" };
      },
    });

    const results: ChatResult[] = [
      {
        content: "",
        model: "qwen2.5:14b",
        toolCalls: [{ function: { name: "file_read", arguments: { path: "a.ts" } } }],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      },
      {
        content: "done",
        model: "qwen2.5:14b",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      },
    ];
    let call = 0;
    const chat = mock.fn(async () => results[Math.min(call++, results.length - 1)]!);
    const ollama = { chat } as unknown as OllamaClient;

    const channel = new ReminderChannel();
    channel.fileChanged("src/a.ts");
    const { emit, events } = makeEmit();

    const result = await runAgent({
      cfg,
      ollama,
      tools,
      emit,
      prompt: "read the file",
      suppressFinal: true,
      maxSteps: 4,
      reminderChannel: channel,
    });

    const reminder = result.messages.find((m) => isReminderMessage(m));
    assert.ok(reminder, "the loop must append the queued reminder");
    assert.equal(reminder!.role, "user");
    assert.match(reminder!.content, /<system-reminder>/);
    assert.match(reminder!.content, /`src\/a\.ts` changed on disk/);
    // Hidden from the UI: the filter removes it and no event carries it.
    assert.equal(visibleMessages(result.messages).includes(reminder!), false);
    assert.equal(events.some((e) => JSON.stringify(e).includes("changed on disk")), false);
  });
});
