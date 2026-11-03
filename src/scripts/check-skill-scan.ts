/**
 * check:skill-scan — Cap C gate: fixtures (evil fails with criticals, Arabic +
 * bidi-safe text passes, emoji-ZWJ passes), every shipped skill passes, staged
 * install blocks the evil skill (target dir absent, staging empty), lock drift
 * detection clean→modified, and the export keeps Arabic text.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSkillDir } from "../skills/scan/scanner.js";
import { RULES, RULESET_VERSION } from "../skills/scan/rules.js";
import { stagedInstall, SkillScanBlocked } from "../skills/install.js";
import { lockStatus } from "../skills/lock.js";
import { exportSkill } from "../skills/translate.js";
import { parseGithubSkillRef } from "../skills/github.js";

process.env.LOAM_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "loam-skscan-"));
process.env.MANUS_LOCAL_DATA_DIR ??= process.env.LOAM_DATA_DIR;

// 1. Ruleset shape.
assert.equal(RULESET_VERSION, "loam-skillscan-1");
assert.ok(RULES.length >= 20, `expected a substantive ruleset, got ${RULES.length}`);

// 2. Fixtures.
const fixtures = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "fixtures", "skill-scan");
const evil = scanSkillDir(path.join(fixtures, "evil"));
assert.equal(evil.verdict, "fail", `evil fixture must fail (got ${evil.stats.critical}c/${evil.stats.high}h)`);
assert.ok(evil.findings.some((f) => f.ruleId === "LS-PI01"), "evil fixture must trip the instruction-override rule");
for (const okDir of ["arabic", "emoji", "clean"]) {
  const r = scanSkillDir(path.join(fixtures, okDir));
  assert.equal(r.verdict, "pass", `${okDir} fixture must pass (findings: ${r.findings.map((f) => f.ruleId).join(",") || "none"})`);
}
const bidi = scanSkillDir(path.join(fixtures, "bidi"));
assert.equal(bidi.verdict, "fail", "bidi override fixture must fail");
assert.ok(bidi.findings.some((f) => f.ruleId === "LS-UC01"));

// 3. Every shipped skill passes.
const skillsRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "skills");
let scanned = 0;
for (const name of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
  if (!name.isDirectory()) continue;
  const r = scanSkillDir(path.join(skillsRoot, name.name));
  scanned++;
  assert.notEqual(r.verdict, "fail", `shipped skill "${name}" must pass the scan (${r.findings.filter((f) => f.severity === "high" || f.severity === "critical").map((f) => f.ruleId).join(",")})`);
}
assert.ok(scanned >= 20, `expected to scan the shipped skills, found ${scanned}`);

// 4. Staged install blocks the evil skill and leaves nothing behind.
const { SKILLS_DIR, DATA_DIR } = await import("../config.js");
const evilFiles = [{ rel: "SKILL.md", url: "file://evil/SKILL.md" }];
const evilBody = fs.readFileSync(path.join(fixtures, "evil", "SKILL.md"), "utf8");
await assert.rejects(
  stagedInstall({ name: "evil-probe", files: evilFiles, source: { kind: "catalog", repo: "local", path: "evil", ref: "HEAD", commit: null }, fetchText: async () => evilBody }),
  (e: unknown) => e instanceof SkillScanBlocked,
);
assert.equal(fs.existsSync(path.join(SKILLS_DIR, "evil-probe")), false, "blocked skill must not land in SKILLS_DIR");
assert.equal(fs.readdirSync(path.join(DATA_DIR, "skill-staging")).length, 0, "staging must be empty after the block");

// 5. Lock drift: clean install → modified after an edit.
const cleanBody = "---\nname: probe-ar\ndescription: مهارة فحص\n---\n# فحص\nنص عربي سليم.\n";
const inst = await stagedInstall({ name: "probe-ar", files: [{ rel: "SKILL.md", url: "file://x/SKILL.md" }], source: { kind: "catalog", repo: "local", path: "probe", ref: "HEAD", commit: null }, fetchText: async () => cleanBody });
assert.equal(inst.report.verdict, "pass");
assert.equal(lockStatus("probe-ar", inst.report.contentHash), "clean");
fs.writeFileSync(path.join(inst.dir, "SKILL.md"), cleanBody + "\nتعديل محلي\n");
const afterEdit = scanSkillDir(inst.dir);
assert.equal(lockStatus("probe-ar", inst.report.contentHash), "clean", "install-time hash is clean");
assert.equal(lockStatus("probe-ar", afterEdit.contentHash), "modified", "edited folder hash must read modified");

// 6. Export keeps the Arabic text.
const exp = exportSkill(inst.dir, "cursor-mdc", "probe-ar");
assert.ok(exp.content.includes("مهارة فحص"), "Cursor export must keep Arabic");

// 7. GitHub ref parsing.
assert.deepEqual(parseGithubSkillRef("owner/repo/skills/x@v2"), { owner: "owner", repo: "repo", path: "skills/x", ref: "v2" });
assert.equal(parseGithubSkillRef("not-a-ref"), null);

fs.rmSync(inst.dir, { recursive: true, force: true });
console.log(`check:skill-scan OK — fixtures (evil fail / arabic+emoji+bidi pass), ${scanned} shipped skills pass, staged install blocks + lock drift + export + GitHub refs`);
