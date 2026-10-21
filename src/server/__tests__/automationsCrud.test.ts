/**
 * Automations CRUD (option 22): the schedule store behind the automations page.
 * Exercises create / read / update / delete / agent scoping / cron validation on
 * the real isolated store (same pattern as schedulerRetry.test.ts).
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

let tmpDir = "";
let closeDb: () => void;
let db: typeof import("../db.js");

describe("automations CRUD (option 22)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-automations-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    db = await import("../db.js");
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("creates a recurring automation and clamps the interval to at least 30s", () => {
    const s = db.addSchedule("Summarize my inbox", 5);
    assert.equal(s.prompt, "Summarize my inbox");
    assert.equal(s.intervalSeconds, 30);
    assert.equal(s.enabled, true);
    assert.ok(s.nextRunAt, "a new schedule must be armed with a next run time");

    const fetched = db.getSchedule(s.id);
    assert.ok(fetched);
    assert.equal(fetched!.id, s.id);
    assert.equal(fetched!.prompt, "Summarize my inbox");
  });

  it("lists automations and scopes them by companion agent", () => {
    const a = db.addSchedule("agent one", 3600, "agent_1");
    db.addSchedule("agent two", 3600, "agent_2");
    const scoped = db.listSchedulesByAgent("agent_1");
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0]!.id, a.id);
    assert.ok(db.listSchedules().length >= 2);
  });

  it("updates the prompt and enabled state and re-arms the next run time", () => {
    const s = db.addSchedule("original", 60);
    db.setScheduleNextRunAt(s.id, new Date(Date.now() - 1000).toISOString());
    const updated = db.updateSchedule(s.id, { prompt: "updated", enabled: true });
    assert.ok(updated);
    assert.equal(updated!.prompt, "updated");
    assert.equal(updated!.enabled, true);
    assert.ok(Date.parse(updated!.nextRunAt!) >= Date.now() - 5000, "re-arming must schedule a future run");

    // Unknown ids are a no-op rather than an error.
    assert.equal(db.updateSchedule("sched_missing", { enabled: false }), undefined);
  });

  it("deletes an automation and reports whether a row was removed", () => {
    const s = db.addSchedule("doomed", 60);
    assert.equal(db.deleteSchedule(s.id), true);
    assert.equal(db.getSchedule(s.id), undefined);
    assert.equal(db.deleteSchedule(s.id), false);
  });

  it("rejects invalid cron specs before anything is persisted", () => {
    const before = db.listSchedules().length;
    assert.throws(() =>
      db.addSchedule("bad cron", 60, undefined, undefined, "cron", undefined, true, { cron: "not a cron" }),
    );
    assert.equal(db.listSchedules().length, before);
  });
});
