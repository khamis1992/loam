import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

interface ScratchpadApi {
  addScratchpadItem: (agentId: string, text: string) => { id: string; agentId: string; text: string; status: "open" | "done"; createdAt: string; doneAt?: string };
  listScratchpadItems: (agentId: string, status?: "open" | "done") => ReturnType<ScratchpadApi["addScratchpadItem"]>[];
  completeScratchpadItem: (agentId: string, id: string) => ReturnType<ScratchpadApi["addScratchpadItem"]> | undefined;
  removeScratchpadItem: (agentId: string, id: string) => boolean;
}

let tmpDir = "";
let closeDb: () => void;
let api: ScratchpadApi;

describe("scratchpad", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-scratchpad-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    const mod = await import("../scratchpad.js");
    api = {
      addScratchpadItem: mod.addScratchpadItem,
      listScratchpadItems: mod.listScratchpadItems,
      completeScratchpadItem: mod.completeScratchpadItem,
      removeScratchpadItem: mod.removeScratchpadItem,
    };
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("adds, lists, completes and removes items per agent", () => {
    const a = api.addScratchpadItem("agent_a", "first task");
    const b = api.addScratchpadItem("agent_a", "second task");
    api.addScratchpadItem("agent_b", "other agent task");

    assert.equal(a.agentId, "agent_a");
    assert.equal(a.status, "open");
    assert.equal(typeof a.id, "string");

    const allA = api.listScratchpadItems("agent_a");
    assert.equal(allA.length, 2);
    assert.deepStrictEqual(allA.map((i) => i.text), ["second task", "first task"]);
    assert.equal(allA[0]!.status, "open");

    const openA = api.listScratchpadItems("agent_a", "open");
    assert.equal(openA.length, 2);
    const doneA = api.listScratchpadItems("agent_a", "done");
    assert.equal(doneA.length, 0);

    const completed = api.completeScratchpadItem("agent_a", a.id);
    assert.ok(completed);
    assert.equal(completed!.status, "done");
    assert.equal(typeof completed!.doneAt, "string");

    const afterComplete = api.listScratchpadItems("agent_a");
    assert.equal(afterComplete.length, 2);
    assert.equal(afterComplete[0]!.status, "open");
    assert.equal(afterComplete[0]!.text, "second task");
    assert.equal(afterComplete[1]!.status, "done");
    assert.equal(afterComplete[1]!.text, "first task");

    assert.ok(!api.completeScratchpadItem("agent_a", a.id));

    assert.ok(api.removeScratchpadItem("agent_a", b.id));
    assert.equal(api.listScratchpadItems("agent_a").length, 1);

    assert.ok(!api.removeScratchpadItem("agent_a", "missing"));
    assert.equal(api.listScratchpadItems("agent_b").length, 1);
  });

  it("rejects empty text", () => {
    assert.throws(() => api.addScratchpadItem("agent_x", "   "), /scratchpad text is required/);
  });
});
