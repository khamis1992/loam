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
  missionBudgetFrom,
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
import { isMissionBudgetError, runAgent } from "../loop.js";
import { loadConfig } from "../../config.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { AgentEvent } from "../events.js";
import type { ChatResult, OllamaClient, OllamaToolCall } from "../../ollama.js";

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

/**
 * End-to-end mission behaviour through `runAgent`.
 *
 * These drive the real loop with a scripted fake client (no model, no network),
 * because the acceptance criteria are about what the loop does over a long run:
 * it must keep going past the fixed step cap, it must write a checkpoint at
 * every boundary, and it must stop at the ceiling with a checkpoint rather than
 * an exception the caller cannot act on.
 */

/** A mission config with generous ceilings, so each test sets its own. */
function missionCfg(): ReturnType<typeof loadConfig> {
  const cfg = loadConfig();
  cfg.compression = { ...cfg.compression, enabled: false };
  cfg.fallbackModel = cfg.model;
  return cfg;
}

function missionTools(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "file_read",
    description: "mission test observation",
    parameters: {},
    run: async () => ({ ok: true, content: "Observed result" }),
  });
  return registry;
}

/**
 * A worker that calls the tool `toolSteps` times and then answers without one.
 * Each call carries a distinct argument so the stall guard sees progress; the
 * loop therefore advances one step per round-trip until the script runs out.
 */
function stepScript(toolSteps: number, usage = { promptTokens: 100, completionTokens: 50 }): OllamaClient {
  let calls = 0;
  return {
    chat: async (): Promise<ChatResult> => {
      calls += 1;
      const toolCall: OllamaToolCall[] = calls <= toolSteps
        ? [{ function: { name: "file_read", arguments: { path: `note-${calls}.md` } } }]
        : [];
      return {
        content: toolCall.length > 0 ? "" : "final answer",
        model: "fixture-model",
        toolCalls: toolCall,
        usage: { ...usage, durationMs: 1 },
      };
    },
    listModels: async () => [],
  } as unknown as OllamaClient;
}

interface MissionRunResult {
  events: AgentEvent[];
  checkpoints: MissionCheckpoint[];
  budget: ReturnType<typeof createMissionBudget>;
  error?: Error;
}

/**
 * Run one mission through the loop, collecting the checkpoints it wrote. The
 * caller owns the budget so it can inspect the counters the run left behind.
 */
async function runMission(options: {
  budget: ReturnType<typeof createMissionBudget>;
  client: OllamaClient;
  resumeMission?: MissionCheckpoint;
  maxSteps?: number;
  /** Also write each checkpoint to the app database, as `src/index.ts` does. */
  persist?: boolean;
}): Promise<MissionRunResult> {
  const events: AgentEvent[] = [];
  const checkpoints: MissionCheckpoint[] = [];
  try {
    await runAgent({
      cfg: missionCfg(),
      ollama: options.client,
      tools: missionTools(),
      prompt: "Ship the long-horizon migration",
      emit: (e: AgentEvent) => events.push(e),
      taskId: "task-mission-run",
      budget: options.budget,
      mission: true,
      ...(options.resumeMission ? { resumeMission: options.resumeMission } : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      saveMissionCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
        if (options.persist) missionCheckpoints.save(checkpoint);
      },
      suppressFinal: true,
    });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    // `src/index.ts` persists the stop's checkpoint from its catch block, since
    // the loop throws before its own post-step save can run. Mirror that here or
    // the durable record would be missing the reason the mission stopped.
    if (options.persist && isMissionBudgetError(error)) {
      missionCheckpoints.save(error.checkpoint);
    }
    return { events, checkpoints, budget: options.budget, error };
  }
  return { events, checkpoints, budget: options.budget };
}

describe("mission run end to end", () => {
  // The restart case persists a checkpoint, so this suite needs its own data
  // directory rather than the repo's real one.
  beforeEach(() => freshDataDir("loam-mission-e2e-"));
  afterEach(() => restoreDataDir());

  it("runs past the fixed step cap that bounds an ordinary run", async () => {
    // 45 tool steps is beyond the 40-step cap an ordinary run gets. A mission has
    // no cap, so the only thing that can end it is the script or the budget.
    const result = await runMission({
      budget: createMissionBudget({ steps: 500, tokens: 5_000_000 }),
      client: stepScript(45),
      maxSteps: 40,
    });
    assert.equal(result.error, undefined, "the mission completes instead of hitting the cap");
    assert.equal(result.budget.steps, 46, "45 tool steps plus the answering step");
    // The loop emits one `step` event per iteration, so the highest index is how
    // far the mission actually ran: 46, well past the 40-step cap it was given.
    const highestStep = Math.max(...result.events.filter((e) => e.type === "step").map((e) => e.index));
    assert.equal(highestStep, 46, "the mission ran past the cap instead of stopping at it");
  });

  it("completes a 500-step mock mission", async () => {
    // The acceptance criterion: a mission whose work is genuinely long. The step
    // ceiling is the only bound and it is never reached, so every one of the 500
    // steps runs and every completed step leaves a checkpoint behind.
    const result = await runMission({
      budget: createMissionBudget({ steps: 1000, tokens: 500_000_000 }),
      client: stepScript(499),
      maxSteps: 40,
    });
    assert.equal(result.error, undefined, "500 steps complete without a stop");
    assert.equal(result.budget.steps, 500, "499 tool steps plus the answering step");
    // Every completed step is a resume boundary. Step 500 is the answering step,
    // which returns before the post-step save, so steps 1..499 each wrote a
    // between-steps checkpoint (`inFlight` absent) and an in-flight marker.
    const boundaries = result.checkpoints.filter((c) => c.inFlight !== true);
    const inFlight = result.checkpoints.filter((c) => c.inFlight === true);
    assert.equal(boundaries.length, 499, "one safe checkpoint per completed tool step");
    assert.equal(inFlight.length, 499, "one in-flight marker per step that then ran");
    const highestCompleted = Math.max(...boundaries.map((c) => c.lastStep));
    assert.equal(highestCompleted, 499, "the whole run is recoverable up to its last tool step");
  });

  it("stops cleanly at the step ceiling with a checkpoint, not a bare failure", async () => {
    const result = await runMission({
      budget: createMissionBudget({ steps: 5, tokens: 5_000_000 }),
      client: stepScript(100),
    });
    assert.ok(result.error, "the mission stops");
    assert.equal(isMissionBudgetError(result.error), true, "the stop is a mission budget stop");
    const stop = (result.error as unknown as { checkpoint: MissionCheckpoint }).checkpoint;
    assert.equal(stop.endedReason, "budget");
    assert.equal(stop.lastStep, 5, "the last completed step is the resume point");
    assert.equal(stop.inFlight, undefined, "a stop between steps is a safe boundary");
    // The summary event the canvas renders is emitted with the same checkpoint.
    const exhausted = result.events.find((e) => e.type === "budget_exhausted");
    assert.ok(exhausted, "a budget_exhausted event is emitted");
    assert.equal(exhausted!.type === "budget_exhausted" && exhausted!.checkpoint.lastStep, 5);
    assert.equal(result.budget.steps, 5, "no step ran past the ceiling");
  });

  it("resumes from the checkpoint the database kept after a server restart", async () => {
    // A server restart: the process is gone, the budget object is gone, and the
    // only thing that survives is the checkpoint row. The mission must continue
    // from the last completed step with the clock and spend already charged.
    const first = await runMission({
      budget: createMissionBudget({ steps: 10, tokens: 5_000_000, minutes: 60 }),
      client: stepScript(100),
      persist: true,
    });
    const checkpoint = first.checkpoints.at(-1)!;
    assert.equal(checkpoint.lastStep, 10);

    // Drop the connection and the process-wide graph, then read the checkpoint
    // back the way a restarted process does: only from the durable store.
    closeDb();
    const stored = missionCheckpoints.load("task-mission-run");
    assert.ok(stored, "the checkpoint outlives the run's own process state");
    assert.equal(stored!.lastStep, 10, "the resume boundary is the last completed step");
    assert.equal(stored!.endedReason, "budget");

    // Rebuild the budget the way a fresh process does: ceilings from config,
    // counters from the stored checkpoint.
    const resumed = missionBudgetFrom({ steps: 20, tokens: 5_000_000, minutes: 60 }, stored!.budget);
    assert.equal(resumed.steps, 10, "the counters come from the checkpoint");
    assert.equal(resumed.wallClockMs, checkpoint.budget.wallClockMs, "the clock does not restart");
    assert.equal(resumed.promptTokens, 1000, "the spend does not restart");
    assert.equal(resumed.stepLimit, 20, "the ceiling is rebuilt from config");

    // Resuming continues at the first step not yet done, and the counters carry.
    const second = await runMission({
      budget: resumed,
      client: stepScript(4),
      resumeMission: stored,
    });
    assert.equal(second.error, undefined, "the resumed mission completes");
    assert.equal(second.budget.steps, 15, "10 carried + 5 more (4 tool steps + answer)");
    // The first thing a resumed mission writes is the in-flight marker for the
    // carried boundary (step 10); the first *completed* step is 11, not step 1.
    assert.equal(second.checkpoints[0]!.lastStep, 10, "the resume resumes at the carried boundary");
    assert.equal(second.checkpoints[0]!.inFlight, true);
    const firstCompleted = second.checkpoints.find((c) => c.inFlight !== true);
    assert.equal(firstCompleted!.lastStep, 11, "the resume starts at step 11, not step 1");
    assert.ok((second.checkpoints[0]!.budget.wallClockMs ?? 0) >= (checkpoint.budget.wallClockMs ?? 0),
      "the resumed mission keeps charging the same clock");
  });

  it("does not resume a checkpoint taken while a step was executing", async () => {
    // The pre-step checkpoint marks the step in flight, so a restart in the
    // middle of that step is not a safe automatic resume point.
    const result = await runMission({
      budget: createMissionBudget({ steps: 3, tokens: 5_000_000 }),
      client: stepScript(100),
    });
    const inFlight = result.checkpoints.find((c) => c.inFlight === true);
    assert.ok(inFlight, "a step boundary marks the step in flight");
    assert.equal(missionResumableFrom(inFlight), false, "an in-flight boundary needs confirmation");
    // The stop's own checkpoint is the safe one.
    assert.equal(missionResumableFrom(result.checkpoints.at(-1)!), true);
  });
});
