/** Real-model, real-file acceptance; never silently skips unavailable models. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { probeInvoice } from "./invoice-behavior-probe.js";
const output = path.resolve(`docs/evidence/bot-verification-live-${Date.now()}.json`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-bot-live-"));
process.env.MANUS_LOCAL_DATA_DIR = path.join(root, "data");
process.env.MANUS_LOCAL_SKILLS_DIR = path.join(root, "skills");
const { loadConfig } = await import("../config.js");
const { OllamaClient } = await import("../ollama.js");
const { ToolRegistry } = await import("../tools/registry.js");
const { fileTools } = await import("../tools/files.js");
const { runAgent } = await import("../agent/loop.js");
const { runOrchestratedAgent } = await import("../agent/orchestrator.js");
const { verifyFinal } = await import("../agent/verifier.js");
import type { AgentEvent } from "../agent/events.js";
const cfg = loadConfig();
cfg.workspace = path.join(root, "workspace");
fs.mkdirSync(cfg.workspace, { recursive: true });
cfg.model = process.env.LOAM_BOT_TEST_MODEL || "glm-5.3-flash:cloud";
cfg.fallbackModel = cfg.model;
cfg.orchestrator.plannerModel = cfg.model;
cfg.orchestrator.verifierModel = cfg.model;
cfg.orchestrator.maxReplans = 0;
cfg.orchestrator.maxRevisionsPerStep = 1;
cfg.orchestrator.maxStepsPerWorker = 8;
cfg.orchestrator.verifyFinal = false; // Must not disable the gate.
cfg.agent.maxSteps = 10;
cfg.policy.allowOutsideWorkspaceRead = false;
const tools = new ToolRegistry();
tools.registerAll(fileTools.filter(t => ["file_read", "file_write", "file_stat", "file_list"].includes(t.name)));
const ollama = new OllamaClient(cfg.ollamaUrl);
const results: unknown[] = [];
async function check(id: string, fn: () => Promise<unknown>) {
  const start = Date.now();
  try { const details = await fn(); results.push({ id, pass: true, ms: Date.now() - start, details }); console.log(`PASS ${id}`); }
  catch (error) { results.push({ id, pass: false, ms: Date.now() - start, error: String(error) }); console.log(`FAIL ${id}: ${String(error)}`); }
}
async function execute(prompt: string, orchestrated: boolean) {
  const events: AgentEvent[] = [];
  const opts = { cfg, ollama, tools, prompt, emit: (e: AgentEvent) => events.push(e), signal: AbortSignal.timeout(240_000), systemSuffix: "Use only the supplied tools. Produce requested files inside the workspace. Do not claim tests were run; no shell is available." };
  const result = await (orchestrated ? runOrchestratedAgent(opts) : runAgent(opts));
  const done = events.findIndex(e => e.type === "done");
  assert.ok(done >= 0 && events.slice(0, done).some(e => e.type === "verify" && e.verdict === "pass"));
  assert.ok(!events.some(e => e.type === "assistant_token"));
  return { text: result.text, events };
}
await check("javascript-real-behavior-orchestrated", async () => {
  const result = await execute("Create invoice.mjs exporting function total(items). Each item has quantity and price. Return sum(quantity * price) rounded to 2 decimal places. Empty array returns 0. Throw RangeError for negative quantity or price. Use no dependencies. Save the actual file. Do not claim execution tests were run.", true);
  const behavior = await probeInvoice(cfg.workspace);
  return { ...behavior, ...result };
});
await check("arabic-csv-analysis-direct", async () => {
  fs.writeFileSync(path.join(cfg.workspace, "sales.csv"), "region,amount\nRiyadh,120\nJeddah,75\nRiyadh,30\nJeddah,-5\n");
  const result = await execute("اقرأ sales.csv ثم أنشئ sales-report.json بصيغة JSON: total لمجموع amount، وbyRegion ككائن مجموع كل منطقة، وrowCount لعدد صفوف البيانات. لا تستبعد القيم السالبة. احفظ الملف وتحقق من محتواه.", false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg.workspace, "sales-report.json"), "utf8")), { total: 220, byRegion: { Riyadh: 150, Jeddah: 70 }, rowCount: 4 });
  return result;
});
await check("reject-missing-deliverable-real-verifier", async () => {
  const verdict = await verifyFinal({ cfg, ollama, tools, request: "Create missing-report.json containing the quarterly sales report.", goal: "saved report", finalText: "Completed successfully: missing-report.json is ready.", completedSteps: [], trace: [{ name: "file_write", ok: true, summary: "claimed save of missing-report.json" }], signal: AbortSignal.timeout(120_000) });
  assert.notEqual(verdict.verdict, "pass");
  return verdict;
});
const report = { at: new Date().toISOString(), model: cfg.model, workspace: cfg.workspace, results };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(output);
if (results.some(r => !(r as { pass: boolean }).pass)) process.exitCode = 1;
