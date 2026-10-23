/**
 * O6b unit tests: opt-in startup auto-resume (BUILD_SPEC §9, GAP_TABLE row 12).
 *
 * The contract under test is narrow and safety-critical:
 *
 *   - an interrupted task whose LATEST durable checkpoint is idle (`inFlight ===
 *     false` and no tool call that started without a terminal event) is resumed
 *     without review;
 *   - anything else (in flight, no log evidence, an unfinished tool call, a
 *     missing workspace, a legacy shared workspace) stays `interrupted`, i.e.
 *     today's "Resume requires review" behaviour is preserved.
 *
 * The log is read explicitly, so a `SavedRun` row that disagrees with the newest
 * checkpoint event must lose. `LOAM_DATA_DIR` points at a throwaway temp dir
 * before the modules load, so the app's real `data/` folder is never touched.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// `DATA_DIR` is a module-level constant in config.ts, so every test in this file
// shares one SQLite store. Each describe therefore wipes it in `before`, and the
// workspaces created by the fixtures live under this throwaway tree.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-autoresume-"));
process.env.LOAM_DATA_DIR = tmpDir;
process.env.MANUS_LOCAL_DATA_DIR = tmpDir;

import type { ExecutionCheckpoint } from "../../agent/checkpoint.js";
import { recordToolCall, recordToolResult, writeCheckpoint } from "../../agent/checkpointLog.js";
import type { SavedRun } from "../recovery.js";
import { createTask, getSavedRun, getTask, listTasks, saveRun, setTaskStatus, setTaskWorkspace, type Task } from "../db.js";
import { closeDb, resetDb } from "../sqliteStore.js";
import { removeEntity } from "../sqliteStore.js";
import { executionQueue } from "../executionQueue.js";
import { autoResumeInterruptedTasks, canAutoResume, findAutoResumableTasks } from "../autoResume.js";

// The throwaway tree is removed once, after the last test: the fixtures create
// their workspaces under it and need it to exist while the suites run.
after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function checkpoint(overrides: Partial<ExecutionCheckpoint> = {}): ExecutionCheckpoint {
  return {
    version: 1,
    plan: { goal: "do the thing", trivial: true, steps: [], source: "fallback" },
    nextStep: 1,
    completed: [],
    lastText: "",
    trace: [],
    round: 1,
    usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
    totalSteps: 1,
    model: "test-model",
    inFlight: false,
    complete: false,
    finalRepairUsed: false,
    ...overrides,
  };
}

let seq = 0;
/** A fresh session id per call: the log is append-only and shared per process. */
function session(prefix: string): string {
  seq += 1;
  return `s_auto_${prefix}_${seq}`;
}

/**
 * Drop every task/run from the store.
 *
 * `DATA_DIR` is fixed for the whole file, so a suite must not see another suite's
 * fixtures. Deleting the rows (rather than a second temp dir) keeps the workspaces
 * the fixtures created under the same throwaway tree.
 */
function clearStore(): void {
  for (const task of listTasks()) {
    removeEntity("tasks", task.id);
    removeEntity("runs", task.id);
  }
}

interface Fixture {
  taskId: string;
  workspace: string;
  sessionId: string;
  saved: SavedRun;
  /**
   * The task as the store holds it. `setWorkspace` mutates the persisted row, so
   * the object returned by `createTask` would keep a stale (empty) `workspace`.
   */
  task(): Task;
  /** Record the task's isolated workspace, exactly as `runTask` does. */
  setWorkspace(): void;
}

/**
 * An interrupted task whose workspace exists and whose run is persisted.
 *
 * The checkpoint carries `logSessionId` by default because `canAutoResume`
 * requires durable log evidence; `logSessionId: null` opts a fixture out.
 */
function fixture(prefix: string, cp: ExecutionCheckpoint, logSessionId?: string | null): Fixture {
  const created = createTask("resume me");
  const workspace = fs.mkdtempSync(path.join(tmpDir, `ws-${prefix}-`));
  const sessionId = session(prefix);
  const saved: SavedRun = {
    prompt: "resume me",
    effectivePrompt: "resume me",
    history: [],
    workspace,
    orchestrated: true,
    started: true,
    checkpoint: { ...cp, ...(logSessionId === null ? {} : { logSessionId: logSessionId ?? sessionId }) },
  };
  saveRun(created.id, { ...saved });
  setTaskStatus(created.id, "interrupted", { error: "Execution interrupted by application shutdown. Resume requires review." });
  return {
    taskId: created.id,
    workspace,
    sessionId,
    saved,
    task: () => getTask(created.id)!,
    setWorkspace: () => setTaskWorkspace(created.id, workspace),
  };
}

describe("O6b auto-resume decision", () => {
  before(() => {
    closeDb();
    resetDb();
  });

  // Every test builds its own fixtures, so the store must start empty here too:
  // `before` runs once per suite, and a suite that leaves a task behind would
  // leak into the next test's assertions.
  beforeEach(() => clearStore());
  after(() => closeDb());

  it("accepts an idle checkpoint that the log confirms is the newest state", () => {
    const f = fixture("idle", checkpoint({ nextStep: 3 }));
    f.setWorkspace();
    writeCheckpoint(f.sessionId, checkpoint({ nextStep: 3, inFlight: false }));
    assert.deepEqual(canAutoResume(f.saved, f.task(), tmpDir), { ok: true });
  });

  it("refuses a checkpoint that is still in flight", () => {
    const f = fixture("busy", checkpoint({ inFlight: true }));
    f.setWorkspace();
    writeCheckpoint(f.sessionId, checkpoint({ inFlight: true }));
    assert.deepEqual(canAutoResume(f.saved, f.task(), tmpDir), { ok: false, reason: "in-flight" });
  });

  it("refuses when the newest log checkpoint is in flight even though the saved row says idle", () => {
    // The orchestrator writes `checkpoint(true)` BEFORE a worker runs, so a crash
    // inside a step leaves an older idle row in `SavedRun` while the log's newest
    // checkpoint is the busy one. The log must win.
    const f = fixture("stalecp", checkpoint({ nextStep: 2, inFlight: false }));
    f.setWorkspace();
    writeCheckpoint(f.sessionId, checkpoint({ nextStep: 2, inFlight: false }));
    writeCheckpoint(f.sessionId, checkpoint({ nextStep: 2, inFlight: true }));
    assert.equal(f.saved.checkpoint?.inFlight, false, "the saved row is the stale idle one");
    assert.deepEqual(canAutoResume(f.saved, f.task(), tmpDir), { ok: false, reason: "in-flight" });
  });

  it("refuses a checkpoint with no durable log evidence", () => {
    const f = fixture("nolog", checkpoint({ inFlight: false }), /* logSessionId */ "s_never_logged");
    f.setWorkspace();
    assert.deepEqual(canAutoResume(f.saved, f.task(), tmpDir), { ok: false, reason: "no-log-evidence" });
  });

  it("refuses a run with no checkpoint at all", () => {
    const f = fixture("nocp", checkpoint());
    f.setWorkspace();
    const noCheckpoint = { ...f.saved, checkpoint: undefined };
    assert.deepEqual(canAutoResume(noCheckpoint, f.task(), tmpDir), { ok: false, reason: "no-checkpoint" });
  });

  it("refuses a tool call that started without a terminal event", () => {
    const f = fixture("toolopen", checkpoint({ inFlight: false }));
    f.setWorkspace();
    writeCheckpoint(f.sessionId, checkpoint({ inFlight: false }));
    recordToolCall(f.sessionId, "tc_open", "run_command");
    assert.deepEqual(canAutoResume(f.saved, f.task(), tmpDir), { ok: false, reason: "unfinished-tool-call" });
    // The same call reaching a terminal state makes the run resumable again.
    recordToolResult(f.sessionId, "tc_open", "run_command", "succeeded", "done");
    assert.deepEqual(canAutoResume(f.saved, f.task(), tmpDir), { ok: true });
  });

  it("refuses a workspace that no longer exists", () => {
    const f = fixture("nows", checkpoint({ inFlight: false }));
    f.setWorkspace();
    writeCheckpoint(f.sessionId, checkpoint({ inFlight: false }));
    const missing = { ...f.saved, workspace: path.join(tmpDir, "deleted-workspace") };
    assert.deepEqual(canAutoResume(missing, f.task(), tmpDir), { ok: false, reason: "workspace-unavailable" });
  });

  it("refuses a legacy shared-workspace run that cannot resume into an isolated workspace", () => {
    const f = fixture("legacy", checkpoint({ inFlight: false }));
    // No `setWorkspace()`: the task has no recorded workspace, so the resume would
    // create `<base>/.loam-tasks/<id>`, which is not where this run lived.
    writeCheckpoint(f.sessionId, checkpoint({ inFlight: false }));
    assert.deepEqual(canAutoResume(f.saved, f.task(), tmpDir), { ok: false, reason: "workspace-unavailable" });
  });
});

describe("O6b auto-resume scan", () => {
  before(() => {
    closeDb();
    resetDb();
  });

  beforeEach(() => clearStore());
  after(() => closeDb());

  it("selects only interrupted tasks with an idle latest checkpoint", () => {
    const idle = fixture("scan-idle", checkpoint({ inFlight: false }));
    idle.setWorkspace();
    writeCheckpoint(idle.sessionId, checkpoint({ inFlight: false }));

    const busy = fixture("scan-busy", checkpoint({ inFlight: true }));
    busy.setWorkspace();
    writeCheckpoint(busy.sessionId, checkpoint({ inFlight: true }));

    // A finished task with the same saved run must never be resumed.
    const done = fixture("scan-done", checkpoint({ inFlight: false }));
    done.setWorkspace();
    writeCheckpoint(done.sessionId, checkpoint({ inFlight: false }));
    setTaskStatus(done.taskId, "done", { error: undefined });

    // A task without a persisted run has nothing to resume from.
    const orphan = createTask("no saved run");
    setTaskStatus(orphan.id, "interrupted", { error: "Execution interrupted by application shutdown. Resume requires review." });

    const found = findAutoResumableTasks(tmpDir);
    assert.deepEqual(found.map((c) => c.task.id), [idle.taskId]);
    assert.ok(listTasks().length >= 4, "the fixtures are all present in the store");
    assert.ok(getSavedRun(done.taskId), "the done task kept its run row for the assertion above");
  });

  it("dispatches exactly the eligible tasks and never a queued one", () => {
    const dispatched: string[] = [];
    const runTask = async (opts: { taskId: string }): Promise<void> => {
      dispatched.push(opts.taskId);
    };

    const idle = fixture("dispatch-idle", checkpoint({ inFlight: false }));
    idle.setWorkspace();
    writeCheckpoint(idle.sessionId, checkpoint({ inFlight: false }));

    // `executionQueue` is the shared module instance, so occupying it here models
    // a task that a route already resumed before the boot scan reached it.
    const queued = fixture("dispatch-queued", checkpoint({ inFlight: false }));
    queued.setWorkspace();
    writeCheckpoint(queued.sessionId, checkpoint({ inFlight: false }));
    const blocker = new Promise<void>(() => {});
    void executionQueue.enqueue(queued.taskId, () => blocker);

    try {
      // The scan counts both, but only the one not already running is dispatched.
      assert.equal(autoResumeInterruptedTasks(tmpDir, runTask), 2);
      assert.deepEqual(dispatched, [idle.taskId]);
    } finally {
      executionQueue.stop();
    }
  });
});
