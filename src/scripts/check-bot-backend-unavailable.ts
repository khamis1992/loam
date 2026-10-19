import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { runAgent } from "../agent/loop.js";
import { runOrchestratedAgent } from "../agent/orchestrator.js";
import type { ExecutionCheckpoint } from "../agent/checkpoint.js";
import type { AgentEvent } from "../agent/events.js";
import type { ChatOptions, OllamaClient } from "../ollama.js";
import { ToolRegistry } from "../tools/registry.js";
import { acceptanceAuditFixture } from './acceptanceAuditFixture.js';

for (const mode of ["direct", "planned"] as const) {
  const cfg = loadConfig(); cfg.workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-backend-unavailable-")); cfg.fallbackModel = cfg.model;
  fs.writeFileSync(path.join(cfg.workspace, "index.html"), "<h1>Preserve me</h1>");
  fs.writeFileSync(path.join(cfg.workspace, "server.mjs"), "// Preserve source while Docker is unavailable");
  fs.writeFileSync(path.join(cfg.workspace, "app-verification.json"), JSON.stringify({ entry: "index.html", runtime: { type: "node", entry: "server.mjs" }, scenarios: [{ name: "page", steps: [{ action: "visible", selector: "h1" }] }] }));
  let workers = 0;
  const events: AgentEvent[] = [];
  let checkpoint: ExecutionCheckpoint | undefined;
  const ollama = { chat: async (o: ChatOptions) => {
    const system = o.messages[0]?.content ?? "";
    let content: string;
    const audit = acceptanceAuditFixture(o);
    if (audit) content = audit;
    else if (system.includes("planner role")) content = JSON.stringify({ goal: "verify app", trivial: false, steps: [{ id: "s1", title: "draft", instruction: "report existing application", successCriteria: "report ready" }] });
    else if (system.includes("ONE executed plan step")) content = JSON.stringify({ verdict: "pass", reason: "draft ready" });
    else { workers++; content = "Application files are ready for verification"; }
    return { model: "fixture", content, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
  } } as unknown as OllamaClient;
  const savedPath = process.env.PATH;
  try {
    // Only this test process loses Docker discovery. Never stop the real daemon.
    process.env.PATH = "";
    const options = { cfg, ollama, tools: new ToolRegistry(), prompt: "Verify the existing application", emit: (e: AgentEvent) => events.push(e) };
    await assert.rejects(mode === "direct" ? runAgent(options) : runOrchestratedAgent({ ...options, saveCheckpoint: c => { checkpoint = c; } }), /Independent verification unavailable/);
  } finally { process.env.PATH = savedPath; }
  assert.equal(workers, 1, "infrastructure failure must not invoke a code repair worker");
  assert.ok(!events.some(e => e.type === "done" || e.type === "assistant_message" || e.type === "revise"));
  if (mode === "planned") { assert.equal(checkpoint?.finalRepairUsed, false); assert.equal(checkpoint?.nextStep, 1); }
  assert.equal(fs.readFileSync(path.join(cfg.workspace, "server.mjs"), "utf8"), "// Preserve source while Docker is unavailable");
  console.log(`PASS ${mode}: unavailable Docker blocks completion without repairing source or consuming final repair allowance`);
}
