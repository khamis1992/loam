/**
 * P0 (Ponytail lazy-senior BUILD_SPEC): loadSkills must parse YAML block
 * scalars in SKILL.md frontmatter so a multi-line description survives the
 * loader, and must tolerate CRLF files (Windows-first, spec §0.3).
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadSkills, parseSkillFrontmatter } from "../prompt.js";

function makeSkillDir(entries: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-skills-"));
  for (const [name, content] of Object.entries(entries)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "SKILL.md"), content, "utf8");
  }
  return dir;
}

describe("parseSkillFrontmatter", () => {
  it("keeps plain one-line values working exactly as before", () => {
    const fm = "name: my-skill\ndescription: Short line that says when to use it.\nlicense: ignored";
    const parsed = parseSkillFrontmatter(fm);
    assert.equal(parsed.name, "my-skill");
    assert.equal(parsed.description, "Short line that says when to use it.");
  });

  it("round-trips a folded multi-line description (P0 acceptance)", () => {
    const fm = [
      "name: lazy-senior",
      "description: >",
      "  Use for every coding edit in build mode. Read the scope first, take the",
      "  smallest complete change from the ladder, and close with the skipped and",
      "  risk line.",
      "---",
    ].join("\n");
    const parsed = parseSkillFrontmatter(fm);
    assert.equal(
      parsed.description,
      "Use for every coding edit in build mode. Read the scope first, take the smallest complete change from the ladder, and close with the skipped and risk line.",
    );
  });

  it("supports the literal block scalar and the strip-chomp dash form", () => {
    const literal = parseSkillFrontmatter("description: |\n  line one\n  line two");
    assert.equal(literal.description, "line one\nline two");
    const foldedStrip = parseSkillFrontmatter("description: >-\n  a\n  b");
    assert.equal(foldedStrip.description, "a b");
  });

  it("strips matching quotes from a plain value", () => {
    const parsed = parseSkillFrontmatter('description: "Quoted text here"');
    assert.equal(parsed.description, "Quoted text here");
  });

  it("stops a block scalar at a dedented line", () => {
    const fm = "description: >\n  folded line\nname: after-block";
    const parsed = parseSkillFrontmatter(fm);
    assert.equal(parsed.description, "folded line");
    assert.equal(parsed.name, "after-block");
  });
});

describe("loadSkills with block scalars", () => {
  it("loads a CRLF skill file with a folded description (Windows-first)", () => {
    const crlf = [
      "---",
      "name: crlf-skill",
      "description: >",
      "  First clause of the description.",
      "  Second clause of the description.",
      "---",
      "# crlf-skill",
      "",
      "Body text.",
    ].join("\r\n");
    const dir = makeSkillDir({ "crlf-skill": crlf });
    try {
      const skills = loadSkills(dir);
      assert.equal(skills.length, 1);
      assert.equal(skills[0]!.name, "crlf-skill");
      assert.equal(skills[0]!.description, "First clause of the description. Second clause of the description.");
      assert.match(skills[0]!.body, /^# crlf-skill/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the directory name when frontmatter has no name", () => {
    const dir = makeSkillDir({ "dir-name": "---\ndescription: plain\n---\nbody" });
    try {
      const skills = loadSkills(dir);
      assert.equal(skills[0]!.name, "dir-name");
      assert.equal(skills[0]!.description, "plain");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
