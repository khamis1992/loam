/**
 * MF2 unit tests: scheduler retry policy. A failed routine run retries exactly
 * once after a short delay, then stops: fail-then-succeed records ok, two
 * failures record failed and never fire a third attempt. Uses the real store
 * with an isolated data dir (same pattern as scratchpad.test.ts).
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

type Db = typeof import("../db.js");
type Scheduler = typeof import("../scheduler.js");

let tmpDir = "";
let closeDb: () => void;
let db: Db;
let scheduler: Scheduler;

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

function find(id: string): import("../db.js").Schedule {
  const s = db.listSchedules().find((x) => x.id === id);
  assert.ok(s, `schedule ${id} must persist`);
  return s!;
}

describe("scheduler retry policy (MF2)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-sched-retry-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    db = await import("../db.js");
    scheduler = await import("../scheduler.js");
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("retries exactly once after a failure, then records ok", async () => {
    const s = db.addSchedule("retry then ok", 3600);
    db.setScheduleNextRunAt(s.id, new Date(Date.now() - 1000).toISOString());
    let calls = 0;
    const stop = scheduler.startScheduler({
      runScheduled: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return "task_retry_ok";
      },
      intervalMs: 20,
      retryDelayMs: 60,
    });
    try {
      await waitFor(() => find(s.id).lastStatus === "ok");
      const after = find(s.id);
      assert.equal(calls, 2, "exactly one retry before success");
      assert.equal(after.lastStatus, "ok");
      assert.equal(after.attempts, 0);
      assert.equal(after.lastTaskId, "task_retry_ok");
      assert.ok(!after.lastError, "success clears lastError");
      assert.equal(after.lastRunAt !== undefined, true);
      // Interval cadence: next run pushed ~1h out, so no third call happens.
      assert.ok(Date.parse(after.nextRunAt) > Date.now() + 3000, `nextRunAt must be far out, got ${after.nextRunAt}`);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(calls, 2, "no extra runs after the successful retry");
    } finally {
      stop();
    }
  });

  it("fails twice -> stops retrying, status failed, cadence resumes", async () => {
    const s = db.addSchedule("always fails", 3600);
    db.setScheduleNextRunAt(s.id, new Date(Date.now() - 1000).toISOString());
    let calls = 0;
    const stop = scheduler.startScheduler({
      runScheduled: async () => {
        calls += 1;
        throw new Error("broken");
      },
      intervalMs: 20,
      retryDelayMs: 60,
    });
    try {
      await waitFor(() => find(s.id).lastStatus === "failed");
      const after = find(s.id);
      assert.equal(after.attempts, 2, "exactly two attempts (original + one retry)");
      assert.equal(after.lastStatus, "failed");
      assert.ok(after.lastError?.includes("broken"), `lastError recorded, got ${after.lastError}`);
      assert.equal(after.enabled, true, "recurring routine stays enabled, only retrying stops");
      // Retry delay (60ms) long past -> a third call must never fire.
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(calls, 2, "no third attempt after two failures");
      // Cadence moved to the next regular interval, not the retry delay.
      assert.ok(Date.parse(after.nextRunAt) > Date.now() + 3000, `nextRunAt must be the next interval, got ${after.nextRunAt}`);
    } finally {
      stop();
    }
  });

  it("a spent one-shot disables itself after its run", async () => {
    const s = db.addSchedule("once only", 3600, undefined, undefined, undefined, undefined, true, { runAt: "2020-01-01T00:00" });
    assert.ok(Date.parse(s.nextRunAt) <= Date.now(), "past one-shot is due immediately");
    let calls = 0;
    const stop = scheduler.startScheduler({
      runScheduled: async () => {
        calls += 1;
        return "task_once";
      },
      intervalMs: 20,
      retryDelayMs: 40,
    });
    try {
      await waitFor(() => calls >= 1);
      await waitFor(() => find(s.id).enabled === false);
      const after = find(s.id);
      assert.equal(after.lastStatus, "ok");
      assert.equal(after.lastTaskId, "task_once");
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(calls, 1, "one-shot never re-fires");
    } finally {
      stop();
    }
  });

  it("a failed one-shot stops (disables) after the single retry", async () => {
    const s = db.addSchedule("once fails twice", 3600, undefined, undefined, undefined, undefined, true, { runAt: "2020-01-01T00:00" });
    let calls = 0;
    const stop = scheduler.startScheduler({
      runScheduled: async () => {
        calls += 1;
        throw new Error("no luck");
      },
      intervalMs: 20,
      retryDelayMs: 40,
    });
    try {
      await waitFor(() => find(s.id).lastStatus === "failed");
      const after = find(s.id);
      assert.equal(after.attempts, 2);
      assert.equal(after.enabled, false, "a twice-failed one-shot stops entirely");
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(calls, 2);
    } finally {
      stop();
    }
  });
});