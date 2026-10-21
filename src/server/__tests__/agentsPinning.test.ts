import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

let tmpDir = "";
let closeDb: () => void;
let agents: typeof import("../agents.js");

describe("agent pinning", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-agentpins-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    agents = await import("../agents.js");
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("pins, unpins and orders pinned agents first", () => {
    const a = agents.createAgent({ name: "alpha" });
    const b = agents.createAgent({ name: "bravo" });
    const c = agents.createAgent({ name: "charlie" });

    assert.equal(agents.listAgents().map((x) => x.id).join(","), [a.id, b.id, c.id].join(","));
    assert.ok(agents.createAgent({ name: "delta", pinned: true }).pinnedAt);

    agents.setAgentPinned(c.id, true);
    agents.setAgentPinned(a.id, true);

    const pinnedFirst = agents.listAgents();
    const pinned = pinnedFirst.filter((x) => typeof x.pinnedAt === "number");
    assert.deepEqual(pinned.map((x) => x.name), ["delta", "charlie", "alpha"]);

    agents.setAgentPinned(c.id, false);
    assert.equal(agents.getAgent(c.id)?.pinnedAt, undefined);
    assert.equal(agents.getAgent(c.id)?.sortOrder, undefined);
    assert.ok(!agents.listAgents().slice(0, 2).some((x) => x.id === c.id));

    agents.setAgentPinned(a.id, true);
    assert.equal(agents.getAgent(a.id)?.name, "alpha");
  });

  it("reorders pinned agents from an id sequence and is idempotent", () => {
    const a = agents.createAgent({ name: "pin-a" });
    const b = agents.createAgent({ name: "pin-b" });
    const d = agents.createAgent({ name: "pin-d" });
    const e = agents.createAgent({ name: "unpinned" });

    agents.setAgentPinned(d.id, true);
    agents.setAgentPinned(b.id, true);
    agents.setAgentPinned(a.id, true);
    const pinNames = () => agents.listAgents().filter((x) => typeof x.pinnedAt === "number").map((x) => x.name).filter((n) => n.startsWith("pin-"));
    assert.deepEqual(pinNames(), ["pin-d", "pin-b", "pin-a"]);

    const first = agents.reorderAgents([a.id, b.id, d.id]);
    assert.deepEqual(first.filter((x) => x.name.startsWith("pin-")).map((x) => x.name), ["pin-a", "pin-b", "pin-d"]);
    assert.ok(first.every((x) => typeof x.sortOrder === "number"));

    const again = agents.reorderAgents([a.id, b.id, d.id]);
    const rounds = () => agents.listAgents().filter((x) => (x as { name?: string }).name?.startsWith("pin-")).map((x) => (x as { sortOrder?: number }).sortOrder);
    assert.deepEqual(rounds(), first.filter((x) => x.name.startsWith("pin-")).map((x) => x.sortOrder as number));
    assert.deepEqual(agents.listAgents().filter((x) => (x as { name?: string }).name?.startsWith("pin-")).map((x) => x.id), [a.id, b.id, d.id]);

    const partial = agents.reorderAgents([d.id]);
    assert.deepEqual(partial.filter((x) => x.name.startsWith("pin-")).map((x) => x.name), ["pin-d", "pin-a", "pin-b"]);

    const unknown = agents.reorderAgents([e.id, "agent_bogus"]);
    assert.ok(!agents.getAgent(e.id)?.pinnedAt);
    assert.ok(unknown.every((x) => x.id !== e.id));

    const sorted = agents.listAgents();
    const pinnedCount = sorted.filter((x) => typeof x.pinnedAt === "number").length;
    assert.ok(sorted.slice(0, pinnedCount).every((x) => typeof x.pinnedAt === "number"));
  });

  it("threads pinned fields through create/list persistence", () => {
    agents.createAgent({ name: "seeded pin", pinnedAt: 1111, sortOrder: 7 });
    const list = agents.listAgents();
    const seededIdx = list.findIndex((x) => x.name === "seeded pin");
    const seeded = list[seededIdx];
    assert.equal(seeded?.sortOrder, 7);
    assert.equal(seeded?.pinnedAt, 1111);
    const firstUnpinnedIdx = list.findIndex((x) => typeof x.pinnedAt !== "number");
    assert.ok(seededIdx >= 0 && seededIdx < firstUnpinnedIdx, "seeded pin must rank inside the pinned block");

    agents.updateAgent(seeded!.id, { pinned: true });
    assert.ok(typeof agents.getAgent(seeded!.id)?.pinnedAt === "number");
    agents.updateAgent(seeded!.id, { sortOrder: null });
    assert.equal(agents.getAgent(seeded!.id)?.sortOrder, undefined);
  });
});
