import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { runAgent } from "../agent/loop.js";
import type { WorkerCheckpoint } from "../agent/checkpoint.js";
import type { ChatOptions, OllamaClient } from "../ollama.js";
import { ToolRegistry } from "../tools/registry.js";

const cfg = loadConfig(); cfg.fallbackModel = cfg.model;
const tools = new ToolRegistry();
let writes = 0;
let saved: WorkerCheckpoint | undefined;
let lastBoundary: WorkerCheckpoint | undefined;
tools.register({ name: "file_write", description: "fixture", parameters: {}, run: async () => {
  assert.equal(saved, undefined, "invalidate stale safe boundary before executing a new effect");
  writes++;
  return { ok: true, content: `effect ${writes}` };
} });
const usage = { promptTokens: 11, completionTokens: 7, durationMs: 13 };
let phase: "first" | "resume" | "second-batch" = "first";
const client = { chat: async (o: ChatOptions) => {
  if (phase === "resume") {
    assert.ok(o.messages.some(m => m.role === "tool" && m.content === "effect 1"));
    return { model: "fixture", content: "Observed saved effect", toolCalls: [], usage };
  }
  return { model: "fixture", content: "", toolCalls: [{ function: { name: "file_write", arguments: {} } }], usage };
} } as unknown as OllamaClient;
const options = { cfg, tools, ollama: client, prompt: "Append once", suppressFinal: true, emit: () => {}, maxSteps: 3,
  saveWorker: (value: WorkerCheckpoint | undefined) => {
    saved = value;
    if (value) { lastBoundary = JSON.parse(JSON.stringify(value)); throw new Error("simulated crash after durable boundary"); }
  },
};
await assert.rejects(runAgent(options), /simulated crash/);
assert.equal(writes, 1);
const boundary = lastBoundary!;
assert.equal(boundary.steps, 1);
phase = "resume";
const result = await runAgent({ ...options, resumeWorker: boundary });
assert.equal(writes, 1);
assert.equal(result.steps, 2);
assert.deepEqual(result.usage, { promptTokens: 22, completionTokens: 14, durationMs: 26 });
assert.equal(result.verified, false, "worker resume does not bypass final orchestration verification");
await assert.rejects(runAgent({ ...options, prompt: "Different task", resumeWorker: boundary }), /does not match/);
await assert.rejects(runAgent({ ...options, maxSteps: 1, resumeWorker: boundary }), /stopped after 1 steps/);
assert.equal(writes, 1, "resume must not reset the worker budget");
phase = "second-batch";
await assert.rejects(runAgent({ ...options, resumeWorker: boundary }), /simulated crash/);
assert.equal(writes, 2);
assert.equal(lastBoundary!.trace.length, 2);
assert.equal(lastBoundary!.steps, 2);
console.log("PASS worker resume: retained tool results, accounting, budget, task binding and invalidation before new effects");
