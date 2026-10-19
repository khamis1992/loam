import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { runAgent } from "../agent/loop.js";
import type { AgentEvent } from "../agent/events.js";
import type { ChatOptions, OllamaClient } from "../ollama.js";
import { ToolRegistry } from "../tools/registry.js";

for (const scenario of ["recover", "repeated", "budget", "cancel", "gate-reject"] as const) {
  const cfg = loadConfig();
  cfg.workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-empty-recovery-"));
  cfg.fallbackModel = cfg.model;
  const abort = new AbortController();
  const events: AgentEvent[] = [];
  let calls = 0, executorCalls = 0, writes = 0, reads = 0;
  const tools = new ToolRegistry();
  tools.register({ name: "file_write", description: "write fixture", parameters: {}, run: async () => { writes++; return { ok: true, content: "saved once" }; } });
  tools.register({ name: "file_read", description: "inspect fixture", parameters: {}, run: async () => { reads++; return { ok: true, content: "saved once" }; } });
  const client = { chat: async (o: ChatOptions) => {
    calls++;
    let content = "", toolCalls: Array<{ function: { name: string; arguments: object } }> = [];
    if (o.messages[0]?.content.includes("COMPLETED task as a whole")) {
      if (!o.messages.some(m => m.role === "tool")) toolCalls = [{ function: { name: "file_read", arguments: {} } }];
      else content = JSON.stringify({ verdict: scenario === "gate-reject" ? "fail" : "pass", reason: "inspected fixture", fixes: scenario === "gate-reject" ? ["result is incorrect"] : [] });
    } else {
      executorCalls++;
      if (executorCalls === 1) toolCalls = [{ function: { name: "file_write", arguments: {} } }];
      else if (executorCalls >= 3 && scenario !== "repeated") {
        assert.ok(o.messages.some(m => m.role === "tool" && m.content.includes("saved once")), "recovery retains prior effects");
        content = "Saved fixture";
      }
    }
    return { model: "fixture", content, toolCalls, usage: { promptTokens: 11, completionTokens: 7, durationMs: 13 } };
  } } as unknown as OllamaClient;
  let lastUsage = { promptTokens: 0, completionTokens: 0, durationMs: 0 };
  const run = runAgent({ cfg, ollama: client, tools, prompt: "Save fixture", maxSteps: scenario === "budget" ? 2 : 8, signal: abort.signal,
    onProgress: p => { lastUsage = p.usage; },
    emit: event => { events.push(event); if (scenario === "cancel" && event.type === "error") abort.abort(); },
  });
  if (scenario === "recover") {
    const result = await run;
    assert.equal(result.verified, true);
    assert.equal(result.steps, 3);
    assert.deepEqual(result.usage, { promptTokens: calls * 11, completionTokens: calls * 7, durationMs: calls * 13 });
    assert.ok(reads > 0);
    const gate = events.findIndex(e => e.type === "verify" && e.verdict === "pass");
    assert.ok(gate >= 0 && events.findIndex(e => e.type === "done") > gate);
  } else {
    await assert.rejects(run, scenario === "cancel" ? /cancel/i : scenario === "gate-reject" ? /verification/i : /empty answer/);
    assert.ok(!events.some(e => e.type === "done" || e.type === "assistant_message"));
    if (scenario !== "gate-reject") assert.equal(lastUsage.promptTokens, calls * 11);
  }
  assert.equal(writes, 1, "recovery must not automatically replay tool effects");
  if (scenario === "repeated") assert.equal(executorCalls, 3);
  if (scenario === "budget" || scenario === "cancel") assert.equal(executorCalls, 2);
  console.log(`PASS ${scenario}: bounded recovery, retained effects, accounting, mandatory gate`);
}
