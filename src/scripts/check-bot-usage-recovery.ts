import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { runOrchestratedAgent } from "../agent/orchestrator.js";
import type { ExecutionCheckpoint } from "../agent/checkpoint.js";
import type { ChatOptions, OllamaClient } from "../ollama.js";
import { ToolRegistry } from "../tools/registry.js";
for (const failure of ["budget", "provider"] as const) {
  const cfg = loadConfig(); cfg.workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-usage-"));
  cfg.fallbackModel = cfg.model; cfg.orchestrator.maxStepsPerWorker = 2; cfg.orchestrator.maxReplans = 1;
  const tools = new ToolRegistry();
  tools.register({ name: "file_read", description: "inspect fixture", parameters: {}, run: async () => ({ ok: true, content: "Observed result" }) });
  let workers = 0, returnedCalls = 0; const checkpoints: ExecutionCheckpoint[] = [];
  const client = { chat: async (o: ChatOptions) => {
    const system = o.messages[0]?.content ?? "";
    let content = JSON.stringify({ verdict: "pass", reason: "inspected", fixes: [] });
    let toolCalls: Array<{ function: { name: string; arguments: object } }> = [];
    if (system.includes("planner role")) content = JSON.stringify({ goal: "inspect", trivial: false, steps: [{ id: "s1", title: "inspect", instruction: "inspect", successCriteria: "observed" }] });
    else if (system.includes("COMPLETED task as a whole")) {
      if (!o.messages.some(m => m.role === "tool")) { content = ""; toolCalls = [{ function: { name: "file_read", arguments: {} } }]; }
    } else if (!system.includes("ONE executed plan step")) {
      workers++;
      if (failure === "provider" && workers === 2) throw new Error("simulated provider outage after paid response");
      if (workers <= 2) { content = ""; toolCalls = [{ function: { name: "file_read", arguments: {} } }]; }
      else content = "Observed result";
    }
    returnedCalls++;
    return { model: "fixture", content, toolCalls, usage: { promptTokens: 11, completionTokens: 7, durationMs: 13 } };
  } } as unknown as OllamaClient;
  const options = { cfg, ollama: client, tools, prompt: "Inspect fixture", emit: () => {}, saveCheckpoint: (c: ExecutionCheckpoint) => checkpoints.push(c) };
  const run = await runOrchestratedAgent(options);
  assert.equal(run.verified, true);
  assert.deepEqual(run.usage, { promptTokens: returnedCalls * 11, completionTokens: returnedCalls * 7, durationMs: returnedCalls * 13 }, "known usage from failed workers must not vanish");
  assert.equal(run.steps, 7, "two attempts in failed worker plus recovered worker and orchestration calls");
  const saved = checkpoints.at(-1)!;
  assert.deepEqual(saved.usage, run.usage);
  assert.equal(saved.totalSteps, run.steps);
  const beforeCalls = returnedCalls, beforeWorkers = workers;
  const resumed = await runOrchestratedAgent({ ...options, resume: JSON.parse(JSON.stringify(saved)) });
  assert.equal(workers, beforeWorkers, "verified checkpoint must not replay worker effects");
  assert.equal(resumed.usage.promptTokens, run.usage.promptTokens + (returnedCalls - beforeCalls) * 11, "resume adds only new verifier usage");
  console.log(`PASS ${failure}: failed-worker known usage and attempted steps retained through recovery and checkpoint resume`);
}
