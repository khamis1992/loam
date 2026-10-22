/**
 * Loop-level tests for the todo-staleness reminder (C6 on top of C9).
 *
 * A `todo_write` call restarts the staleness clock; after the default eight
 * silent steps the loop injects a hidden reminder telling the model to update
 * its task list. The reminder is a user-role tagged block, never a UI event.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import type { Config } from "../../config.js";
import type { ChatResult, OllamaClient } from "../../ollama.js";
import type { AgentEvent, Emit } from "../events.js";
import { runAgent } from "../loop.js";
import { isReminderMessage } from "../reminders.js";
import { ToolRegistry } from "../../tools/registry.js";
import { todoWriteTool } from "../../tools/todoTools.js";

function makeConfig(): Config {
  return {
    model: "qwen2.5:14b",
    fallbackModel: "qwen2.5:7b",
    workspace: "/tmp/workspace",
    agent: { maxSteps: 40, temperature: 0.2, requestTimeoutMs: 600000 },
    policy: {
      networkEnabled: true,
      allowOutsideWorkspaceRead: true,
      denyCommandPatterns: [],
      allowCommandPatterns: [],
      maxCommandSeconds: 180,
      sandboxMode: "workspace-write",
    },
    vision: { enabled: false, maxImagesPerStep: 2 },
    compression: { enabled: false },
  } as unknown as Config;
}

function makeEmit(): { emit: Emit; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return { emit: ((e: AgentEvent) => events.push(e)) as Emit, events };
}

/** A fake model that calls todo_write once, then reads files until it finishes. */
function fakeModel() {
  const results: ChatResult[] = [];
  const todoCall: ChatResult["toolCalls"] = [
    { function: { name: "todo_write", arguments: { todos: [{ content: "write the parser", status: "in_progress" }] } } },
  ];
  results.push({ content: "", model: "qwen2.5:14b", toolCalls: todoCall, usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } });
  for (let i = 0; i < 9; i++) {
    results.push({
      content: "",
      model: "qwen2.5:14b",
      toolCalls: [{ function: { name: "file_read", arguments: { path: `f${i}.ts` } } }],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    });
  }
  results.push({ content: "done", model: "qwen2.5:14b", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } });

  let call = 0;
  const chat = mock.fn(async () => results[Math.min(call++, results.length - 1)]!);
  return { ollama: { chat } as unknown as OllamaClient, calls: () => call };
}

describe("todo staleness reminder in the loop", () => {
  it("injects one reminder after eight silent steps and never emits it", async () => {
    const cfg = makeConfig();
    const tools = new ToolRegistry();
    tools.register(todoWriteTool());
    tools.register({
      name: "file_read",
      description: "Read a file.",
      parameters: { type: "object" },
      async run() {
        return { ok: true, content: "body" };
      },
    });

    const { ollama } = fakeModel();
    const { emit, events } = makeEmit();

    const result = await runAgent({
      cfg,
      ollama,
      tools,
      emit,
      prompt: "write the parser",
      suppressFinal: true,
      maxSteps: 11,
    });

    const reminders = result.messages.filter((m) => isReminderMessage(m));
    assert.equal(reminders.length, 1, "expected exactly one stale-todo reminder");
    assert.match(reminders[0]!.content, /task list has not been updated for 8 steps/);
    // Hidden from the UI: no event carries the reminder text.
    assert.equal(events.some((e) => JSON.stringify(e).includes("task list has not been updated")), false);
  });

  it("restarts the staleness clock after a later todo_write", async () => {
    const cfg = makeConfig();
    const tools = new ToolRegistry();
    tools.register(todoWriteTool());
    tools.register({
      name: "file_read",
      description: "Read a file.",
      parameters: { type: "object" },
      async run() {
        return { ok: true, content: "body" };
      },
    });

    // todo_write at steps 1 and 5, then silent reads. The reminder must fire
    // eight steps after the *second* update (step 13), not after the first.
    const results: ChatResult[] = [];
    const todoCall: ChatResult["toolCalls"] = [
      { function: { name: "todo_write", arguments: { todos: [{ content: "step", status: "in_progress" }] } } },
    ];
    const readCall: ChatResult["toolCalls"] = [{ function: { name: "file_read", arguments: { path: "f.ts" } } }];
    for (let step = 1; step <= 14; step++) {
      const useTodo = step === 1 || step === 5;
      results.push({
        content: "",
        model: "qwen2.5:14b",
        toolCalls: useTodo ? todoCall : readCall,
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      });
    }
    results.push({ content: "done", model: "qwen2.5:14b", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } });

    let call = 0;
    const chat = mock.fn(async () => results[Math.min(call++, results.length - 1)]!);
    const { emit } = makeEmit();

    const result = await runAgent({
      cfg,
      ollama: { chat } as unknown as OllamaClient,
      tools,
      emit,
      prompt: "write the parser",
      suppressFinal: true,
      maxSteps: 15,
    });

    const reminders = result.messages.filter((m) => isReminderMessage(m));
    assert.equal(reminders.length, 1, "the clock must restart from the latest todo_write");
    assert.match(reminders[0]!.content, /task list has not been updated for 8 steps/);
  });
});
