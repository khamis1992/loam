import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { OllamaClient } from "../ollama.js";
import { runOrchestratedAgent } from "../agent/orchestrator.js";
import type { ExecutionCheckpoint } from "../agent/checkpoint.js";
import type { AgentEvent } from "../agent/events.js";
import { ToolRegistry } from "../tools/registry.js";

const childMode = process.argv.indexOf("--child");
if (childMode >= 0) {
  const workspace = process.argv[childMode + 1]!;
  const resume = process.argv.includes("--resume");
  const cfg = loadConfig(); cfg.workspace = workspace;
  const checkpointPath = path.join(workspace, "checkpoint.json");
  const ledger = path.join(workspace, "ledger.jsonl");
  const events: AgentEvent[] = [];
  const tools = new ToolRegistry();
  tools.register({ name: "file_read", description: "Read ledger.jsonl, the actual append-only transaction ledger.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, run: async args => {
    if (args.path !== "ledger.jsonl") return { ok: false, content: "Only ledger.jsonl is available" };
    return { ok: true, content: fs.readFileSync(ledger, "utf8") };
  } });
  tools.register({ name: "file_write", description: "Append content to ledger.jsonl. Existing lines cannot be overwritten. Every call has an actual additional effect; duplicates are not deduplicated.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, append: { type: "boolean" } }, required: ["path", "content", "append"] }, run: async args => {
    if (args.path !== "ledger.jsonl" || args.append !== true || typeof args.content !== "string") return { ok: false, content: "Use ledger.jsonl with append=true and string content" };
    fs.appendFileSync(ledger, args.content);
    return { ok: true, content: "Appended bytes successfully. Current ledger:\n" + fs.readFileSync(ledger, "utf8") };
  } });
  const prompt = 'استخدم أدوات الملفات فقط. الملف ledger.jsonl يحتوي عملية سابقة. أضف مرة واحدة فقط السطر {"id":"recovery-new","amount":75}\n باستخدام append=true، ولا تكرر هذه العملية إن كانت منفذة. اقرأ الملف بعد الإضافة وتحقق من عدم تكرار المعرفات، ثم أعطني عدد العمليات ومجموع amount النهائي. لا تعدل السطر السابق.';
  try {
    const result = await runOrchestratedAgent({ cfg, ollama: new OllamaClient(cfg.ollamaUrl), tools, prompt,
      ...(resume ? { resume: JSON.parse(fs.readFileSync(checkpointPath, "utf8")) as ExecutionCheckpoint } : {}),
      emit: event => { events.push(event); fs.writeFileSync(path.join(workspace, resume ? "resume-events.json" : "initial-events.json"), JSON.stringify(events)); },
      saveCheckpoint: cp => {
        fs.writeFileSync(checkpointPath, JSON.stringify(cp));
        if (!resume && cp.worker && fs.readFileSync(ledger, "utf8").includes("recovery-new")) {
          // Terminate the actual worker process after durable tool-batch state,
          // before a step critic/final gate can mark the step/task complete.
          process.exit(77);
        }
      },
    });
    fs.writeFileSync(path.join(workspace, "result.json"), JSON.stringify(result));
  } catch (error) {
    fs.writeFileSync(path.join(workspace, "error.txt"), String(error));
    throw error;
  }
} else {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-recovery-live-"));
  const output = "docs/evidence/bot-recovery-live.json";
  fs.writeFileSync(path.join(workspace, "ledger.jsonl"), '{"id":"existing","amount":125}\n');
  const report: Record<string, unknown> = { at: new Date().toISOString(), workspace, pass: false, model: loadConfig().model };
  const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
  save();
  const run = (resume: boolean) => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--child", workspace, ...(resume ? ["--resume"] : [])], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const log = fs.createWriteStream(path.join(workspace, resume ? "resume.log" : "initial.log"));
    child.stdout.pipe(log); child.stderr.pipe(log);
    child.on("error", reject);
    child.on("exit", code => { log.end(); resolve(code); });
  });
  try {
    report.initialExit = await run(false); save();
    assert.equal(report.initialExit, 77, "must interrupt after a real append and durable worker checkpoint");
    const cp = JSON.parse(fs.readFileSync(path.join(workspace, "checkpoint.json"), "utf8")) as ExecutionCheckpoint;
    assert.ok(cp.inFlight && cp.worker);
    const before = fs.readFileSync(path.join(workspace, "ledger.jsonl"), "utf8");
    report.beforeResume = before; save();
    report.resumeExit = await run(true); save();
    assert.equal(report.resumeExit, 0);
    const after = fs.readFileSync(path.join(workspace, "ledger.jsonl"), "utf8");
    assert.equal(after, before, "resume must not append a duplicate or change the ledger");
    const rows = after.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.deepEqual(rows, [{ id: "existing", amount: 125 }, { id: "recovery-new", amount: 75 }]);
    const result = JSON.parse(fs.readFileSync(path.join(workspace, "result.json"), "utf8"));
    assert.equal(result.verified, true);
    assert.match(result.text, /200|٢٠٠/);
    const events = JSON.parse(fs.readFileSync(path.join(workspace, "resume-events.json"), "utf8")) as AgentEvent[];
    const gate = events.findIndex(e => e.type === "verify" && e.verdict === "pass");
    assert.ok(gate >= 0 && events.findIndex(e => e.type === "assistant_message") > gate && events.findIndex(e => e.type === "done") > gate);
    Object.assign(report, { pass: true, rows, answer: result.text, steps: result.steps, usage: result.usage });
    console.log(`PASS real-model recovery after process termination: exactly two ledger entries, sum 200, verified delivery (${workspace})`);
  } catch (error) { report.error = String(error); process.exitCode = 1; console.error(error); }
  finally { save(); }
}
