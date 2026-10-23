/**
 * Neo N6 mission primitives.
 *
 * Everything here is pure or persistence-only, so it is fully deterministic:
 * no model, no network, no clock. The invariants that matter are that a mission
 * can be unbounded, that its limits round-trip into the units the user
 * configures them with, that a checkpoint records exactly where it stopped, and
 * that the resume gate refuses a boundary where an effect may be half-applied.
 */
// Must come before any import that evaluates `config.js`: the database-backed
// store reads `DATA_DIR`, and `loadConfig()` mkdirs under whatever root it
// resolves to. Without this the suite writes into the repo's real `data/`.
import "../../test/isolation.js";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  MISSION_CHECKPOINT_ENTITY,
  MemoryMissionCheckpointStore,
  DbMissionCheckpointStore,
  budgetStoppedCheckpoint,
  budgetSummary,
  canResumeMission,
  createMissionBudget,
  isUnbounded,
  minutesToMs,
  missionLimitsOf,
  missionResumableFrom,
  missionCheckpoints,
  resumableFrom,
  resumeStep,
  type MissionCheckpoint,
} from "../mission.js";
import { checkBudget, consumeCost, consumeTokens, consumeWallClock } from "../computeBudget.js";
import { beginRun, applyRunEvent, getRunNodes, resetRunGraph } from "../runGraphAdapter.js";
import { closeDb } from "../../server/sqliteStore.js";

let tmpDir = "";
let prevDataDir: string | undefined;

/**
 * Point the data directory at a throwaway folder. The store opens its file
 * lazily, so dropping the connection here is what makes the next write land in
 * the new directory instead of the previous test's database.
 */
function freshDataDir(prefix: string): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  prevDataDir = process.env.MANUS_LOCAL_DATA_DIR;
  process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
  closeDb();
  // The adapter keeps one process-wide graph; without this the next test's
  // `applyRunEvent` resumes a stale cursor and writes into the old file.
  resetRunGraph();
  return tmpDir;
}

function restoreDataDir(): void {
  closeDb();
  resetRunGraph();
  if (prevDataDir === undefined) delete process.env.MANUS_LOCAL_DATA_DIR;
  else process.env.MANUS_LOCAL_DATA_DIR = prevDataDir;
  try {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore: a leaked temp folder must not fail the suite */
  }
  tmpDir = "";
}

/** One run id per graph test; the per-test data directory keeps it isolated. */
const RUN = "task_mission_1";

function checkpoint(input: Partial<MissionCheckpoint> = {}): MissionCheckpoint {
  return {
    version: 1,
    taskId: "task-1",
    prompt: "Ship the feature",
    lastStep: 3,
    budget: createMissionBudget({ steps: 100, tokens: 1_000_000 }),
    checkpointedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

describe("mission budget construction", () => {
  it("treats a mission with no limits as truly unbounded", () => {
    const budget = createMissionBudget();
    assert.equal(isUnbounded(budget), true);
    assert.equal(checkBudget(budget).action, "allow");
    // A wall-clock ceiling in minutes is the config-facing unit; cost is USD.
    assert.equal(minutesToMs(undefined), undefined);
    assert.equal(minutesToMs(0), undefined);
    assert.equal(minutesToMs(-5), undefined);
    assert.equal(minutesToMs(Number.NaN), undefined);
    assert.equal(minutesToMs(1.5), 90_000);
  });

  it("round-trips its limits into the units the user configures them with", () => {
    const budget = createMissionBudget({ steps: 50, tokens: 10_000, minutes: 90, costUsd: 2.5 });
    assert.deepEqual(missionLimitsOf(budget), { steps: 50, tokens: 10_000, minutes: 90, costUsd: 2.5 });
    assert.equal(isUnbounded(budget), false);
    assert.equal(budget.wallClockLimitMs, 5_400_000);
  });

  it("keeps every dimension as an independent ceiling", () => {
    const budget = createMissionBudget({ steps: 100, tokens: 1000, minutes: 60, costUsd: 1 });
    consumeTokens(budget, 1000, 0);
    // Only the token dimension crossed, but the mission stops.
    assert.equal(checkBudget(budget).action, "stop");
  });

  it("stops on the wall-clock and cost ceilings too", () => {
    const clock = createMissionBudget({ minutes: 5 });
    consumeWallClock(clock, 5 * 60_000);
    assert.equal(checkBudget(clock).action, "stop");

    const spend = createMissionBudget({ costUsd: 0.01 });
    consumeCost(spend, 0.02);
    assert.equal(checkBudget(spend).action, "stop");
  });
});

describe("mission checkpoint store", () => {
  it("saves, loads and clears a checkpoint per task", () => {
    const store = new MemoryMissionCheckpointStore();
    const record = checkpoint();
    store.save(record);
    assert.deepEqual(store.load("task-1"), record);
    assert.equal(store.load("task-2"), undefined);
    store.clear("task-1");
    assert.equal(store.load("task-1"), undefined);
  });

  it("hands back a copy, so a caller cannot mutate the stored record", () => {
    const store = new MemoryMissionCheckpointStore();
    store.save(checkpoint());
    const loaded = store.load("task-1");
    assert.ok(loaded);
    loaded.lastStep = 99;
    assert.equal(store.load("task-1")?.lastStep, 3, "the store is unaffected");
  });

  it("names its entity family so it shares the run-graph table", () => {
    assert.equal(MISSION_CHECKPOINT_ENTITY, "mission_checkpoint");
  });
});

describe("mission resume gate", () => {
  it("resumes automatically from a checkpoint taken between steps", () => {
    assert.equal(resumableFrom(checkpoint()), true);
    assert.equal(resumeStep(checkpoint()), 4, "the first step not yet done");
  });

  it("refuses a checkpoint taken while a step was executing", () => {
    // A mid-step boundary may have a half-applied effect, so it is not a safe
    // automatic resume point: the caller must confirm the replay.
    assert.equal(resumableFrom(checkpoint({ inFlight: true })), false);
    assert.equal(missionResumableFrom(checkpoint({ inFlight: true })), false);
  });

  it("refuses a checkpoint whose mission already ended for a reason other than cancellation", () => {
    assert.equal(resumableFrom(checkpoint({ endedReason: "completed" })), false);
    assert.equal(resumableFrom(checkpoint({ endedReason: "failed" })), false);
  });

  it("resumes a cancelled mission, since the user explicitly stopped it", () => {
    assert.equal(resumableFrom(checkpoint({ endedReason: "cancelled" })), true);
  });

  it("resumes a budget-stopped mission but not one that completed or failed", () => {
    // A budget stop is a clean end: the user raises the ceiling and continues.
    // Completion and failure are terminal for a mission, exactly as for a run.
    assert.equal(missionResumableFrom(checkpoint({ endedReason: "budget" })), true);
    assert.equal(missionResumableFrom(checkpoint({ endedReason: "cancelled" })), true);
    assert.equal(missionResumableFrom(checkpoint()), true);
    assert.equal(missionResumableFrom(checkpoint({ endedReason: "completed" })), false);
    assert.equal(missionResumableFrom(checkpoint({ endedReason: "failed" })), false);
  });

  it("allows a closed run to resume when it stopped on its budget", () => {
    // A budget stop ends the mission cleanly, so the task is `done`, but the
    // mission is not finished: raising the budget continues from the boundary.
    const stopped = checkpoint({ endedReason: "budget" });
    assert.equal(canResumeMission({ mission: true, missionCheckpoint: stopped }), true);
    assert.equal(canResumeMission({ mission: true, missionCheckpoint: checkpoint({ endedReason: "completed" }) }), false);
    assert.equal(canResumeMission({ mission: true, missionCheckpoint: checkpoint({ endedReason: "failed" }) }), false);
    assert.equal(canResumeMission({ mission: false, missionCheckpoint: stopped }), false);
    assert.equal(canResumeMission({ mission: true, missionCheckpoint: undefined }), false);
    assert.equal(canResumeMission(undefined), false);
    assert.equal(canResumeMission({ mission: true, missionCheckpoint: checkpoint({ inFlight: true }) }), false);
  });
});

describe("mission budget-stop record", () => {
  it("records the last completed step, the counters and the reason", () => {
    const budget = createMissionBudget({ steps: 3, tokens: 1000, minutes: 5, costUsd: 0.5 });
    consumeWallClock(budget, 60_000);
    consumeCost(budget, 0.1234);
    const record = budgetStoppedCheckpoint({ taskId: "task-1", prompt: "Ship it", lastStep: 7, budget, summary: "waited on the verifier" });
    assert.equal(record.version, 1);
    assert.equal(record.taskId, "task-1");
    assert.equal(record.lastStep, 7);
    assert.equal(record.endedReason, "budget");
    assert.equal(record.inFlight, undefined, "a budget stop is a safe boundary");
    assert.equal(record.summary, "waited on the verifier");
    assert.equal(record.budget.wallClockMs, 60_000);
    assert.equal(record.budget.costUsd, 0.1234);
  });

  it("summarises what the mission consumed without calling it a failure", () => {
    const budget = createMissionBudget({ steps: 4, tokens: 1000, minutes: 30, costUsd: 1 });
    budget.steps = 4;
    consumeWallClock(budget, 10 * 60_000);
    consumeCost(budget, 0.4);
    const record = budgetStoppedCheckpoint({ taskId: "task-1", prompt: "Ship it", lastStep: 4, budget });
    const summary = budgetSummary(record, "the step ceiling was reached");
    assert.match(summary, /step 4/);
    assert.match(summary, /10m wall-clock/);
    assert.match(summary, /\$0\.4000/);
    assert.match(summary, /the step ceiling was reached/);
    assert.doesNotMatch(summary, /error|failed/i, "a budget stop is not a failure");
  });
});

/**
 * The budget stop reaches the canvas as a summary, not an error banner.
 *
 * A mission that hits its ceiling did what the user asked; the graph must say
 * where it got to and what it consumed, and it must mark the stop resumable so
 * the UI can offer "raise the budget and continue" instead of "retry".
 */
describe("mission budget stop on the run graph", () => {
  beforeEach(() => freshDataDir("loam-mission-graph-"));
  afterEach(() => restoreDataDir());

  it("renders the stop as a finished summary node carrying the counters", () => {
    beginRun(RUN, "Ship the migration");
    const budget = createMissionBudget({ steps: 20, tokens: 1_000_000, minutes: 45, costUsd: 3 });
    budget.steps = 20;
    consumeTokens(budget, 400_000, 100_000);
    consumeWallClock(budget, 12 * 60_000);
    consumeCost(budget, 1.25);
    const stopped = budgetStoppedCheckpoint({
      taskId: RUN,
      prompt: "Ship the migration",
      lastStep: 20,
      budget,
      summary: "stopped before the final verification",
    });

    const ids = applyRunEvent(RUN, {
      type: "budget_exhausted",
      taskId: RUN,
      reason: "Step budget exhausted (20/20 steps)",
      checkpoint: stopped,
    });
    assert.equal(ids.length, 1, "the stop produces exactly one node");

    const node = getRunNodes(RUN).find((n) => n.id === ids[0]);
    assert.ok(node, "the node is in the graph");
    assert.equal(node!.type, "note");
    assert.equal(node!.status, "finished", "a budget stop is not an in-progress or failed node");
    const data = node!.data as Record<string, unknown>;
    assert.equal(data.budgetStopped, true);
    assert.equal(data.reason, "Step budget exhausted (20/20 steps)");
    assert.equal(data.lastStep, 20, "the last completed step is reported");
    assert.equal(data.steps, 20, "the consumed step count is reported");
    assert.equal(data.tokens, 500_000, "prompt and completion tokens are summed");
    assert.equal(data.wallClockMs, 12 * 60_000);
    assert.equal(data.costUsd, 1.25);
    assert.equal(data.resumable, true, "a between-steps stop is safe to resume");
  });

  it("marks a stop recorded mid-step as not automatically resumable", () => {
    beginRun(RUN, "Ship the migration");
    const stopped = budgetStoppedCheckpoint({
      taskId: RUN,
      prompt: "Ship the migration",
      lastStep: 4,
      budget: createMissionBudget({ steps: 4 }),
    });
    // A checkpoint written while a step was executing: an effect may be half
    // applied, so the canvas must not offer a one-click resume.
    const ids = applyRunEvent(RUN, {
      type: "budget_exhausted",
      taskId: RUN,
      reason: "Step budget exhausted (4/4 steps)",
      checkpoint: { ...stopped, inFlight: true },
    });
    const node = getRunNodes(RUN).find((n) => n.id === ids[0]);
    assert.equal((node!.data as Record<string, unknown>).resumable, false);
  });

  it("keeps a mission that never set a dimension out of the summary", () => {
    beginRun(RUN, "Ship the migration");
    // Only the step ceiling is set: the wall-clock and cost keys must be absent
    // rather than reported as zero, which would read as "spent nothing".
    const stopped = budgetStoppedCheckpoint({
      taskId: RUN,
      prompt: "Ship the migration",
      lastStep: 2,
      budget: createMissionBudget({ steps: 2 }),
    });
    const ids = applyRunEvent(RUN, { type: "budget_exhausted", taskId: RUN, reason: "step ceiling", checkpoint: stopped });
    const data = getRunNodes(RUN).find((n) => n.id === ids[0])!.data as Record<string, unknown>;
    assert.equal("wallClockMs" in data, false);
    assert.equal("costUsd" in data, false);
  });
});

/**
 * A mission checkpoint must survive the process that wrote it: that is the whole
 * point of the durable boundary, and it is why the default store is the app
 * database rather than a map.
 */
describe("mission checkpoint durability", () => {
  beforeEach(() => freshDataDir("loam-mission-db-"));
  afterEach(() => restoreDataDir());

  /**
   * What the store can promise. The `entities` table holds JSON text, and
   * `JSON.stringify` drops keys whose value is `undefined`, so a budget that
   * never set a dimension comes back without that key. That is the boundary the
   * assertions compare against: not the in-memory object, the persisted one.
   */
  function persisted<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  it("round-trips a checkpoint through the app database", () => {
    const budget = createMissionBudget({ steps: 12, tokens: 9000, minutes: 15, costUsd: 0.75 });
    budget.steps = 12;
    consumeTokens(budget, 5000, 4000);
    const record = budgetStoppedCheckpoint({ taskId: "task-db-1", prompt: "Ship it", lastStep: 12, budget });
    missionCheckpoints.save(record);
    assert.deepEqual(missionCheckpoints.load("task-db-1"), persisted(record));
    assert.equal(missionCheckpoints.load("task-db-2"), undefined);
  });

  it("reopens the checkpoint in a fresh connection, as a restarted server would", () => {
    const record = budgetStoppedCheckpoint({
      taskId: "task-db-1",
      prompt: "Ship it",
      lastStep: 5,
      budget: createMissionBudget({ steps: 10, costUsd: 2 }),
    });
    missionCheckpoints.save(record);
    // Drop the handle without touching the file: the next read opens the same
    // database and must see the record the previous process wrote.
    closeDb();
    const reloaded = missionCheckpoints.load("task-db-1");
    assert.deepEqual(reloaded, persisted(record), "the checkpoint outlives the connection");
    assert.equal(reloaded!.lastStep, 5);
    assert.equal(reloaded!.endedReason, "budget");
    assert.equal(reloaded!.budget.costLimitUsd, 2, "the budget counters travel with the record");
    missionCheckpoints.clear("task-db-1");
    assert.equal(missionCheckpoints.load("task-db-1"), undefined);
  });

  it("hands back the checkpoint without the row key the table needs", () => {
    // `entities` keys a row by `id`; that column must not leak into the record,
    // or a caller comparing what it saved with what it loaded sees a stray field.
    const store = new DbMissionCheckpointStore();
    const record = budgetStoppedCheckpoint({ taskId: "task-db-3", prompt: "Ship it", lastStep: 1, budget: createMissionBudget({ steps: 1 }) });
    store.save(record);
    const loaded = store.load("task-db-3");
    assert.deepEqual(loaded, persisted(record));
    assert.equal("id" in (loaded as object), false, "the row key stays out of the payload");
  });
});
