/**
 * O6 integration: the agent loop's step-boundary admit hook (BUILD_SPEC §6.6).
 *
 * `inputQueue.test.ts` covers the queue in isolation. This file covers the real
 * boundary: a message that arrives *while a run is busy* must be admitted by the
 * loop and become exactly one durable `input` event.
 *
 * A scripted fake Ollama client is used, so no model or network is involved. The
 * message is enqueued from inside a tool call, which is the closest a test can get
 * to "the user typed while the agent was working".
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-inputadmit-"));
process.env.LOAM_DATA_DIR = tmpDir;
process.env.MANUS_LOCAL_DATA_DIR = tmpDir;

import { loadConfig } from "../../config.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { ChatResult, OllamaClient, OllamaToolCall } from "../../ollama.js";
import type { AgentEvent } from "../../agent/events.js";
import { runAgent } from "../../agent/loop.js";
import { closeDb, resetDb } from "../sqliteStore.js";
import { after as afterSeq, headSeq } from "../../protocol/eventLog.js";
import { admitPending, enqueue, newInputId, pending } from "../inputQueue.js";

function fixtureCfg(): ReturnType<typeof loadConfig> {
  const cfg = loadConfig();
  cfg.compression = { ...cfg.compression, enabled: false };
  cfg.fallbackModel = cfg.model;
  return cfg;
}

describe("input queue admit hook (agent loop)", () => {
  before(() => {
    closeDb();
    resetDb();
  });

  after(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("admits a message that arrives mid-run, exactly once, at a step boundary", async () => {
    const sessionId = "s_midrun";
    // The first step calls a tool; enqueueing from inside it models the user
    // hitting send while the run was busy. The second step is a plain answer.
    let calls = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "file_read",
      description: "mid-run enqueue",
      parameters: {},
      run: async () => {
        enqueue({ id: newInputId(), sessionId, text: "typed while busy", delivery: "queued" });
        return { ok: true, content: "Observed result" };
      },
    });
    const ollama = {
      chat: async (): Promise<ChatResult> => {
        calls += 1;
        const first = calls === 1;
        const toolCalls: OllamaToolCall[] = first ? [{ function: { name: "file_read", arguments: {} } }] : [];
        return {
          content: first ? "" : "final answer",
          model: "fixture-model",
          toolCalls,
          usage: { promptTokens: 10, completionTokens: 5, durationMs: 1 },
        };
      },
      listModels: async () => [],
    } as unknown as OllamaClient;

    // The message is queued but not yet a durable event.
    const admittedSeqs: number[] = [];
    await runAgent({
      cfg: fixtureCfg(),
      ollama,
      tools: registry,
      prompt: "Scripted task",
      emit: (_e: AgentEvent) => {},
      maxSteps: 5,
      suppressFinal: true,
      inputSessionId: sessionId,
      onAdmitPending: (id: string) => {
        const admitted = admitPending(id);
        admittedSeqs.push(...admitted.map((a) => a.admittedSeq ?? -1));
        return admitted;
      },
    });

    assert.equal(calls, 2, "one tool step plus one final answer");
    // Exactly one admission, and it landed in the log as a single `input` event.
    assert.deepEqual(admittedSeqs, [1]);
    assert.equal(headSeq(sessionId), 1);
    const rows = afterSeq(sessionId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "input");
    const payload = rows[0]!.payload as { text: string; actor: string; inputId: string };
    assert.equal(payload.text, "typed while busy");
    assert.equal(payload.actor, "user");
    assert.ok(payload.inputId.startsWith("input_"), `expected a generated input id, got ${payload.inputId}`);
    // Nothing is left waiting.
    assert.deepEqual(pending(sessionId), []);
  });

  it("does not admit anything when no hook is wired", async () => {
    const sessionId = "s_nohook";
    enqueue({ id: newInputId(), sessionId, text: "nobody drains me", delivery: "queued" });
    const ollama = {
      chat: async (): Promise<ChatResult> => ({
        content: "final answer",
        model: "fixture-model",
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5, durationMs: 1 },
      }),
      listModels: async () => [],
    } as unknown as OllamaClient;

    await runAgent({
      cfg: fixtureCfg(),
      ollama,
      tools: new ToolRegistry(),
      prompt: "Scripted task",
      emit: (_e: AgentEvent) => {},
      maxSteps: 2,
      suppressFinal: true,
      inputSessionId: sessionId,
      // no onAdmitPending
    });

    // Still waiting, and nothing was written to the log: the hook is the only
    // path that admits, so an unwired caller cannot silently consume the queue.
    assert.equal(pending(sessionId).length, 1);
    assert.equal(headSeq(sessionId), 0);
  });

  it("never fails the run when the admit hook throws", async () => {
    const sessionId = "s_hookfails";
    enqueue({ id: newInputId(), sessionId, text: "boom", delivery: "queued" });
    const ollama = {
      chat: async (): Promise<ChatResult> => ({
        content: "final answer",
        model: "fixture-model",
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5, durationMs: 1 },
      }),
      listModels: async () => [],
    } as unknown as OllamaClient;

    const events: AgentEvent[] = [];
    const result = await runAgent({
      cfg: fixtureCfg(),
      ollama,
      tools: new ToolRegistry(),
      prompt: "Scripted task",
      emit: (e: AgentEvent) => events.push(e),
      maxSteps: 2,
      suppressFinal: true,
      inputSessionId: sessionId,
      onAdmitPending: () => {
        throw new Error("queue unavailable");
      },
    });

    // The run completed, and the failure surfaced as an event instead of throwing.
    assert.equal(result.text, "final answer");
    const errors = events.filter((e) => e.type === "error");
    assert.equal(errors.length, 1);
    assert.match((errors[0] as { message: string }).message, /failed to admit a queued message: queue unavailable/);
    // The message is still queued, so a later boundary can retry it.
    assert.equal(pending(sessionId).length, 1);
  });
});
