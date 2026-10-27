import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, before, test } from "node:test";
import type { ExecutionCheckpoint } from "../../agent/checkpoint.js";
import type { RunTaskOptions } from "../http.js";

let dataDir = "";
let close: () => void;
let db: typeof import("../db.js");
let createRunResume: typeof import("../runResume.js").createRunResume;
let writeCheckpoint: typeof import("../../agent/checkpointLog.js").writeCheckpoint;
let indexCheckpoint: typeof import("../../orchestration/durable/checkpoints.js").indexCheckpoint;
const calls: RunTaskOptions[] = [];

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-run-resume-"));
  process.env.MANUS_LOCAL_DATA_DIR = dataDir;
  process.env.LOAM_DATA_DIR = dataDir;
  close = (await import("../sqliteStore.js")).closeDb;
  db = await import("../db.js");
  createRunResume = (await import("../runResume.js")).createRunResume;
  writeCheckpoint = (await import("../../agent/checkpointLog.js")).writeCheckpoint;
  indexCheckpoint = (await import("../../orchestration/durable/checkpoints.js")).indexCheckpoint;
  db.loadDb();
});

afterEach(() => {
  calls.length = 0;
  try { close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function checkpoint(): ExecutionCheckpoint {
  return {
    version: 1,
    plan: { goal: "resume", steps: [], trivial: false, source: "model" },
    nextStep: 1,
    completed: ["first"],
    lastText: "first done",
    trace: [],
    round: 1,
    usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    totalSteps: 2,
    model: "test-model",
    inFlight: false,
    complete: false,
    finalRepairUsed: false,
  };
}

function saveSource(id: string, workspace: string): void {
  db.createTask("resume source", "Source", null, null, id);
  db.saveRun(id, {
    prompt: "continue",
    effectivePrompt: "continue",
    history: [],
    workspace,
    mode: "build",
    orchestrated: true,
    started: true,
    checkpoint: checkpoint(),
  });
}

const runTask = async (opts: RunTaskOptions) => {
  calls.push(opts);
  return { taskId: opts.taskId ?? "", text: "ok" };
};

test("fork starts a real resumed task with its own workspace", async () => {
  const { testConfig } = await import("../../orchestration/__tests__/helpers.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-fork-root-"));
  saveSource("task_source", path.join(root, "source"));
  const resume = createRunResume({ cfg: { ...testConfig(), workspace: root }, runTask });
  await resume.startForkedRun("task_fork", "task_source", checkpoint());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.taskId, "task_fork");
  assert.equal(calls[0]?.resume, true);
  assert.equal(calls[0]?.retryInterruptedStep, true);
  const fork = db.getSavedRun("task_fork");
  assert.ok(fork);
  assert.notEqual(fork.workspace, path.join(root, "source"));
  assert.deepEqual(fork.checkpoint, checkpoint());
});

test("interrupt resolution resumes its saved run and checkpoint", async () => {
  const { testConfig } = await import("../../orchestration/__tests__/helpers.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-interrupt-root-"));
  saveSource("task_interrupt", path.join(root, "source"));
  const cp = checkpoint();
  const logSeq = writeCheckpoint("task_interrupt", cp, "task_interrupt");
  const ref = indexCheckpoint({ taskId: "task_interrupt", sessionId: "task_interrupt", logSeq, cp, keep: 10 });
  const resume = createRunResume({ cfg: { ...testConfig(), workspace: root }, runTask });
  const resumed = await resume.resumeFromInterrupt({
    interruptId: "int_1", taskId: "task_interrupt", kind: "custom", status: "resolved",
    payload: {}, responseSchema: { type: "object" }, response: { answer: "yes" }, resolvedBy: "user",
    checkpointId: ref.checkpointId, createdAt: 1, expiresAt: 2, resolvedAt: 2,
  });
  assert.equal(resumed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.taskId, "task_interrupt");
  assert.equal(calls[0]?.resume, true);
  assert.deepEqual(db.getSavedRun("task_interrupt")?.checkpoint, cp);
});

test("interrupt resolution is honest when no saved execution exists", async () => {
  const { testConfig } = await import("../../orchestration/__tests__/helpers.js");
  const resume = createRunResume({ cfg: { ...testConfig(), workspace: dataDir }, runTask });
  const resumed = await resume.resumeFromInterrupt({
    interruptId: "int_missing", taskId: "task_missing", kind: "custom", status: "resolved",
    payload: {}, responseSchema: { type: "object" }, response: null, resolvedBy: "user",
    checkpointId: null, createdAt: 1, expiresAt: 2, resolvedAt: 2,
  });
  assert.equal(resumed, false);
  assert.equal(calls.length, 0);
});
