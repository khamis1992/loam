import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Confirmed, FindingRecord } from "../../audit/types.js";
import { auditNormalizer } from "../adapters/audit.js";
import { pentestNormalizer } from "../adapters/pentest.js";
import { toSecurityFindings, toSarif } from "../funnel.js";
import type { RawFinding } from "../types.js";
import { engineForTool } from "../types.js";
import type { PentestFinding } from "../../../tools/pentest.js";
import { CoverageLedger } from "../../coverage/ledger.js";
import { compareFindings } from "../../findings.js";

const confirmed: Confirmed = {
  verdict: "confirmed", fingerprint: "loam-sca:GHSA-1:package-lock.json:1", title: "Dependency with a known vulnerability",
  description: "left-pad@1.3.0: RCE", root_cause: "dep", intended_behavior: "clean",
  trace: [{ kind: "sink", file: "package-lock.json", line: 1, scope: "known-vulnerability", description: "x" }],
  evidence: [{ file: "package-lock.json", line: 1, description: "match" }],
  conditions: [], execution: { attacker_perspective: "a", payloads: [], instructions: [], observed_result: "o" },
  remediation: { strategy: "Upgrade to 1.3.1." },
  severity: { likelihood: { score: "high", reason: "r" }, impact: { score: "critical", reason: "r" }, overall_severity: "critical" },
  confidence: { score: "high", reason: "r" },
  evidence_vector: [{ source: "rule", state: "confirmed", ref: "loam-sca:GHSA-1" }],
  evidence_assurance: "source-only",
  intel: { cve: "CVE-2024-1", risk: { risk_score: 84.5, risk_label: "CRITICAL", urgency: "PATCH WITHIN 24 HOURS", recommendation: "patch now", scoring_version: "1.1", boosters_applied: [] }, kev: { dateAdded: "2024-06-02", dueDate: "", ransomware: false } },
};

const needsValidation: FindingRecord = {
  verdict: "needs_validation", fingerprint: "opengrep:RULE-2:a.ts:10", title: "Possible injection",
  description: "pattern matched", claimed_root_cause: "x",
  trace: [{ kind: "sink", file: "a.ts", line: 10, scope: "s", description: "d" }],
  evidence: [{ file: "a.ts", line: 10, description: "d" }],
  blockers: ["needs manual review"], validation_plan: { local: "inspect" },
  evidence_vector: [{ source: "rule", state: "unknown", ref: "opengrep:RULE-2" }], evidence_assurance: "source-only",
};

const rejected: FindingRecord = {
  verdict: "rejected", fingerprint: "x:R:z:1", title: "nope", description: "d", claimed_root_cause: "c",
  trace: [{ kind: "sink", file: "z.ts", line: 1, scope: "s", description: "d" }],
  evidence: [{ file: "z.ts", line: 1, description: "d" }], reason: "not exploitable",
  evidence_assurance: "source-only",
};

test("audit adapter maps records to unified RawFindings with engine routing", () => {
  const raws = auditNormalizer.adapt([confirmed, needsValidation, rejected]);
  assert.equal(raws.length, 2, "rejected is dropped");
  const sca = raws[0]!;
  assert.equal(sca.engine, "sca");
  assert.equal(sca.severity, "critical");
  assert.equal(sca.target, "package-lock.json:1");
  assert.equal(sca.remediation, "Upgrade to 1.3.1.");
  assert.deepEqual(Object.keys(sca.properties?.intel as object).sort(), ["cve", "kev", "risk"]);
  const sast = raws[1]!;
  assert.equal(sast.engine, "sast");
  assert.equal(sast.severity, "medium");
  assert.equal(sast.properties?.verdict, "needs_validation");
});

test("pentest adapter maps findings/errors and drops passes", () => {
  const pfs: PentestFinding[] = [
    { id: "EV1", check: "security_headers", verdict: "finding", severity: "medium", title: "Missing CSP", target: "http://127.0.0.1:8080", detail: "no header" },
    { id: "EV2", check: "source_sql", verdict: "finding", severity: "high", title: "SQLi", target: "a.ts:5", detail: "d", remediation: "parameterize" },
    { id: "EV3", check: "security_headers", verdict: "pass", severity: "info", title: "ok", target: "t", detail: "d" },
    { id: "EV4", check: "csrf", verdict: "error", severity: "info", title: "failed", target: "t", detail: "timeout" },
  ];
  const raws = pentestNormalizer.adapt(pfs);
  assert.deepEqual(raws.map((r) => `${r.engine}:${r.ruleId}`), ["recon:security_headers", "sast:source_sql", "recon:csrf"]);
  assert.equal(raws[2]!.severity, "info");
  assert.equal(raws[2]!.properties?.verdict, "error");
  assert.equal(raws[1]!.remediation, "parameterize");
});

test("funnel: RawFindings become stable SecurityFindings and SARIF results", () => {
  const raws: RawFinding[] = [
    { engine: "secrets", ruleId: "aws-key", severity: "critical", target: ".env:3", title: "AWS key", detail: "leaked", verified: true },
    { engine: "config", ruleId: "CKV_AWS_1", severity: "medium", target: "main.tf:8", title: "open SG", detail: "d" },
    { engine: "sca", ruleId: "GHSA-9", severity: "info", target: "pkg@1.0", title: "info only", detail: "d" },
  ];
  const sec = toSecurityFindings(raws);
  assert.equal(sec.length, 3);
  const again = toSecurityFindings(raws);
  assert.deepEqual(sec.map((f) => f.fingerprint), again.map((f) => f.fingerprint), "fingerprints are deterministic");
  assert.equal(sec[0]!.check, "secrets:aws-key");
  const doc = toSarif(raws) as { runs: { results: { ruleId: string; level: string; properties: Record<string, unknown> }[]; invocations: { executionSuccessful: boolean }[] }[] };
  assert.equal(doc.runs[0]!.results.length, 2, "info-severity records stay out of results");
  assert.equal(doc.runs[0]!.results[0]!.level, "error");
  assert.equal(doc.runs[0]!.invocations[0]!.executionSuccessful, true);
});

test("engineForTool falls back to sast for unknown/agent tools", () => {
  assert.equal(engineForTool("loam-sca"), "sca");
  assert.equal(engineForTool("gitleaks"), "secrets");
  assert.equal(engineForTool("some-new-engine"), "sast");
  assert.equal(engineForTool(undefined), "sast");
});

test("coverage ledger records, round-trips and feeds compareFindings", () => {
  const l = new CoverageLedger();
  l.recordScan("http://127.0.0.1:8080", "httpx", { hitCount: 2 });
  l.recordScan("repo", "loam-sca", { hitCount: 1, notes: ["kev_unavailable"] });
  l.recordScan("repo", "checkov", { hitCount: 0, error: "engine missing" });
  assert.equal(l.get("repo", "loam-sca")!.status, "partial");
  assert.equal(l.get("repo", "checkov")!.status, "error");
  const restored = CoverageLedger.fromJson(l.toJson());
  assert.deepEqual(restored.entries().map((e) => [e.target, e.check, e.status]).sort(), l.entries().map((e) => [e.target, e.check, e.status]).sort());
  // coveredKeys integrates with compareFindings' coverage contract
  const covered = new Set(restored.coveredKeys());
  assert.ok(covered.has("repo\nloam-sca"));
  const cmp = compareFindings("b1", [], [{ ...toSecurityFindings([{ engine: "sca", ruleId: "GHSA-9", severity: "high", target: "pkg@1.0", title: "t", detail: "d" }])[0]!, verdict: "finding", id: "x" }], [...covered]);
  assert.deepEqual(cmp.new.length, 1);
});
