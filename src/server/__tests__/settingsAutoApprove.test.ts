/**
 * Round-trip test for the write-approval preference (frontier audit F05).
 *
 * The bug was that `autoApprove` was persisted by updateSettings() but never
 * restored by loadSettings(), so a user's "require manual approval" choice was
 * silently dropped after a restart, and gateActive() treated a missing value as
 * auto-approve. The fix restores the field and makes the missing value the
 * conservative default (approval required).
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

let tmpDir = "";
let settings: typeof import("../settings.js");
let skills: typeof import("../../tools/skills.js");
let pending: typeof import("../pending.js");

describe("autoApprove preference round-trip", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-autoapprove-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    process.env.MANUS_LOCAL_SKILLS_DIR = path.join(tmpDir, "skills");
    settings = await import("../settings.js");
    skills = await import("../../tools/skills.js");
    pending = await import("../pending.js");
  });

  after(() => {
    delete process.env.MANUS_LOCAL_DATA_DIR;
    delete process.env.MANUS_LOCAL_SKILLS_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("defaults to the conservative gate when nothing is saved", () => {
    assert.equal(settings.loadSettings().autoApprove, undefined);
    assert.equal(settings.gateActive(), true, "missing autoApprove must require approval");
  });

  it("restores autoApprove:false across a reload", () => {
    settings.updateSettings({ autoApprove: false });
    settings.loadSettings();
    assert.equal(settings.getSettings().autoApprove, false);
    assert.equal(settings.gateActive(), true);
  });

  it("restores autoApprove:true across a reload", () => {
    settings.updateSettings({ autoApprove: true });
    settings.loadSettings();
    assert.equal(settings.getSettings().autoApprove, true);
    assert.equal(settings.gateActive(), false);
  });

  it("stages skill writes while the gate is active and applies them once it is off", async () => {
    const ctx = {} as never;
    const tools = new Map(skills.createSkillTools({ gate: pending.writeGate }).map((t) => [t.name, t]));
    const create = tools.get("skill_create")!;

    settings.updateSettings({ autoApprove: false });
    const staged = await create.run({ name: "autoapprove-gated", description: "d", content: "# x\n" }, ctx);
    assert.equal(staged.ok, true);
    assert.match(staged.content, /staged for approval/);
    assert.equal(skills.readSkillFile("autoapprove-gated"), null, "staged write must not hit disk");

    settings.updateSettings({ autoApprove: true });
    const applied = await create.run({ name: "autoapprove-direct", description: "d", content: "# y\n" }, ctx);
    assert.equal(applied.ok, true);
    assert.ok(skills.readSkillFile("autoapprove-direct"), "auto-approve applies directly");

    for (const item of pending.listPending()) pending.removePending(item.id);
    settings.updateSettings({ autoApprove: false });
  });
});
