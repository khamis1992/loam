import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { critiqueStep } from "../agent/verifier.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ChatOptions, OllamaClient } from "../ollama.js";

for (const withTools of [false, true]) for (const mode of ["recover", "invalid", "reject", "outage"] as const) {
  const cfg = loadConfig(); cfg.fallbackModel = cfg.model;
  const tools = new ToolRegistry();
  tools.register({ name: "file_read", description: "read", parameters: {}, run: async () => ({ ok: true, content: "fixture" }) });
  let calls = 0, paid = 0;
  const ollama = { chat: async (o: ChatOptions) => {
    calls++;
    if (mode === "outage" && calls === 2) throw new Error("fixture outage");
    paid++;
    if (calls === 2) assert.ok(o.messages.at(-1)?.content.includes("not a request to pass"));
    const content = mode === "reject" ? JSON.stringify({ verdict: "revise", reason: "actual defect", fixes: ["repair defect"] }) : mode === "invalid" || calls === 1 ? '{"verdict":"pass","reason":"cut off' : JSON.stringify({ verdict: "pass", reason: "same evidence re-evaluated", fixes: [] });
    return { model: "fixture", content, toolCalls: [], usage: { promptTokens: 2, completionTokens: 3, durationMs: 4 } };
  } } as unknown as OllamaClient;
  const result = await critiqueStep({ cfg, ollama, ...(withTools ? { tools } : {}), goal: "report", request: "report", step: { id: "s1", title: "report", instruction: "report", successCriteria: "complete" }, stepIndex: 0, totalSteps: 1, attempt: 1, maxAttempts: 2, workerText: "evidence", trace: [] });
  assert.equal(result.verdict, mode === "recover" ? "pass" : "revise");
  assert.equal(calls, mode === "reject" ? 1 : 2, "never reroll a valid semantic rejection");
  assert.equal(result.usage.promptTokens, paid * 2, "format retry and later outage preserve known usage");
  console.log(`PASS verdict recovery tools=${withTools} ${mode}`);
}

// Five useful reads must still leave room for a grounded terminal decision.
for (const accepted of [true, false]) {
  const cfg = loadConfig(); let calls = 0, reads = 0;
  const tools = new ToolRegistry();
  tools.register({ name: "file_read", description: "read chunk", parameters: {}, run: async () => ({ ok: true, content: `chunk ${++reads}` }) });
  const ollama = { chat: async (o: ChatOptions) => {
    calls++;
    const toolCalls = calls <= 5 ? [{ function: { name: "file_read", arguments: {} } }] : [];
    if (calls === 6) {
      assert.equal(o.tools, undefined);
      assert.equal(o.messages.filter(m => m.role === "tool").length, 5);
      assert.match(o.messages.at(-1)!.content, /Never pass merely/);
    }
    return { model: "fixture", content: toolCalls.length ? "" : JSON.stringify({ verdict: accepted ? "pass" : "revise", reason: "all five reads inspected", fixes: accepted ? [] : ["missing requirement"] }), toolCalls, usage: { promptTokens: 2, completionTokens: 3, durationMs: 4 } };
  } } as unknown as OllamaClient;
  const result = await critiqueStep({ cfg, ollama, tools, goal: "review", request: "review", step: { id: "s1", title: "review", instruction: "inspect", successCriteria: "complete" }, stepIndex: 0, totalSteps: 1, attempt: 1, maxAttempts: 2, workerText: "saved", trace: [] });
  assert.equal(result.verdict, accepted ? "pass" : "revise");
  assert.equal(reads, 5); assert.equal(calls, 6); assert.equal(result.usage.promptTokens, 12);
  console.log(`PASS reserved judgment after five reads: accepted=${accepted}`);
}
