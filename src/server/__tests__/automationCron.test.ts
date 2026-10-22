/**
 * D14 cron trigger: a cron automation must fire exactly at its due time.
 *
 * Uses node:test fake timers so "the due time" is deterministic — no waiting on
 * wall-clock cadence. The scheduler is the production one; only the timer source
 * is faked.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after, mock } from "node:test";

let tmpDir = "";
let closeDb: () => void;
let db: typeof import("../db.js");
let scheduler: typeof import("../scheduler.js");

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

describe("automation cron trigger (D14)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-automations-cron-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    db = await import("../db.js");
    scheduler = await import("../scheduler.js");
  });

  after(() => {
    mock.timers.reset();
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("fires a cron automation at the due time and not before", async () => {
    mock.timers.enable({ apis: ["setInterval", "Date"] });
    try {
      const s = db.addSchedule("every minute", 3600, undefined, undefined, "cron", undefined, true, { cron: "* * * * *" });
      // Arm it one tick out so we can prove it does not fire early.
      db.setScheduleNextRunAt(s.id, new Date(Date.now() + 60_000).toISOString());

      let calls = 0;
      const prompts: string[] = [];
      const stop = scheduler.startScheduler({
        runScheduled: async (prompt: string) => {
          calls += 1;
          prompts.push(prompt);
          return `task_${calls}`;
        },
        intervalMs: 60_000,
      });

      mock.timers.tick(30_000); // not due yet
      await flush();
      assert.equal(calls, 0, "must not fire before the due time");

      mock.timers.tick(30_000); // reaches the due instant
      await flush();
      assert.equal(calls, 1, "fires exactly once at the due time");
      assert.equal(prompts[0], "every minute");
      assert.equal(db.getSchedule(s.id)?.lastStatus, "ok");
      assert.equal(db.getSchedule(s.id)?.lastTaskId, "task_1");

      stop();
    } finally {
      mock.timers.reset();
    }
  });

  it("does not fire a cron automation that is not yet due", async () => {
    mock.timers.enable({ apis: ["setInterval", "Date"] });
    try {
      const s = db.addSchedule("later", 3600, undefined, undefined, "cron", undefined, true, { cron: "0 0 1 1 *" });
      db.setScheduleNextRunAt(s.id, new Date(Date.now() + 3_600_000).toISOString());
      let calls = 0;
      const stop = scheduler.startScheduler({ runScheduled: async () => { calls += 1; return "t"; }, intervalMs: 60_000 });
      mock.timers.tick(60_000);
      await flush();
      assert.equal(calls, 0);
      stop();
    } finally {
      mock.timers.reset();
    }
  });
});
