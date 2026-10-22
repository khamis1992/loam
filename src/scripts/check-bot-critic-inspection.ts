import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { critiqueStep } from "../agent/verifier.js";
import { runOrchestratedAgent } from "../agent/orchestrator.js";
import type { ChatOptions, OllamaClient } from "../ollama.js";
import { ToolRegistry } from "../tools/registry.js";

const cfg = loadConfig();
cfg.workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-critic-inspection-"));
cfg.fallbackModel = cfg.model;
const source = "function shutdown() { setTimeout(() => process.exit(0), 2000); }\nprocess.on('SIGTERM', shutdown);";
fs.writeFileSync(path.join(cfg.workspace, "server.mjs"), source);
const tools = new ToolRegistry();
let reads = 0, mutations = 0;
tools.register({ name: "file_read", description: "read actual fixture", parameters: {}, run: async () => { reads++; return { ok: true, content: fs.readFileSync(path.join(cfg.workspace, "server.mjs"), "utf8") }; } });
tools.register({ name: "file_write", description: "forbidden repair", parameters: {}, run: async () => { mutations++; return { ok: true, content: "modified" }; } });
const reply = (content: string, name?: string) => ({ model: "fixture", content, toolCalls: name ? [{ function: { name, arguments: {} } }] : [], usage: { promptTokens: 2, completionTokens: 3, durationMs: 4 } });
const pass = JSON.stringify({ verdict: "pass", reason: "current file inspected: timer only in SIGTERM handler", fixes: [] });

for (const mode of ["read", "denied", "budget", "cancel"] as const) {
  let calls = 0;
  const abort = new AbortController();
  const client = { chat: async (o: ChatOptions) => {
    calls++;
    if (calls <= 5) assert.ok(o.tools?.some(t => t.function.name === "file_read"));
    else assert.equal(o.tools, undefined, "final budget turn is judgment-only");
    assert.ok(!o.tools?.some(t => t.function.name === "file_write"));
    if (calls === 1 || mode === "budget") return reply("", mode === "denied" ? "file_write" : "file_read");
    const observed = o.messages.find(m => m.role === "tool")!;
    if (mode === "denied") { assert.match(observed.content, /unknown|denied|not.*allow/i); return reply(JSON.stringify({ verdict: "revise", reason: "inspection denied", fixes: ["inspect read-only"] })); }
    assert.equal(observed.content, source);
    return reply(pass);
  } } as unknown as OllamaClient;
  const result = critiqueStep({ cfg, ollama: client, tools, goal: "create server", request: "create server", step: { id: "s1", title: "server", instruction: "create server", successCriteria: "no unconditional exit timer" }, stepIndex: 0, totalSteps: 1, attempt: 1, maxAttempts: 2, workerText: "saved", trace: [{ name: "file_search", ok: true, summary: "setTimeout(() => process.exit(0), 2000)" }], signal: abort.signal,
    emit: event => { if (mode === "cancel" && event.type === "tool_result") abort.abort(); },
  });
  if (mode === "cancel") await assert.rejects(result, /cancel/i);
  else {
    const verdict = await result;
    assert.equal(verdict.verdict, mode === "read" ? "pass" : "revise");
    assert.equal(verdict.usage.promptTokens, calls * 2);
    if (mode === "budget") assert.equal(calls, 6);
  }
  assert.equal(mutations, 0);
  console.log(`PASS critic ${mode}`);
}

let workerCalls = 0, criticReads = 0;
const client = { chat: async (o: ChatOptions) => {
  const system = o.messages[0]?.content ?? "";
  if (system.includes("planner role")) return reply(JSON.stringify({ goal: "inspect server", trivial: false, steps: [{ id: "s1", title: "server", instruction: "inspect", successCriteria: "conditional shutdown" }] }));
  if (system.includes("ONE executed plan step") || system.includes("COMPLETED task as a whole")) {
    if (!o.messages.some(m => m.role === "tool")) { if (system.includes("ONE executed")) criticReads++; return reply("", "file_read"); }
    return reply(pass);
  }
  workerCalls++;
  return reply("The existing shutdown handler is conditional.");
} } as unknown as OllamaClient;
const result = await runOrchestratedAgent({ cfg, ollama: client, tools, prompt: "Inspect shutdown handler", emit: () => {} });
assert.equal(result.verified, true);
assert.equal(workerCalls, 1, "critic can resolve incomplete evidence without re-executing the worker");
assert.equal(criticReads, 1);
assert.equal(mutations, 0);
assert.ok(reads > 0);
console.log("PASS orchestrated critic inspection with mandatory independent final gate");
