import { strict as assert } from "node:assert";
import { test } from "node:test";
import { intelLine, renderDetail, renderReport, toSarif } from "../reports.js";
import type { FindingRecord, LedgerUnit } from "../types.js";

const base = {
  verdict: "confirmed" as const, fingerprint: "loam-sca:GHSA-1:package-lock.json:1", title: "Dependency with a known vulnerability (risk 84.5 CRITICAL)",
  description: "left-pad@1.3.0: RCE", root_cause: "left-pad@1.3.0: RCE", intended_behavior: "clean deps",
  trace: [{ kind: "sink" as const, file: "package-lock.json", line: 1, scope: "known-vulnerability", description: "loam-sca: GHSA-1" }],
  evidence: [{ file: "package-lock.json", line: 1, description: "loam-sca rule GHSA-1 reported here" }],
  conditions: [{ kind: "third_party_dependency" as const, description: "left-pad@1.3.0 (npm) is pinned in package-lock.json." }],
  execution: { attacker_perspective: "anyone", payloads: [], instructions: [], observed_result: "Deterministic OSV advisory match" },
  remediation: { strategy: "Upgrade left-pad@1.3.0 to 1.3.1 or later." },
  severity: {
    likelihood: { score: "high" as const, reason: "Actively exploited (CISA KEV)." },
    impact: { score: "medium" as const, reason: "Scanner severity for GHSA-1." },
    overall_severity: "medium" as const,
  },
  confidence: { score: "high" as const, reason: "Deterministic OSV advisory match on a pinned version." },
  evidence_vector: [{ source: "rule" as const, state: "confirmed" as const, ref: "loam-sca:GHSA-1" }],
  evidence_assurance: "source-only" as const,
};

const intelFinding: FindingRecord = {
  ...base,
  cvss: { vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", score: 9.8, severity: "critical" },
  intel: {
    cve: "CVE-2024-1111",
    risk: { risk_score: 84.5, risk_label: "CRITICAL", urgency: "PATCH WITHIN 24 HOURS", recommendation: "CVE-2024-1111 is listed in the CISA KEV catalog; apply available patches within 24 hours.", scoring_version: "1.1", boosters_applied: [] },
    kev: { dateAdded: "2024-06-02", dueDate: "2024-06-16", ransomware: true },
    epss: { epss: 0.4, percentile: 0.96 },
  },
};

const input = (findings: FindingRecord[]) => ({
  runId: "r--run-1", repo: "demo", profile: "standard", runStatus: "complete" as const,
  findings, units: [] as LedgerUnit[], scanners: [{ tool: "loam-sca", status: "ok", hitCount: 1, detail: "kev_unavailable: KEV catalog unreachable" }],
  promotions: { full: 1, reduced_win32: 0 }, hostPlatform: "win32", readAssurance: "full" as const, budget: { spent: 0, limit: null },
});

test("intelLine summarises the real-world signals of a finding", () => {
  assert.equal(intelLine(intelFinding), "composite risk 84.5 CRITICAL; CISA KEV (ransomware use); EPSS 40.0% — PATCH WITHIN 24 HOURS");
  assert.equal(intelLine({ ...base }), null);
});

test("toSarif applies the KEV/risk level policy and carries security-severity and intel", () => {
  const sarif = toSarif(input([intelFinding, { ...base, fingerprint: "loam-sca:GHSA-2:package-lock.json:1", title: "Dependency with a known vulnerability" }])) as { runs: { results: { ruleId: string; level: string; properties: Record<string, unknown> }[] }[] };
  const [withIntel, bare] = sarif.runs[0]!.results;
  assert.equal(withIntel!.level, "error", "KEV forces error even though overall_severity is medium");
  assert.equal(withIntel!.properties["security-severity"], "9.8");
  assert.deepEqual(withIntel!.properties.intel, (intelFinding as { intel?: unknown }).intel);
  assert.equal(bare!.level, "warning");
  assert.equal(bare!.properties["security-severity"], "5.5", "severity representative number when no CVSS vector");
});

test("REPORT and detail render the real-world risk and the advisory line", () => {
  const report = renderReport(input([intelFinding]));
  assert.ok(report.includes("Real-world risk"));
  assert.ok(report.includes("composite risk 84.5 CRITICAL; CISA KEV (ransomware use); EPSS 40.0%"));
  assert.ok(report.includes("kev_unavailable"), "degraded enrichment is surfaced, never swallowed");
  const detail = renderDetail(input([intelFinding]));
  assert.ok(detail.includes("- Real-world risk: composite risk 84.5 CRITICAL"));
  assert.ok(detail.includes("- Advisory: CVE-2024-1111 is listed in the CISA KEV catalog"));
  // No intel anywhere: the classic table shape stays.
  const plain = renderReport(input([{ ...base }]));
  assert.ok(!plain.includes("Real-world risk"));
});
