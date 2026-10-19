import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { runOrchestratedAgent } from "../agent/orchestrator.js";
import type { ExecutionCheckpoint } from "../agent/checkpoint.js";
import type { AgentEvent } from "../agent/events.js";
import type { ChatOptions, OllamaClient } from "../ollama.js";
import { ToolRegistry } from "../tools/registry.js";

for (const scenario of ["before-tool", "after-tool", "reject"] as const) {
  const cfg = loadConfig(); cfg.workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-final-repair-resume-")); cfg.fallbackModel = cfg.model;
  const controller = new AbortController();
  let checkpoint: ExecutionCheckpoint | undefined;
  let writes = 0, reviews = 0, calls = 0;
  const tools = new ToolRegistry();
  tools.register({ name: "file_write", description: "append correction", parameters: {}, run: async () => {
    writes++; fs.appendFileSync(path.join(cfg.workspace, "corrected.txt"), "correction\n");
    return { ok: true, content: "correction appended" };
  } });
  tools.register({ name: "file_read", description: "read correction", parameters: {}, run: async () => ({ ok: true, content: fs.existsSync(path.join(cfg.workspace, "corrected.txt")) ? fs.readFileSync(path.join(cfg.workspace, "corrected.txt"), "utf8") : "missing" }) });
  const client = { chat: async (o: ChatOptions) => {
    calls++;
    const system = o.messages[0]?.content ?? "";
    let content = "stale answer";
    let toolCalls: Array<{ function: { name: string; arguments: object } }> = [];
    if (system.includes("planner role")) content = JSON.stringify({ goal: "correct report", trivial: false, steps: [{ id: "s1", title: "draft", instruction: "draft report", successCriteria: "draft exists" }] });
    else if (system.includes("ONE executed plan step")) content = JSON.stringify({ verdict: "pass", reason: "draft reviewed" });
    else if (system.includes("COMPLETED task as a whole")) {
      if (writes && !o.messages.some(m => m.role === "tool")) { content = ""; toolCalls = [{ function: { name: "file_read", arguments: {} } }]; }
      else {
        reviews++;
        const pass = writes > 0 && scenario !== "reject" && o.messages.some(m => m.content.includes("corrected answer"));
        content = JSON.stringify({ verdict: pass ? "pass" : "revise", reason: "inspect current correction and answer", fixes: pass ? [] : ["append correction and return corrected answer"] });
      }
    } else if (o.messages.some(m => m.role === "user" && m.content.includes("Fix the final answer now"))) {
      if (o.messages.some(m => m.role === "tool")) content = "corrected answer";
      else { content = ""; toolCalls = [{ function: { name: "file_write", arguments: {} } }]; }
    }
    return { model: "fixture", content, toolCalls, usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
  } } as unknown as OllamaClient;
  const events: AgentEvent[] = [];
  const options = { cfg, ollama: client, tools, prompt: "Create correct report", emit: (e: AgentEvent) => events.push(e) };
  await assert.rejects(runOrchestratedAgent({ ...options, signal: controller.signal, saveCheckpoint: cp => {
    checkpoint = structuredClone(cp);
    if (cp.finalRepairPrompt && (scenario === "before-tool" || cp.worker)) controller.abort();
  } }), /cancel/i);
  assert.ok(checkpoint?.inFlight && checkpoint.finalRepairPrompt);
  assert.equal(writes, scenario === "before-tool" ? 0 : 1);
  assert.ok(!events.some(e => e.type === "done" || e.type === "assistant_message"));
  const resumeCheckpoint=JSON.parse(JSON.stringify(checkpoint));
  if(scenario==='after-tool')delete resumeCheckpoint.finalRepairAttempts; // legacy checkpoint counts its used repair as one
  const resumed = runOrchestratedAgent({ ...options, resume: resumeCheckpoint, saveCheckpoint:cp=>{checkpoint=structuredClone(cp);} });
  if (scenario === "reject") {
    await assert.rejects(resumed, /final verification still failed/);
    assert.ok(!events.some(e => e.type === "done" || e.type === "assistant_message"));
  } else {
    const result = await resumed;
    assert.equal(result.verified, true);
    assert.equal(result.text, "corrected answer");
    assert.equal(result.usage.promptTokens, calls, "retained repair usage is counted once");
    const gate = events.findIndex(e => e.type === "verify" && e.verdict === "pass");
    assert.ok(gate >= 0 && events.findIndex(e => e.type === "done") > gate);
  }
  const expectedRepairs=scenario==='reject'?2:1;
  assert.equal(writes, expectedRepairs);
  assert.equal(fs.readFileSync(path.join(cfg.workspace, "corrected.txt"), "utf8"), "correction\n".repeat(expectedRepairs));
  assert.equal(reviews, expectedRepairs+1, "every bounded repair gets a fresh judgment");
  assert.equal(checkpoint?.finalRepairAttempts,expectedRepairs);
  if(scenario==='reject'){
    await assert.rejects(runOrchestratedAgent({...options,resume:structuredClone(checkpoint!)}),/final verification still failed/);
    assert.equal(writes,2,'Resume cannot reset the exhausted repair allowance');
    assert.ok(!events.some(e=>e.type==='done'||e.type==='assistant_message'));
  }
  console.log(`PASS final repair resume ${scenario}: persisted instruction, retained tools, bounded attempts, mandatory fresh judgment`);
}
