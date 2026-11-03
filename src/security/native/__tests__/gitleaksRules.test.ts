import { strict as assert } from "node:assert";
import path from "node:path";
import { test } from "node:test";
import { SecretScanner } from "../secrets/engine.js";
import { DEFAULT_RULES } from "../secrets/rules.js";
import { loadGitleaksRules, rulesWithGitleaks } from "../secrets/gitleaks.js";

const RULES_DIR = path.resolve(process.cwd(), "rules");
const VENDORED = path.join(RULES_DIR, "loam", "secrets", "gitleaks.toml");
const AWS = "AKIA" + "IOSFODNN7EXAMPLQ";

test("vendored gitleaks rule set loads, compiles and stays large", () => {
  const loaded = loadGitleaksRules(VENDORED);
  assert.ok(loaded, "vendored rules/loam/secrets/gitleaks.toml must load");
  assert.ok(loaded.rules.length > 200, `expected >200 rules, got ${loaded.rules.length}`);
  assert.ok(loaded.dropped < 30, `${loaded.dropped} rules failed to compile as JS RegExp`);
  assert.ok(loaded.globalAllow.paths.length > 0);
});

test("gitleaks rules find an AWS key and the global allowlist skips images", () => {
  const loaded = loadGitleaksRules(VENDORED)!;
  const s = new SecretScanner({ rules: loaded.rules, globalAllow: loaded.globalAllow });
  assert.ok(s.scan(`key = "${AWS}"\n`, "a.env").some((f) => /aws/i.test(f.ruleId)));
  assert.deepEqual(s.scan(`key = "${AWS}"\n`, "logo.png"), []);
});

test("loam-authored rules win on id collisions", () => {
  const merged = rulesWithGitleaks(RULES_DIR, DEFAULT_RULES)!;
  const gitleaks = loadGitleaksRules(VENDORED)!;
  const collisions = gitleaks.rules.filter((g) => DEFAULT_RULES.some((l) => l.id === g.id)).length;
  assert.ok(collisions > 0, "expected at least one id collision with the curated set");
  assert.equal(merged.rules.length, gitleaks.rules.length + DEFAULT_RULES.length - collisions);
  assert.equal(merged.rules.find((r) => r.id === DEFAULT_RULES[0]!.id), DEFAULT_RULES[0]);
});

test("positive path filter and allowlist regex targets", () => {
  const rules = [
    { id: "npmrc", description: "npm token", keywords: ["_authtoken"], regex: "_authToken=(\\S{20,})", secretGroup: 1, severity: "high" as const, path: "\\.npmrc$" },
    { id: "assign", description: "assignment", keywords: ["token"], regex: "token\\s*=\\s*(\\S+)", secretGroup: 1, severity: "high" as const, allow: { regexes: [{ re: "allowed", target: "line" as const }] } },
  ];
  const s = new SecretScanner({ rules });
  assert.equal(s.scan("token = allowedsecret12345\n", "a.txt").length, 0);
  assert.equal(s.scan("token = othersecret12345\n", "b.txt").length, 1);
  assert.deepEqual(s.scan("_authToken=aaaaaaaaaaaaaaaaaaaaaa\n", "config.yml"), []);
  assert.equal(s.scan("_authToken=aaaaaaaaaaaaaaaaaaaaaa\n", "home.npmrc").length, 1);
});
