/**
 * Unit test for the skills HTTP surface's underlying logic (SK task).
 *
 * The current web Settings > Skills pane reuses the existing endpoints already
 * defined in src/server/http.ts:
 *   GET  /api/skills        -> listSkillRecords()
 *   GET  /api/skills/one     -> readSkillFile(name)
 *   POST /api/skills[/create]-> applySkill("skill_create", body)
 *   POST /api/skills/update  -> applySkill("skill_patch", { name, content })
 *   POST /api/skills/delete  -> applySkill("skill_delete", { name })
 *   POST /api/skills/install -> installFromCatalog({ id })  (id validated by resolveSkillId)
 *
 * This test exercises those pure functions against an isolated skills dir so a
 * regression in create/read/update/delete/list (or catalog-id validation) is
 * caught without touching the network.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

interface SkillsApi {
  listSkillRecords: () => { name: string; description: string; dir: string; file: string }[];
  readSkillFile: (name: string) => { name: string; description: string; body: string; file: string; content: string } | null;
  applySkill: (kind: string, payload: Record<string, unknown>) => { ok: boolean; content: string };
  validateSkill: (kind: string, payload: Record<string, unknown>) => string | null;
  buildSkillFile: (name: string, description: string, body: string) => string;
  parseFrontmatter: (raw: string) => { name?: string; description?: string };
}

interface RegistryApi {
  resolveSkillId: (id: string) => string;
}

let tmpDir = "";
let skills: SkillsApi;
let registry: RegistryApi;

describe("skills endpoints logic (list/read/create/update/delete + catalog id)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-skills-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    process.env.MANUS_LOCAL_SKILLS_DIR = path.join(tmpDir, "skills");
    const skillsMod = await import("../../tools/skills.js");
    const registryMod = await import("../../tools/skillsRegistry.js");
    skills = {
      listSkillRecords: skillsMod.listSkillRecords,
      readSkillFile: skillsMod.readSkillFile,
      applySkill: skillsMod.applySkill as SkillsApi["applySkill"],
      validateSkill: skillsMod.validateSkill as SkillsApi["validateSkill"],
      buildSkillFile: skillsMod.buildSkillFile,
      parseFrontmatter: skillsMod.parseFrontmatter,
    };
    registry = { resolveSkillId: registryMod.resolveSkillId };
  });

  after(() => {
    delete process.env.MANUS_LOCAL_DATA_DIR;
    delete process.env.MANUS_LOCAL_SKILLS_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("buildSkillFile / parseFrontmatter round-trips name and description", () => {
    const file = skills.buildSkillFile("release-check", "Verify a build before tagging", "# Steps\n1. run tests");
    const fm = skills.parseFrontmatter(file);
    assert.strictEqual(fm.name, "release-check");
    assert.strictEqual(fm.description, "Verify a build before tagging");
  });

  it("creates, lists, reads and rewrites a skill (POST /api/skills/create + update path)", () => {
    const created = skills.applySkill("skill_create", {
      name: "release-check",
      description: "Verify a build before tagging",
      content: "# Steps\n1. run tests",
    });
    assert.strictEqual(created.ok, true);

    const listed = skills.listSkillRecords();
    assert.ok(listed.some((r) => r.name === "release-check"), "the created skill is listed");

    const view = skills.readSkillFile("release-check");
    assert.ok(view, "readSkillFile returns the skill");
    assert.ok(view!.body.includes("run tests"), "the body is readable for the UI editor");

    // The /api/skills/update route rebuilds the whole file via buildSkillFile + skill_patch.
    const patched = skills.applySkill("skill_patch", {
      name: "release-check",
      content: skills.buildSkillFile("release-check", "Updated description", "# Steps\n1. run more tests"),
    });
    assert.strictEqual(patched.ok, true);
    const after = skills.readSkillFile("release-check");
    assert.strictEqual(after!.description, "Updated description");
    assert.ok(after!.body.includes("run more tests"));
  });

  it("validates create: requires name, description content and rejects duplicates without overwrite", () => {
    assert.ok(skills.validateSkill("skill_create", { description: "x", content: "y" }), "missing name");
    assert.ok(skills.validateSkill("skill_create", { name: "no-body" }), "missing content");
    const dup = skills.validateSkill("skill_create", { name: "release-check", description: "x", content: "y" });
    assert.ok(dup && dup.includes("already exists"), "duplicate name without overwrite is rejected");
    const forced = skills.validateSkill("skill_create", { name: "release-check", description: "x", content: "y", overwrite: true });
    assert.strictEqual(forced, null, "overwrite=true allows re-creating");
  });

  it("deletes a skill (POST /api/skills/delete)", () => {
    const removed = skills.applySkill("skill_delete", { name: "release-check" });
    assert.strictEqual(removed.ok, true);
    assert.ok(!skills.readSkillFile("release-check"), "skill is gone after delete");
  });

  it("readSkillFile returns null for unknown names and delete fails cleanly", () => {
    assert.strictEqual(skills.readSkillFile("does-not-exist"), null);
    const removed = skills.applySkill("skill_delete", { name: "does-not-exist" });
    assert.strictEqual(removed.ok, false);
    assert.ok(removed.content.includes("not found"), "delete reports not found");
  });

  it("resolveSkillId accepts category/name and rejects malformed catalog ids (POST /api/skills/install)", () => {
    assert.strictEqual(registry.resolveSkillId("dev/pdf"), "dev/pdf");
    assert.strictEqual(registry.resolveSkillId(" a/b/c "), "a/b/c");
    assert.throws(() => registry.resolveSkillId("pdf"), /category\/name|must look like/, "single segment is rejected");
    assert.throws(() => registry.resolveSkillId("../etc/passwd"), /must look like/, "traversal is rejected");
  });
});
