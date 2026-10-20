import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";
import { closeDb } from "../sqliteStore.js";

let tmpDir = "";

describe("scratchpad", () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-scratchpad-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
  });

  after(() => {
    closeDb();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    delete process.env.MANUS_LOCAL_DATA_DIR;
  });

  it("adds, lists, completes and removes items per agent", async () => {
    const { addScratchpadItem, listScratchpadItems, completeScratchpadItem, removeScratchpadItem } = await import(
      "../scratchpad.js"
    );

    const a = addScratchpadItem("agent_a", "first task");
    const b = addScratchpadItem("agent_a", "second task");
    addScratchpadItem("agent_b", "other agent task");

    assert.equal(a.agentId, "agent_a");
    assert.equal(a.status, "open");
    assert.equal(typeof a.id, "string");

    const allA = listScratchpadItems("agent_a");
    assert.equal(allA.length, 2);
    assert.deepStrictEqual(allA.map((i) => i.text), ["second task", "first task"]);
    assert.equal(allA[0]!.status, "open");

    const openA = listScratchpadItems("agent_a", "open");
    assert.equal(openA.length, 2);
    const doneA = listScratchpadItems("agent_a", "done");
    assert.equal(doneA.length, 0);

    const completed = completeScratchpadItem("agent_a", a.id);
    assert.ok(completed);
    assert.equal(completed!.status, "done");
    assert.equal(typeof completed!.doneAt, "string");

    const afterComplete = listScratchpadItems("agent_a");
    assert.equal(afterComplete.length, 2);
    assert.equal(afterComplete[0]!.status, "open");
    assert.equal(afterComplete[0]!.text, "second task");
    assert.equal(afterComplete[1]!.status, "done");
    assert.equal(afterComplete[1]!.text, "first task");

    assert.ok(!completeScratchpadItem("agent_a", a.id));

    assert.ok(removeScratchpadItem("agent_a", b.id));
    assert.equal(listScratchpadItems("agent_a").length, 1);

    assert.ok(!removeScratchpadItem("agent_a", "missing"));
    assert.equal(listScratchpadItems("agent_b").length, 1);
  });

  it("rejects empty text", async () => {
    const { addScratchpadItem } = await import("../scratchpad.js");
    assert.throws(() => addScratchpadItem("agent_x", "   "), /scratchpad text is required/);
  });
});
