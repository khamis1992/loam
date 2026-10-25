import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SKILLS = ["remediate", "remediate-node-runtime", "remediate-php-runtime", "remediate-gitlab-selfmanaged", "remediate-electron-runtime"];
const ATTRIBUTION = "CognitionAI/devin-vuln-fixes (MIT";

test("D-3(G): all five playbooks present, parse, carry the MIT attribution footer, no Sparkles", () => {
  for (const name of SKILLS) {
    const file = path.resolve(process.cwd(), "skills", name, "SKILL.md");
    assert.ok(fs.existsSync(file), name);
    const body = fs.readFileSync(file, "utf8");
    assert.match(body, /^---\nname: /m, `${name}: frontmatter`);
    assert.ok(body.includes("description:"), `${name}: description`);
    if (name !== "remediate") {
      assert.ok(body.includes(ATTRIBUTION), `${name}: attribution footer`);
    }
    assert.ok(!body.includes("✨"), `${name}: no Sparkles`);
    // The umbrella names the engine tools; ecosystem skills carry channel rules.
    if (name === "remediate") {
      assert.ok(body.includes("remediation_start"));
      assert.ok(body.includes("لا تعدّل") || body.includes("Forbidden"));
    }
  }
});

test("umbrella skill: engine-owns-the-steps rule + Arabic-first", () => {
  const body = fs.readFileSync(path.resolve(process.cwd(), "skills", "remediate", "SKILL.md"), "utf8");
  assert.ok(/[\u0600-\u06FF]/.test(body));
  assert.ok(body.includes("بوابة"));
});
