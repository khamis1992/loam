import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

let tmpDir = "";
let closeDb: () => void;
let sqlite: typeof import("../sqliteStore.js");
let db: typeof import("../db.js");
let dataControls: typeof import("../dataControls.js");
let memory: typeof import("../companionMemory.js");
let agents: typeof import("../agents.js");
let settings: typeof import("../settings.js");

describe("data controls", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-datacontrols-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    db = await import("../db.js");
    dataControls = await import("../dataControls.js");
    memory = await import("../companionMemory.js");
    agents = await import("../agents.js");
    settings = await import("../settings.js");
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("requires the exact typed confirmation", () => {
    assert.equal(dataControls.confirmIsDelete({ confirm: "DELETE" }), true);
    assert.equal(dataControls.confirmIsDelete({ confirm: "delete" }), false);
    assert.equal(dataControls.confirmIsDelete({ confirm: "DELETE!" }), false);
    assert.equal(dataControls.confirmIsDelete({}), false);
    assert.equal(dataControls.confirmIsDelete(undefined), false);
  });

  it("exports every collection with the documented shape", () => {
    db.createTask("export task", "Export task");
    db.createProject("export project");
    db.addSchedule("daily check", 3600);
    agents.createAgent({ name: "export agent" });
    memory.remember("team", { text: "pref store", kind: "preference", source: "user" });

    const report = dataControls.exportAllData();
    assert.equal(report.application, "Loam");
    assert.equal(report.apiVersion, 1);
    assert.ok(report.exportedAt.length > 0);
    assert.deepEqual(
      Object.keys(report).sort(),
      ["agents", "apiVersion", "application", "counts", "exportedAt", "memory", "projects", "schedules", "tasks"],
    );
    assert.equal(report.counts.tasks, 1);
    assert.equal(report.counts.projects, 1);
    assert.equal(report.counts.schedules, 1);
    assert.equal(report.counts.agents, 1);
    assert.equal(report.counts.memoryEntries, 1);
    assert.equal(report.tasks.length, 1);
    assert.equal((report.tasks[0] as { prompt?: string }).prompt, "export task");
    assert.equal(report.projects.length, 1);
    assert.equal(report.schedules.length, 1);
    assert.equal(report.agents.length, 1);

    // Memory exports metadata only — no entry text.
    const scope = report.memory.find((m) => m.agentId === "team");
    assert.ok(scope, "team memory scope missing from export");
    assert.equal(scope.entries.length, 1);
    assert.equal(typeof (scope.entries[0] as { kind?: string }).kind, "string");
    assert.ok(!JSON.stringify(scope.entries).includes("pref store"));
  });

  it("round-trips the training opt-out flag in settings", () => {
    settings.updateSettings({ trainingOptOut: true });
    assert.equal(settings.getSettings().trainingOptOut, true);

    settings.updateSettings({ trainingOptOut: false });
    assert.equal(settings.getSettings().trainingOptOut, false);

    // A non-boolean patch leaves the stored value untouched.
    settings.updateSettings({ trainingOptOut: undefined as unknown as boolean });
    assert.equal(settings.getSettings().trainingOptOut, false);
  });

  it("round-trips the codemode opt-in flag in settings", () => {
    settings.updateSettings({ codemode: true });
    assert.equal(settings.getSettings().codemode, true);

    settings.updateSettings({ codemode: false });
    assert.equal(settings.getSettings().codemode, false);

    // A non-boolean patch leaves the stored value untouched, and the stored
    // value is what the codemode tool's opt-in check reads.
    settings.updateSettings({ codemode: undefined as unknown as boolean });
    assert.equal(settings.getSettings().codemode, false);
  });

  it("deletes all user data with the typed confirmation", () => {
    db.createTask("doomed task", "Doomed");
    db.createProject("doomed project");
    db.addSchedule("doomed schedule", 60);
    agents.createAgent({ name: "doomed agent" });
    memory.remember("team", { text: "to be forgotten", kind: "fact", source: "user" });

    const report = dataControls.deleteAllUserData();
    assert.ok(report.deleted.tasks >= 2, "expected accumulated tasks to be deleted");
    assert.ok(report.deleted.projects >= 2);
    assert.ok(report.deleted.schedules >= 2);
    assert.ok(report.deleted.agents >= 2);
    assert.ok(report.deleted.memoryEntries >= 2);

    assert.equal(db.listTasks().length, 0);
    assert.equal(db.listProjects().length, 0);
    assert.equal(db.listSchedules().length, 0);
    assert.equal(agents.listAgents(true).length, 0);
    assert.equal(memory.listMemory("team", { includeInactive: true }).length, 0);

    // After deletion a fresh export reports empty collections.
    const after = dataControls.exportAllData();
    assert.equal(after.counts.tasks, 0);
    assert.equal(after.counts.projects, 0);
    assert.equal(after.counts.schedules, 0);
    assert.equal(after.counts.agents, 0);
    assert.equal(after.counts.memoryEntries, 0);
    assert.equal(after.memory.length, 0);
  });
});