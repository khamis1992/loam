import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dedupeHits, repoRelative, sarifToHits } from "../sarif.js";
import { runScanners, scrubbedEnv } from "../scanners.js";
import type { Exec } from "../scanners.js";

const sarif = (name: string, results: unknown[], rules: unknown[] = []): unknown => ({
  version: "2.1.0", runs: [{ tool: { driver: { name, rules } }, results }],
});
const result = (ruleId: string, uri: string, line = 3, extra: Record<string, unknown> = {}): unknown => ({
  ruleId, message: { text: "first line\nsecond" }, level: "error",
  locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } }], ...extra,
});

test("sarifToHits maps tool, path, line, severity and determinism", () => {
  const { hits, dropped } = sarifToHits(sarif("Gitleaks", [result("generic-api-key", "./src/a.ts", 7)]));
  assert.equal(dropped, 0);
  assert.equal(hits.length, 1);
  const h = hits[0]!;
  assert.equal(h.tool, "gitleaks");
  assert.equal(h.file, "src/a.ts");
  assert.equal(h.line, 7);
  assert.equal(h.message, "first line");
  assert.equal(h.severity, "high");
  assert.equal(h.cls, "secret");
  assert.equal(h.deterministic, true);
});

test("opengrep hits are not deterministic; security-severity refines", () => {
  const rules = [{ id: "r1", properties: { "security-severity": "9.5" } }];
  const { hits } = sarifToHits(sarif("opengrep", [result("r1", "x.py")], rules));
  assert.equal(hits[0]?.deterministic, false);
  assert.equal(hits[0]?.severity, "critical");
});

test("unsafe paths are dropped, missing line defaults to 1", () => {
  assert.equal(repoRelative("/etc/passwd"), null);
  assert.equal(repoRelative("\\\\host\\share\\a"), null);
  assert.equal(repoRelative("../x"), null);
  assert.equal(repoRelative("file:///a"), null);
  const doc = sarif("osv", [result("GHSA-1", "/abs/a"), result("GHSA-2", "pkg/lock.json")]);
  (doc as { runs: { results: { locations: { physicalLocation: { region?: unknown } }[] }[] }[] }).runs[0]!.results[1]!.locations[0]!.physicalLocation.region = undefined;
  const { hits, dropped } = sarifToHits(doc);
  assert.equal(dropped, 1);
  assert.equal(hits[0]?.line, 1);
});

test("unknown tool without fallback is dropped; malformed docs never throw", () => {
  assert.equal(sarifToHits(sarif("mystery", [result("r", "a.ts")])).hits.length, 0);
  assert.equal(sarifToHits(sarif("mystery", [result("r", "a.ts")]), "osv").hits.length, 1);
  assert.deepEqual(sarifToHits(null).hits, []);
  assert.deepEqual(sarifToHits({ runs: "x" }).hits, []);
});

test("dedupeHits keeps the first of identical tuples", () => {
  const { hits } = sarifToHits(sarif("osv", [result("a", "f.ts", 1), result("a", "f.ts", 1), result("a", "f.ts", 2)]));
  assert.equal(dedupeHits(hits).length, 2);
});

function tmp(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "audit-scan-")));
}

test("runScanners: ok, unavailable, tool_error, timeout and malformed output never throw", async () => {
  const target = tmp();
  const scratch = path.join(tmp(), "scratch");
  fs.writeFileSync(path.join(target, "package.json"), "{}");
  const exec: Exec = async (exe, argv) => {
    if (exe === "gitleaks") {
      const out = argv[argv.indexOf("--report-path") + 1]!;
      fs.writeFileSync(out, JSON.stringify(sarif("gitleaks", [result("k", "a.ts")])));
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    if (exe === "trivy") {
      const out = argv[argv.indexOf("--output") + 1]!;
      fs.writeFileSync(out, JSON.stringify(sarif("Trivy", [result("CVE-1", "pkg/lock.json")])));
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    if (exe === "osv-scanner") return { code: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" };
    if (exe === "guarddog") return { code: 0, stdout: "not json", stderr: "", timedOut: false };
    return { code: null, stdout: "", stderr: "", timedOut: true };
  };
  const r = await runScanners({ target, scratch, tools: ["gitleaks", "osv", "guarddog", "opengrep", "trivy"], exec });
  const by = Object.fromEntries(r.reports.map((x) => [x.tool, x.status]));
  assert.equal(by.gitleaks, "ok");
  assert.equal(by.osv, "unavailable");
  assert.equal(by.guarddog, "tool_error");
  assert.equal(by.opengrep, "timeout");
  assert.equal(by.trivy, "ok");
  assert.equal(r.hits.length, 2);
  assert.equal(r.sarif.length, 2);
});

test("nuclei stays skipped without a live target and runs against a configured one", async () => {
  const target = tmp();
  const scratch = path.join(tmp(), "s2");
  const prev = process.env.LOAM_AUDIT_LIVE_TARGET;
  try {
    delete process.env.LOAM_AUDIT_LIVE_TARGET;
    const idle = await runScanners({ target, scratch, tools: ["nuclei"], exec: async () => { throw new Error("must not run"); } });
    assert.equal(idle.reports[0]?.status, "skipped");
    assert.match(idle.reports[0]?.detail ?? "", /LOAM_AUDIT_LIVE_TARGET/);

    process.env.LOAM_AUDIT_LIVE_TARGET = "https://staging.example.test";
    let sawUrl = "";
    const exec: Exec = async (_exe, argv) => {
      sawUrl = argv[argv.indexOf("-u") + 1]!;
      const out = argv[argv.indexOf("-sarif-export") + 1]!;
      fs.writeFileSync(out, JSON.stringify(sarif("nuclei", [result("cve-1", "app.py")])));
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const live = await runScanners({ target, scratch, tools: ["nuclei"], exec });
    assert.equal(live.reports[0]?.status, "ok");
    assert.equal(sawUrl, "https://staging.example.test");
    assert.equal(live.reports[0]?.hitCount, 1);
  } finally {
    if (prev === undefined) delete process.env.LOAM_AUDIT_LIVE_TARGET;
    else process.env.LOAM_AUDIT_LIVE_TARGET = prev;
  }
});

test("runScanners honours a pre-aborted signal", async () => {
  const ac = new AbortController();
  ac.abort();
  const r = await runScanners({
    target: tmp(), scratch: path.join(tmp(), "s"), tools: ["gitleaks"], signal: ac.signal,
    exec: async () => { throw new Error("must not run"); },
  });
  assert.equal(r.reports[0]?.status, "skipped");
});

test("scrubbedEnv keeps only the allow-list", () => {
  const env = scrubbedEnv({ PATH: "p", OPENAI_API_KEY: "secret", HOME: "h" } as NodeJS.ProcessEnv);
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH"]);
});
