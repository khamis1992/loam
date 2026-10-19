import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { runAgent } from "../agent/loop.js";
import { runOrchestratedAgent } from "../agent/orchestrator.js";
import type { ExecutionCheckpoint } from "../agent/checkpoint.js";
import type { AgentEvent } from "../agent/events.js";
import type { OllamaClient, ChatOptions } from "../ollama.js";
import { ToolRegistry } from "../tools/registry.js";
import { acceptanceAuditFixture } from './acceptanceAuditFixture.js';

for (const mode of ["direct", "trivial", "planned"] as const) {
  const cfg = loadConfig(); cfg.workspace = fs.mkdtempSync(path.join(os.tmpdir(), `loam-acceptance-${mode}-`));
  const manifest = path.join(cfg.workspace, "app-verification.json");
  const baseline = JSON.stringify({ entry: "index.html", scenarios: [{ name: "increment", steps: [{ action: "textExact", selector: "#count", value: "1" }] }] });
  fs.writeFileSync(manifest, baseline);
  // Missing application first fails runtime verification. The repair worker
  // then tries to weaken its expected result instead of creating the app.
  const tools = new ToolRegistry();
  tools.register({ name: "file_write", description: "fixture repair", parameters: {}, run: async () => { fs.writeFileSync(manifest, baseline.replace('"value":"1"', '"value":"0"')); return { ok: true, content: "saved" }; } });
  let workerCalls = 0;
  const client = { chat: async (o: ChatOptions) => {
    const audit = acceptanceAuditFixture(o);
    if (audit) return { model: 'fixture', content: audit, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
    const system = o.messages[0]?.content ?? "";
    let content = "done"; let toolCalls: Array<{ function: { name: string; arguments: object } }> = [];
    if (system.includes("planner role")) content = JSON.stringify({ goal: "counter", trivial: mode === "trivial", steps: [{ id: "s1", title: "Build counter", instruction: "Build requested counter", successCriteria: "Counter works" }] });
    else if (system.includes("ONE executed plan step")) content = JSON.stringify({ verdict: "pass", reason: "fixture", fixes: [] });
    else {
      assert.ok(!system.includes("COMPLETED task as a whole"), "weakened acceptance must stop before final model judgment");
      workerCalls++;
      if (workerCalls === 2) { content = "repair"; toolCalls = [{ function: { name: "file_write", arguments: {} } }]; }
    }
    return { model: "fixture", content, toolCalls, usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
  } } as unknown as OllamaClient;
  const events: AgentEvent[] = []; let checkpoint: ExecutionCheckpoint | undefined;
  const options = { cfg, tools, ollama: client, prompt: "Build counter", emit: (e: AgentEvent) => events.push(e), maxSteps: 6 };
  await assert.rejects(mode === "direct" ? runAgent(options) : runOrchestratedAgent({ ...options, saveCheckpoint: c => { checkpoint = c; } }), /Frozen acceptance/);
  assert.ok(!events.some(e => e.type === "done" || e.type === "assistant_message"));
  if (mode !== "direct") {
    assert.equal(checkpoint?.acceptanceContract, baseline);
    const before = workerCalls;
    await assert.rejects(runOrchestratedAgent({ ...options, resume: JSON.parse(JSON.stringify(checkpoint)) }), /Frozen acceptance/);
    assert.equal(workerCalls, before, "resumed terminal checkpoint must not replay worker side effects");
  }
  console.log(`PASS ${mode}: weakened repair never emits completion${mode !== "direct" ? "; serialized checkpoint retains the acceptance baseline" : ""}`);
}
