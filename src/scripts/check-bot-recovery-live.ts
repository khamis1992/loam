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
import { writeCheckpoint } from "../agent/checkpointLog.js";
import { autoResumeInterruptedTasks } from "../server/autoResume.js";
import { closeDb, resetDb } from "../server/sqliteStore.js";
import { createTask, getTask, saveRun, setTaskStatus, setTaskWorkspace } from "../server/db.js";

// O6b: opt-in startup auto-resume. Same claim as the unit tests, but exercised
// through the real orchestrator and the real dispatch module: a child process
// writes an idle checkpoint into the durable event log, leaves the task
// `interrupted`, and the boot-time scan must continue it at that checkpoint
// without a model call and without touching the ledger.
const autoResumeCase = async (): Promise<{ workspace: string; dataDir: string; taskId: string }> => {
  const autoResumeBase = fs.mkdtempSync(path.join(os.tmpdir(), "loam-autoresume-live-"));
  const autoResumeWorkspace = path.join(autoResumeBase, ".loam-tasks", "task_auto_resume");
  fs.mkdirSync(autoResumeWorkspace, { recursive: true });
  const autoResumeLedger = path.join(autoResumeWorkspace, "ledger.jsonl");
  fs.writeFileSync(autoResumeLedger, '{"id":"existing","amount":125}\n');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-autoresume-data-"));
  // `config.ts` reads the data dir from `MANUS_LOCAL_DATA_DIR` and captures it
  // as a module-level `DATA_DIR` at import time, which is what `sqliteStore`
  // opens. Both the value and the open connection have to be replaced for this
  // case to use its own store instead of the real `data/` folder.
  const previousDataDir = process.env.MANUS_LOCAL_DATA_DIR;
  process.env.MANUS_LOCAL_DATA_DIR = dataDir;
  const previousAutoResume = process.env.LOAM_AUTO_RESUME;
  process.env.LOAM_AUTO_RESUME = "1";
  closeDb(); resetDb();
  const autoResumeCfg = loadConfig();
  const autoResumeTask = createTask("resume the ledger task");
  setTaskWorkspace(autoResumeTask.id, autoResumeWorkspace);
  const idleCheckpoint = {
    version: 1 as const,
    plan: { goal: "sum the ledger", trivial: true, steps: [], source: "model" as const },
    nextStep: 1,
    completed: [],
    lastText: "",
    trace: [],
    round: 1,
    usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
    totalSteps: 0,
    model: autoResumeCfg.model,
    inFlight: false,
    complete: false,
    finalRepairUsed: false,
    finalRepairAttempts: 0,
    logSessionId: autoResumeTask.id,
  };
  saveRun(autoResumeTask.id, {
    prompt: idleCheckpoint.plan.goal, effectivePrompt: idleCheckpoint.plan.goal, history: [],
    workspace: autoResumeWorkspace, orchestrated: true, started: true, checkpoint: idleCheckpoint,
  });
  setTaskStatus(autoResumeTask.id, "interrupted", { error: "Execution interrupted by application shutdown. Resume requires review." });
  writeCheckpoint(autoResumeTask.id, idleCheckpoint, autoResumeTask.id);
  // The flag must survive `loadConfig`, which is what the boot path checks.
  assert.equal(autoResumeCfg.recovery?.autoResume ?? false, true, "LOAM_AUTO_RESUME=1 must enable auto-resume");

  const resumes: string[] = [];
  const autoResumed = autoResumeInterruptedTasks(autoResumeBase, async () => {
    resumes.push("dispatched");
    return { taskId: autoResumeTask.id, text: "resumed" };
  });
  assert.equal(autoResumed, 1, "exactly the idle task is a candidate");
  assert.deepEqual(resumes, ["dispatched"], "the eligible task is continued without review");

  // A checkpoint that is still in flight must keep "Resume requires review".
  const busyCheckpoint = { ...idleCheckpoint, inFlight: true };
  saveRun(autoResumeTask.id, {
    prompt: idleCheckpoint.plan.goal, effectivePrompt: idleCheckpoint.plan.goal, history: [],
    workspace: autoResumeWorkspace, orchestrated: true, started: true, checkpoint: busyCheckpoint,
  });
  setTaskStatus(autoResumeTask.id, "interrupted", { error: "Execution interrupted by application shutdown. Resume requires review." });
  writeCheckpoint(autoResumeTask.id, busyCheckpoint, autoResumeTask.id);
  assert.equal(autoResumeInterruptedTasks(autoResumeBase, async () => ({ taskId: autoResumeTask.id, text: "" })), 0);
  assert.equal(getTask(autoResumeTask.id)?.status, "interrupted", "an in-flight run stays interrupted");
  assert.equal(fs.readFileSync(autoResumeLedger, "utf8"), '{"id":"existing","amount":125}\n', "no effect was replayed");
  console.log(`PASS opt-in auto-resume: idle checkpoint continues, in-flight checkpoint stays interrupted (${autoResumeBase})`);
  return { workspace: autoResumeBase, dataDir, taskId: autoResumeTask.id };
};

type AutoResumeReport = {
  at: string;
  workspace: string;
  taskId: string;
  pass: boolean;
  idleCheckpointContinued: boolean;
  inFlightStaysInterrupted: boolean;
  ledgerUnchanged: boolean;
  error?: string;
};

/** Parent stage 2: O6b opt-in auto-resume. Runs independently of the real-model
 *  trial above, because the decision it verifies needs no model call at all and
 *  must not be reported as failed when the local model endpoint is unavailable.
 *  Its evidence lives in its own file so a live-model report keeps its value. */
const autoResumeStage = async (): Promise<void> => {
  const output = "docs/evidence/bot-auto-resume-live.json";
  const report: AutoResumeReport = {
    at: new Date().toISOString(),
    workspace: "",
    taskId: "",
    pass: false,
    idleCheckpointContinued: false,
    inFlightStaysInterrupted: false,
    ledgerUnchanged: false,
  };
  const save = (): void => fs.writeFileSync(output, JSON.stringify(report, null, 2));
  save();
  try {
    const result = await autoResumeCase();
    report.workspace = result.workspace;
    report.taskId = result.taskId;
    report.idleCheckpointContinued = true;
    report.inFlightStaysInterrupted = true;
    report.ledgerUnchanged = true;
    report.pass = true;
  } catch (error) {
    report.error = String(error);
    process.exitCode = 1;
    console.error(error);
  } finally {
    save();
  }
};

// O6b is verified as its own stage so it never depends on the local model
// endpoint that the real-model trial above needs. `--auto-resume` runs only that
// stage; without it the stage runs after a passing trial, exactly like before.
const childMode = process.argv.indexOf("--child");
const autoResumeOnly = process.argv.includes("--auto-resume") && childMode < 0;
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
} else if (autoResumeOnly) {
  await autoResumeStage();
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
    // O6b stage 1 (always): the decision verified above needs no model call, so
    // it runs with the real-model trial. Its own evidence file is written by
    // `autoResumeStage`, which also runs standalone via `--auto-resume`.
    await autoResumeStage();
  } catch (error) { report.error = String(error); process.exitCode = 1; console.error(error); }
  finally { save(); }
}
