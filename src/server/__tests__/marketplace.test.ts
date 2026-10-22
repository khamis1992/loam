import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

let tmpDir = "";
let closeDb: () => void;
let marketplace: typeof import("../marketplace.js");
let agents: typeof import("../agents.js");
let db: typeof import("../db.js");
let memory: typeof import("../companionMemory.js");

describe("marketplace", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-marketplace-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    marketplace = await import("../marketplace.js");
    agents = await import("../agents.js");
    db = await import("../db.js");
    memory = await import("../companionMemory.js");
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("loads the bundled catalog", () => {
    const { entries, version } = marketplace.loadMarketplaceCatalog();
    assert.equal(entries.length, 819);
    assert.match(version, /^[a-f0-9]{16}$/);
  });

  it("composes instructions for x.ai entries", () => {
    const entry = marketplace.getMarketplaceEntry("xai-account-book");
    assert.ok(entry);
    const instructions = marketplace.composeInstructions(entry);
    assert.match(instructions, /## Skills/);
    assert.match(instructions, /## Memory/);
    assert.ok(instructions.length <= 8000);
  });

  it("uses botdirectory prompt bodies verbatim", () => {
    const entry = marketplace.getMarketplaceEntry("bd-23-story-workshop");
    assert.ok(entry);
    assert.equal(marketplace.composeInstructions(entry), entry.instructions.slice(0, 8000));
  });

  it("maps categories and tools onto Loam modes", () => {
    const base = { category: "", tools: [] as string[] };
    assert.equal(marketplace.resolveMarketplaceMode({ ...base, category: "Engineering" } as never), "build");
    assert.equal(marketplace.resolveMarketplaceMode({ ...base, category: "Design" } as never), "media");
    assert.equal(marketplace.resolveMarketplaceMode({ ...base, category: "Sales", tools: ["Google Sheets"] } as never), "data");
    assert.equal(marketplace.resolveMarketplaceMode({ ...base, category: "Sales", tools: ["Google Docs"] } as never), "write");
  });

  it("appends a numeric suffix on name collisions", () => {
    assert.equal(marketplace.uniqueAgentName("Alfred", ["Alfred"]), "Alfred 2");
    assert.equal(marketplace.uniqueAgentName("Alfred", ["Alfred", "Alfred 2"]), "Alfred 3");
    assert.equal(marketplace.uniqueAgentName("Fresh", []), "Fresh");
  });

  it("installs idempotently", () => {
    const first = marketplace.installFromCatalog("bd-23-story-workshop");
    assert.ok(!("error" in first));
    assert.equal(first.already, false);
    const agent = agents.getAgent(first.agent.id);
    assert.ok(agent);
    assert.ok(agent.instructions.length > 0);

    const second = marketplace.installFromCatalog("bd-23-story-workshop");
    assert.ok(!("error" in second));
    assert.equal(second.already, true);
    assert.equal(second.agent.id, first.agent.id);
    assert.equal(marketplace.listActiveInstalls().filter((i) => i.catalogId === "bd-23-story-workshop").length, 1);
  });

  it("seeds x.ai memories and paused routines", () => {
    const result = marketplace.installFromCatalog("xai-account-book");
    assert.ok(!("error" in result));
    assert.equal(result.already, false);
    assert.ok(memory.listMemory(result.agent.id).length > 0);
    const routines = db.listSchedulesByAgent(result.agent.id);
    assert.ok(routines.length > 0);
    assert.ok(routines.every((routine) => routine.enabled === false));
  });

  it("clears the added state when the installed agent is archived", () => {
    const first = marketplace.installFromCatalog("xai-alfred");
    assert.ok(!("error" in first));
    agents.setAgentArchived(first.agent.id, true);
    assert.equal(marketplace.listActiveInstalls().some((i) => i.catalogId === "xai-alfred"), false);

    const second = marketplace.installFromCatalog("xai-alfred");
    assert.ok(!("error" in second));
    assert.equal(second.already, false);
    assert.notEqual(second.agent.id, first.agent.id);
    assert.ok(agents.getAgent(first.agent.id)?.archivedAt);
  });

  it("names a second install of the same bot with a suffix", () => {
    const first = marketplace.installFromCatalog("bd-23-story-workshop");
    assert.ok(!("error" in first));
    agents.setAgentArchived(first.agent.id, true);
    const second = marketplace.installFromCatalog("bd-23-story-workshop");
    assert.ok(!("error" in second));
    assert.equal(second.agent.name, `${first.agent.name} 2`.slice(0, 80));
  });

  it("rejects unknown catalog ids", () => {
    const result = marketplace.installFromCatalog("nope");
    assert.ok("error" in result);
    assert.equal(result.status, 404);
  });
});
