/**
 * End-to-end tests for jcode J8 (swarm file-touch notifications) at the agent
 * loop boundary.
 *
 * Two sessions share one workspace. Session B reads a file, then pauses inside a
 * long-running tool (the state concurrent agents actually live in); session A
 * writes the file while B is paused. When B resumes, the loop must inject a
 * hidden system-reminder carrying the path, the writer, and the short diff
 * summary, and B must NOT get a notice for a file it never read. A session that
 * finished drops its marks, so a new run is never notified about the old one.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import type { Config } from "../../config.js";
import type { OllamaClient } from "../../ollama.js";
import type { AgentEvent, Emit } from "../events.js";
import { runAgent } from "../loop.js";
import { isReminderMessage } from "../reminders.js";
import { ToolRegistry } from "../../tools/registry.js";
import { fileTools } from "../../tools/files.js";

let tmpDir = "";

function makeConfig(): Config {
  return {
    model: "qwen2.5:14b",
    fallbackModel: "qwen2.5:7b",
    workspace: tmpDir,
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

function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.registerAll(fileTools);
  tools.register({
    name: "command",
    description: "Run a shell command.",
    parameters: { type: "object" },
    async run() {
      return { ok: true, content: "(paused)" };
    },
  });
  return tools;
}

/** A model that runs a fixed list of tool calls, then answers `done`. */
function fakeModel(calls: Array<Record<string, unknown>>): OllamaClient {
  const done = { content: "done", model: "qwen2.5:14b", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
  let call = 0;
  return {
    chat: mock.fn(async () => {
      if (call >= calls.length) return done;
      const args = calls[call++]!;
      const name = args.__tool as string;
      const clean: Record<string, unknown> = { ...args };
      delete clean.__tool;
      return { content: "", model: "qwen2.5:14b", toolCalls: [{ function: { name, arguments: clean } }], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
    }),
  } as unknown as OllamaClient;
}

/**
 * A reader that is still mid-run: it reads `path`, then blocks inside a
 * long-running command tool so another session can write the file while the
 * reader's registry marks are still live. The returned model continues normally
 * once `release()` is called, so the resumed run drains the queued notice.
 */
function pauseAfter(calls: Array<Record<string, unknown>>): { ollama: OllamaClient; release: () => void } {
  const done = { content: "done", model: "qwen2.5:14b", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
  let call = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ollama = {
    chat: mock.fn(async () => {
      if (call >= calls.length) return done;
      const args = calls[call++]!;
      const name = args.__tool as string;
      const clean: Record<string, unknown> = { ...args };
      delete clean.__tool;
      if (name === "command") await gate;
      return { content: "", model: "qwen2.5:14b", toolCalls: [{ function: { name, arguments: clean } }], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
    }),
  } as unknown as OllamaClient;
  return { ollama, release };
}

/** Two steps: read the file, then start the long command that pauses. */
function fileTouchReadPlan(file: string): Array<Record<string, unknown>> {
  return [
    { __tool: "file_read", path: file },
    { __tool: "command", command: "pause", timeoutMs: 60_000 },
  ];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-filetouch-loop-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("file-touch notices in the agent loop", () => {
  it("notifies session B when session A writes a file B read", async () => {
    fs.writeFileSync(path.join(tmpDir, "shared.ts"), "alpha\nbeta\n", "utf8");

    // Session B reads the file and then pauses mid-run (long-running tools are
    // where concurrent agents actually live), so its reader mark is still live.
    const resumeB = pauseAfter(fileTouchReadPlan("shared.ts"));
    const { emit, events } = makeEmit();
    const bRun = runAgent({
      cfg: makeConfig(),
      ollama: resumeB.ollama,
      tools: registry(),
      emit,
      prompt: "read the shared file",
      suppressFinal: true,
      maxSteps: 6,
      sessionId: "loop-test-b",
    });
    // Give B time to read the file and block inside the long-running command.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Session A reads then writes the file B read while B is paused mid-run.
    // (A must read first: file_write guards against editing an unread file.)
    await runAgent({
      cfg: makeConfig(),
      ollama: fakeModel([
        { __tool: "file_read", path: "shared.ts" },
        { __tool: "file_write", path: "shared.ts", content: "alpha\nBETA\ngamma\n" },
      ]),
      tools: registry(),
      emit: makeEmit().emit,
      prompt: "update the shared file",
      suppressFinal: true,
      maxSteps: 3,
      sessionId: "loop-test-a",
    });

    // Session B resumes: the notice must arrive as a hidden reminder.
    resumeB.release();
    const b = await bRun;
    const reminders = b.messages.filter(isReminderMessage);
    assert.equal(reminders.length, 1, "B must be told the file it read changed");
    assert.match(reminders[0]!.content, /shared\.ts/);
    assert.match(reminders[0]!.content, /loop-test-a/);
    assert.match(reminders[0]!.content, /\+2\/-1/);
    // Hidden from the UI: no event carries the notice text. (Tool events may
    // legitimately mention the file path, but never the notice wording.)
    assert.equal(events.some((e) => JSON.stringify(e).includes("you already read")), false);
  });

  it("sends no notice for a file the session never read", async () => {
    fs.writeFileSync(path.join(tmpDir, "other.ts"), "alpha\n", "utf8");

    await runAgent({
      cfg: makeConfig(),
      ollama: fakeModel([
        { __tool: "file_read", path: "other.ts" },
        { __tool: "file_write", path: "other.ts", content: "beta\n" },
      ]),
      tools: registry(),
      emit: makeEmit().emit,
      prompt: "write a file",
      suppressFinal: true,
      maxSteps: 3,
      sessionId: "loop-test-a2",
    });

    const { emit } = makeEmit();
    const after = await runAgent({
      cfg: makeConfig(),
      ollama: fakeModel([]),
      tools: registry(),
      emit,
      prompt: "continue",
      suppressFinal: true,
      maxSteps: 3,
      sessionId: "loop-test-b2",
    });

    assert.equal(after.messages.filter(isReminderMessage).length, 0);
  });

  it("does not notify a session after it has finished (marks are dropped)", async () => {
    fs.writeFileSync(path.join(tmpDir, "shared.ts"), "alpha\n", "utf8");

    // B finishes its run, so its reader mark is dropped on exit.
    await runAgent({
      cfg: makeConfig(),
      ollama: fakeModel([{ __tool: "file_read", path: "shared.ts" }]),
      tools: registry(),
      emit: makeEmit().emit,
      prompt: "read the file",
      suppressFinal: true,
      maxSteps: 3,
      sessionId: "loop-test-b3",
    });

    await runAgent({
      cfg: makeConfig(),
      ollama: fakeModel([
        { __tool: "file_read", path: "shared.ts" },
        { __tool: "file_write", path: "shared.ts", content: "beta\n" },
      ]),
      tools: registry(),
      emit: makeEmit().emit,
      prompt: "write the file",
      suppressFinal: true,
      maxSteps: 3,
      sessionId: "loop-test-a3",
    });

    // B starts a brand-new run: no stale notice from the previous one.
    const { emit } = makeEmit();
    const after = await runAgent({
      cfg: makeConfig(),
      ollama: fakeModel([]),
      tools: registry(),
      emit,
      prompt: "continue",
      suppressFinal: true,
      maxSteps: 3,
      sessionId: "loop-test-b3",
    });

    assert.equal(after.messages.filter(isReminderMessage).length, 0);
  });
});
