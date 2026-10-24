/**
 * Red report bundle tests (RED_TEAM_BUILD_SPEC §6.13): SARIF + Markdown +
 * per-finding PoC artifacts + retest diff + opt-in hardening tasks (O-5).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Evidence } from "../../orchestrator.js";
import type { RedCampaignResult } from "../orchestrator/redOrchestrator.js";
import { buildRedReport, retestRed } from "../report.js";
import { enrichFinding } from "../../findings.js";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-report-"));

const evidence: Evidence[] = [
  { id: "EV0001", kind: "poc", at: "2026-10-24T00:00:00Z", poc: "GET /.env", observed: "HTTP 200 returned SECRET=1" },
  { id: "EV0002", kind: "poc", at: "2026-10-24T00:00:01Z", poc: "GET /admin", observed: "HTTP 200 admin panel" },
];

const campaign = (findingChecks: string[], coverage: string[] = []): RedCampaignResult => {
  const findings = findingChecks.map((check, i) =>
    enrichFinding(
      { id: `F${i}`, check, verdict: "finding", severity: "high", title: `Finding ${check}`, target: "http://127.0.0.1:3000/", detail: "d" },
      [`EV000${i + 1}`],
    ),
  );
  return {
    campaignId: "RED-test-1",
    authzId: null,
    findings,
    unverified: [{ id: "HYP1", check: "red_x", target: "http://127.0.0.1:3000/", title: "Claim", detail: "d", reason: "no valid evidence attached", evidence: [] }],
    evidence,
    requestEvidence: [],
    audit: [],
    ptt: { id: "PTT0001", goal: "g", status: "doing", children: [], evidenceIds: [] },
    coverage,
    stats: { startedAt: "2026-10-24T00:00:00Z", finishedAt: "2026-10-24T00:01:00Z", requestsSent: 3, targetsProcessed: 1, killed: false, aborted: null },
  };
};

describe("buildRedReport", () => {
  it("writes SARIF, Markdown and a reproducible PoC artifact per finding", () => {
    const out = tempDir();
    const result = campaign(["red_sqli", "red_ssrf_module"]);
    const report = buildRedReport(result, out);
    assert.ok(fs.existsSync(report.sarifPath));
    assert.ok(fs.existsSync(report.markdownPath));
    assert.equal(report.poc.length, 2);
    for (const p of report.poc) {
      assert.ok(fs.existsSync(p.artifactPath));
      const artifact = JSON.parse(fs.readFileSync(p.artifactPath, "utf8")) as { evidence: { id: string; poc?: string }[] };
      assert.ok(artifact.evidence.length >= 1);
      assert.ok(artifact.evidence.some((e) => e.poc), "artifact carries the PoC steps");
    }
    const sarifDoc = JSON.parse(fs.readFileSync(report.sarifPath, "utf8")) as { runs: { results: unknown[] }[] };
    assert.equal(sarifDoc.runs[0]!.results.length, 2);
    const md = fs.readFileSync(report.markdownPath, "utf8");
    assert.ok(md.includes("# Red-team report"));
    assert.ok(md.includes("red_sqli"));
    assert.ok(md.includes("Unverified claims"));
    // No hardening tasks by default (O-5 off).
    assert.ok(!fs.existsSync(path.join(out, "hardening-tasks.json")));
  });

  it("hardening tasks are opt-in", () => {
    const out = tempDir();
    buildRedReport(campaign(["red_sqli"]), out, { openHardeningTasks: true });
    const tasks = JSON.parse(fs.readFileSync(path.join(out, "hardening-tasks.json"), "utf8")) as unknown[];
    assert.equal(tasks.length, 1);
  });
});

describe("retestRed", () => {
  it("classifies new/persistent/not-observed/unverified via the existing diff", () => {
    const baseline = campaign(["red_sqli"], ["http://127.0.0.1:3000/\nred_sqli", "http://127.0.0.1:3000/\nred_ssrf_module"]);
    const current = campaign(["red_sqli", "red_ssrf_module"], ["http://127.0.0.1:3000/\nred_sqli", "http://127.0.0.1:3000/\nred_ssrf_module"]);
    const diff = retestRed("baseline-1", baseline, current);
    assert.ok(diff.new.length >= 1); // red_ssrf_module is new
    assert.ok(diff.persistent.includes(baseline.findings[0]!.fingerprint));
    assert.deepEqual(diff.notObserved, []);
  });
});
