import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fastPath } from "../fastPath.js";
import { FINDINGS_SCHEMA } from "../findingsSchema.js";
import { validateSchema } from "../schema.js";
import type { ReconHit } from "../types.js";
import type { ScaRaw } from "../../native/sca/osvClient.js";

const scaHit = (raw: Partial<ScaRaw>, severity: ReconHit["severity"] = "medium"): ReconHit => ({
  tool: "loam-sca", ruleId: "GHSA-1", file: "package-lock.json", line: 1, cls: "known-vulnerability",
  severity, deterministic: true, message: "left-pad@1.3.0: bad (CVE-2024-1)", raw: { ecosystem: "npm", package: "left-pad", version: "1.3.0", ...raw },
});

test("fastPath promotes loam-sca hits to confirmed records carrying the enrichment", () => {
  const risk = {
    cve_id: "CVE-2024-1", scoring_version: "1.1", risk_score: 84.5, risk_label: "CRITICAL" as const,
    urgency: "PATCH WITHIN 24 HOURS", recommendation: "CVE-2024-1 is listed in the CISA KEV catalog; apply available patches within 24 hours.",
    components: { cvss_score: 8, epss_probability: 0.4, in_kev: true, poc_confidence: "NONE" as const, cvss_contribution: 16, epss_contribution: 14, kev_contribution: 30, poc_contribution: 0 },
    boosters_applied: [], days_since_published: 300,
  };
  const { records, hints } = fastPath([scaHit({ cves: ["CVE-2024-1"], risk, kev: { dateAdded: "2024-05-01", dueDate: "2024-05-22", ransomware: true }, epss: { epss: 0.4, percentile: 0.96 }, fixedIn: "1.3.1", upgradeTo: "1.3.1", baseSeverity: "high", cvss: { vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", score: 9.8 } }, "high")]);
  assert.equal(hints.length, 0, "loam-sca no longer degrades to hints");
  const r = records[0]!;
  assert.equal(r.verdict, "confirmed");
  if (r.verdict !== "confirmed") return;
  assert.ok(r.title.includes("risk 84.5 CRITICAL"), r.title);
  assert.equal(r.severity.overall_severity, "high");
  assert.equal(r.conditions[0]?.kind, "third_party_dependency");
  assert.ok(r.remediation.strategy.includes("1.3.1"), r.remediation.strategy);
  assert.equal(r.cvss?.score, 9.8);
  assert.equal(r.intel?.kev?.ransomware, true);
  assert.equal(r.intel?.risk?.risk_score, 84.5);
  assert.equal(r.intel?.epss?.epss, 0.4);
  assert.ok(r.evidence_vector.some((e) => e.ref === "kev:CVE-2024-1"));
  // The promoted record must satisfy the findings schema (incl. the new intel property).
  assert.deepEqual(validateSchema([r], FINDINGS_SCHEMA), []);
});

test("fastPath: bare loam-sca hit without enrichment still becomes a valid record", () => {
  const { records } = fastPath([scaHit({})]);
  const r = records[0]!;
  assert.equal(r.verdict, "confirmed");
  if (r.verdict !== "confirmed") return;
  assert.equal(r.intel, undefined);
  assert.equal(r.remediation.strategy, "Upgrade to a fixed version.");
  assert.deepEqual(validateSchema([r], FINDINGS_SCHEMA), []);
});

test("fastPath: an enriched loam-sca record shadows the overlapping external osv hit", () => {
  const osv: ReconHit = { ...scaHit({}), tool: "osv" };
  const loam = scaHit({ cves: ["CVE-2024-1"] });
  const { records } = fastPath([osv, loam]);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.fingerprint.includes("loam-sca"), true);
  // A different advisory id in the same file is kept.
  const other: ReconHit = { ...osv, ruleId: "GHSA-2" };
  const { records: two } = fastPath([osv, other, loam]);
  assert.equal(two.length, 2);
});

test("fastPath: non-deterministic and unknown tools still land in hints", () => {
  const opengrep: ReconHit = { ...scaHit({}), tool: "opengrep", deterministic: false };
  const trivy: ReconHit = { ...scaHit({}), tool: "trivy" };
  const { hints, records } = fastPath([opengrep, trivy]);
  assert.equal(records.length, 0);
  assert.equal(hints.length, 2);
});
