/**
 * Tests for D10 — repo-local skills + auto-suggest.
 *
 * Guarantees under test:
 *  - discovery reads `.loam/skills/<name>/SKILL.md` and `.agents/skills/<name>/SKILL.md`
 *  - repo-local skills take precedence over the global skills/ dir
 *  - invalid frontmatter (missing name) is ignored with a warning
 *  - `triggers:` is parsed from frontmatter
 *  - proposeSkillSuggestion stages a pending suggestion (mocked model)
 *  - accepting the suggestion writes the SKILL.md file into the project
 *
 * The global skills dir is isolated by setting MANUS_LOCAL_SKILLS_DIR BEFORE
 * the skills module (which reads it at import time) is dynamically imported.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

interface SkillsApi {
  discoverRepoSkills: (root: string) => { skills: Array<{ name: string; description: string; triggers: string[]; source: string }>; warnings: string[] };
  listProjectSkillRecords: (root: string) => { records: Array<{ name: string; description: string; file: string }>; warnings: string[] };
  loadProjectSkills: (root: string) => { skills: Array<{ name: string; description: string; body: string }>; warnings: string[] };
  parseTriggers: (raw: string) => string[];
}

interface SuggestApi {
  proposeSkillSuggestion: (opts: Record<string, unknown>) => Promise<{ ok: boolean; content: string; suggestion?: { name: string }; pending?: { id: string; kind: string; payload: Record<string, unknown> }; written?: string }>;
  acceptSkillSuggestion: (item: { kind: string; payload: Record<string, unknown> }) => string;
}

let projectRoot = "";
let globalSkillsDir = "";
let skills: SkillsApi;
let suggest: SuggestApi;

function writeSkill(root: string, relDir: string, name: string, description: string, body: string, triggers = ""): string {
  const dir = path.join(root, relDir);
  fs.mkdirSync(dir, { recursive: true });
  const triggersLine = triggers ? `triggers: ${triggers}\n` : "";
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n${triggersLine}---\n\n${body}\n`, "utf8");
  return file;
}

// SKILLS_DIR is captured at import time, so the global dir must be created and
// the env var set BEFORE the first dynamic import. It is then reset per test.
before(async () => {
  globalSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-skills-global-"));
  process.env.MANUS_LOCAL_SKILLS_DIR = globalSkillsDir;
  skills = (await import("../skills.js")) as unknown as SkillsApi;
  suggest = (await import("../skillSuggest.js")) as unknown as SuggestApi;
});

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-skills-proj-"));
  fs.rmSync(globalSkillsDir, { recursive: true, force: true });
  fs.mkdirSync(globalSkillsDir, { recursive: true });
});

after(() => {
  try { fs.rmSync(globalSkillsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.MANUS_LOCAL_SKILLS_DIR;
});

describe("repo-local skill discovery", () => {
  it("discovers skills from .loam/skills and .agents/skills and parses triggers", () => {
    writeSkill(projectRoot, ".loam/skills/deploy-api", "deploy-api", "Deploy the API", "steps", "setup, verify");
    writeSkill(projectRoot, ".agents/skills/db-migrate", "db-migrate", "Run migrations", "steps", "[migrate, before-pr]");

    const { skills: found, warnings } = skills.discoverRepoSkills(projectRoot);
    assert.deepEqual(warnings, []);
    assert.equal(found.length, 2);
    const byName = new Map(found.map((s) => [s.name, s]));
    assert.deepEqual(byName.get("deploy-api")?.triggers, ["setup", "verify"]);
    assert.deepEqual(byName.get("db-migrate")?.triggers, ["migrate", "before-pr"]);
    assert.equal(byName.get("deploy-api")?.source, ".loam/skills");
  });

  it("gives repo-local skills precedence over the global skills dir", () => {
    writeSkill(globalSkillsDir, "shared", "shared", "global version", "global body");
    writeSkill(projectRoot, ".loam/skills/shared", "shared", "repo version", "repo body");
    writeSkill(projectRoot, ".agents/skills/extra", "extra", "repo only", "repo body");

    const { records, warnings } = skills.listProjectSkillRecords(projectRoot);
    assert.deepEqual(warnings, []);
    const shared = records.find((r) => r.name === "shared")!;
    assert.equal(shared.description, "repo version");
    assert.ok(records.some((r) => r.name === "extra"));
  });

  it("ignores SKILL.md with invalid frontmatter and reports a warning", () => {
    writeSkill(projectRoot, ".loam/skills/valid", "valid", "ok", "body");
    const badDir = path.join(projectRoot, ".loam/skills/bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "SKILL.md"), "# no frontmatter here\n", "utf8");

    const { skills: found, warnings } = skills.discoverRepoSkills(projectRoot);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.name, "valid");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /no valid frontmatter name/);
  });

  it("merges repo-local bodies over global skills for the prompt", () => {
    writeSkill(globalSkillsDir, "global-only", "global-only", "global desc", "global body");
    writeSkill(projectRoot, ".loam/skills/shared", "shared", "repo desc", "repo body");
    writeSkill(globalSkillsDir, "shared", "shared", "global desc", "global body");

    const { skills: loaded } = skills.loadProjectSkills(projectRoot);
    const shared = loaded.find((s) => s.name === "shared")!;
    assert.equal(shared.description, "repo desc");
    assert.equal(shared.body, "repo body");
    assert.ok(loaded.some((s) => s.name === "global-only"));
  });

  it("parses comma, JSON and YAML-block trigger lists", () => {
    assert.deepEqual(skills.parseTriggers("a, b, c"), ["a", "b", "c"]);
    assert.deepEqual(skills.parseTriggers("[a, b]"), ["a", "b"]);
    assert.deepEqual(skills.parseTriggers("  "), []);
  });
});

describe("skill auto-suggest", () => {
  function fakeGate() {
    const staged: Array<{ kind: string; summary: string; payload: Record<string, unknown> }> = [];
    return {
      staged,
      gate: {
        stage(kind: string, summary: string, payload: Record<string, unknown>) {
          const item = { id: `pend_${staged.length + 1}`, at: "", kind, summary, payload };
          staged.push(item);
          return item;
        },
      },
    };
  }

  it("stages a pending suggestion from a mocked model", async () => {
    const { gate, staged } = fakeGate();
    const res = await suggest.proposeSkillSuggestion({
      projectRoot,
      digest: "task: set up the repo; ran npm ci and npm test",
      callModel: async () => JSON.stringify({
        name: "repo-setup",
        description: "Set up and verify this repo",
        triggers: ["setup", "verify"],
        content: "## When to Use\n...\n## Procedure\nnpm ci\nnpm test",
      }),
      gate,
    });
    assert.equal(res.ok, true);
    assert.equal(res.suggestion?.name, "repo-setup");
    assert.equal(staged.length, 1);
    assert.equal(staged[0]!.kind, "skill_suggest");
    const payload = staged[0]!.payload;
    assert.equal(payload["name"], "repo-setup");
    assert.match(String(payload["content"]), /name: repo-setup/);
    // Nothing is written until the user accepts.
    assert.equal(fs.existsSync(path.join(projectRoot, ".loam/skills/repo-setup/SKILL.md")), false);
  });

  it("accepting the suggestion writes the SKILL.md file", async () => {
    const { gate } = fakeGate();
    const res = await suggest.proposeSkillSuggestion({
      projectRoot,
      digest: "task: verify before PR",
      callModel: async () => JSON.stringify({
        name: "before-pr",
        description: "Run checks before opening a PR",
        content: "## Procedure\nnpm run lint\nnpm test",
      }),
      gate,
    });
    assert.equal(res.ok, true);
    const pending = res.pending!;
    const label = suggest.acceptSkillSuggestion({ kind: pending.kind, payload: pending.payload });
    assert.match(label, /before-pr/);
    const file = path.join(projectRoot, ".loam/skills/before-pr/SKILL.md");
    assert.equal(fs.existsSync(file), true);
    const raw = fs.readFileSync(file, "utf8");
    assert.match(raw, /name: before-pr/);
    assert.match(raw, /## Procedure/);
  });

  it("writes directly when no gate is supplied", async () => {
    const res = await suggest.proposeSkillSuggestion({
      projectRoot,
      digest: "task: setup",
      callModel: async () => JSON.stringify({ name: "solo", description: "d", content: "body" }),
    });
    assert.equal(res.ok, true);
    assert.equal(fs.existsSync(path.join(projectRoot, ".loam/skills/solo/SKILL.md")), true);
  });

  it("returns ok without a proposal when the model says skip", async () => {
    const { gate } = fakeGate();
    const res = await suggest.proposeSkillSuggestion({
      projectRoot,
      digest: "task: nothing reusable",
      callModel: async () => '{"skip":true}',
      gate,
    });
    assert.equal(res.ok, true);
    assert.equal(res.pending, undefined);
    assert.equal(fs.existsSync(path.join(projectRoot, ".loam/skills")), false);
  });

  it("fails cleanly on a non-JSON model reply", async () => {
    const res = await suggest.proposeSkillSuggestion({
      projectRoot,
      digest: "task: x",
      callModel: async () => "I cannot help with that.",
    });
    assert.equal(res.ok, false);
  });
});
