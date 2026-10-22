/**
 * Phase 2: Grok Bot bundle importer. A 2-agent bundle with one cron routine and
 * one referenced skill imports into agents, one global skill and one cron
 * schedule; a re-import skips the already-existing agents.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { after, before, describe, it } from "node:test";

type Import = typeof import("../grokbotImport.js");
type Agents = typeof import("../agents.js");
type Db = typeof import("../db.js");
type Skills = typeof import("../../tools/skills.js");

let tmpDir = "";
let closeDb: () => void;
let importer: Import;
let agents: Agents;
let db: Db;
let skills: Skills;

describe("grokbot importer (phase 2)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-grokbot-import-"));
    process.env.MANUS_LOCAL_DATA_DIR = path.join(tmpDir, "data");
    process.env.MANUS_LOCAL_SKILLS_DIR = path.join(tmpDir, "skills");
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    importer = await import("../grokbotImport.js");
    agents = await import("../agents.js");
    db = await import("../db.js");
    skills = await import("../../tools/skills.js");
    db.loadDb();
  });

  after(() => {
    delete process.env.MANUS_LOCAL_DATA_DIR;
    delete process.env.MANUS_LOCAL_SKILLS_DIR;
    try { closeDb(); } catch { /* already closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports a 2-agent bundle with one routine and one skill", () => {
    const bundle = importer.sanitizeGrokbotBundle({
      agents: [
        {
          id: "gb_1",
          name: "Scout",
          description: "Watches inbox trends",
          routines: [{ name: "hourly check", prompt: "Check the inbox", schedule: "0 * * * *", enabled: true }],
          referencedSkills: ["digests"],
        },
        { id: "gb_2", name: "Archivist", title: "Archivist", description: "Files reports", routines: "unknown" },
      ],
      skills: [{ name: "digests", description: "Build weekly digests", body: "Summarize the work items." }],
    });
    assert.ok(!("error" in bundle));
    const summary = importer.importGrokbotBundle(bundle);
    assert.deepEqual(summary, { agents: 2, skills: 1, schedules: 1, skipped: 0 });

    const imported = agents.listAgents(true).map((a) => a);
    assert.equal(imported.length, 2);
    assert.ok(imported.every((a) => a.source === "grokbot"));
    const scout = imported.find((a) => a.name === "Scout");
    assert.ok(scout);
    assert.equal(scout.description, "Watches inbox trends");
    const expectedNote = "Referenced skills: digests";
    assert.ok(scout.instructions.includes("Watches inbox trends"));
    assert.ok(scout.instructions.includes(expectedNote));
    assert.equal(summary.skills === 1 && skills.listSkillRecords().length === 1, true);

    const cronRuns = db.listSchedules().filter((s) => s.agentId === scout.id);
    assert.equal(cronRuns.length, 1);
    assert.equal(cronRuns[0]!.prompt, "Check the inbox");
    assert.equal(cronRuns[0]!.kind, "cron");
    assert.equal(cronRuns[0]!.cron, "0 * * * *");
    assert.equal(cronRuns[0]!.intervalSeconds, importer.cronIntervalSeconds("0 * * * *"));
    assert.equal(cronRuns[0]!.enabled, true);
  });

  it("is idempotent: re-import skips existing name+source agents and skill", () => {
    const bundle = importer.sanitizeGrokbotBundle({
      agents: [
        { name: "Scout", routines: "unknown" },
        { name: "Scout", routines: "unknown" },
        { name: "Fresh Bot", routines: "unknown" },
      ],
      skills: [{ name: "digests", body: "x" }],
    });
    assert.ok(!("error" in bundle));
    const summary = importer.importGrokbotBundle(bundle);
    assert.deepEqual(summary, { agents: 1, skills: 0, schedules: 0, skipped: 2 });
    assert.equal(skills.listSkillRecords().length, 1);
  });
});
