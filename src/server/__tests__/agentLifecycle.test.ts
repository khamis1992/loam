import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-agent-lifecycle-"));
process.env.MANUS_LOCAL_DATA_DIR = dir;

const agents = await import("../agents.js");
const db = await import("../db.js");
const threads = await import("../agentThreads.js");
const channels = await import("../channels/router.js");
const groups = await import("../groupChats.js");
const lifecycle = await import("../agentLifecycle.js");
const sqlite = await import("../sqliteStore.js");

let agentId = "";
let scheduleId = "";

before(() => {
  const agent = agents.createAgent({ name: "Lifecycle Agent" });
  agentId = agent.id;
  scheduleId = db.addSchedule("run later", 3600, agentId).id;
  channels.createBinding("telegram", "42", agentId);
  groups.createGroup("Lifecycle Group", [agentId]);
  const task = db.createTask("first", "first", null, agentId);
  threads.setThread(agentId, task.id);
});

after(() => {
  sqlite.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("agent lifecycle trigger cleanup", () => {
  it("disables triggers on archive and keeps them disabled on restore", () => {
    const cleanup = lifecycle.archiveAgentLifecycle(agentId);
    assert.equal(cleanup.schedules, 1);
    assert.equal(cleanup.bindings, 1);
    assert.equal(cleanup.groups, 0);
    assert.equal(db.getSchedule(scheduleId)?.enabled, false);
    assert.equal(channels.listBindings(agentId).length, 0);
    assert.equal(groups.listGroups()[0]?.memberIds.length, 1);

    agents.setAgentArchived(agentId, false);
    assert.equal(db.getSchedule(scheduleId)?.enabled, false);
    assert.equal(groups.listGroups()[0]?.memberIds.length, 1);
  });

  it("deletes schedules and thread mappings permanently on delete", () => {
    const second = db.addSchedule("delete later", 3600, agentId);
    const cleanup = lifecycle.deleteAgentLifecycle(agentId);
    assert.equal(cleanup?.schedules, 2);
    assert.equal(cleanup?.groups, 1);
    assert.equal(groups.listGroups()[0]?.memberIds.length, 0);
    assert.equal(db.getSchedule(scheduleId), undefined);
    assert.equal(db.getSchedule(second.id), undefined);
    assert.equal(threads.getThread(agentId), undefined);
    assert.equal(agents.getAgent(agentId), undefined);
  });
});
