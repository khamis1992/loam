/**
 * check:normalize — W0 smoke gate. Proves the single funnel end-to-end from all three
 * existing channels (audit records, pentest findings, raw engine findings) into one
 * SARIF document, and the coverage-ledger round-trip. PASS/FAIL, exit 1 on failure.
 */
process.env.MANUS_LOCAL_DATA_DIR ??= `${process.env.TEMP ?? "/tmp"}/loam-check-normalize-${process.pid}`;

const pass = (m: string): void => console.log(`PASS  ${m}`);
const fail = (m: string, e: unknown): void => { console.log(`FAIL  ${m}: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; };

const { auditNormalizer } = await import("../security/normalize/adapters/audit.js");
const { pentestNormalizer } = await import("../security/normalize/adapters/pentest.js");
const { toSarif, toSecurityFindings } = await import("../security/normalize/funnel.js");
const { CoverageLedger } = await import("../security/coverage/ledger.js");

try {
  const auditRecords = [
    { verdict: "confirmed", fingerprint: "loam-sca:GHSA-1:package-lock.json:1", title: "Dependency vulnerability", description: "d", root_cause: "r", intended_behavior: "i",
      trace: [{ kind: "sink", file: "package-lock.json", line: 1, scope: "s", description: "d" }], evidence: [{ file: "package-lock.json", line: 1, description: "d" }],
      conditions: [], execution: { attacker_perspective: "a", payloads: [], instructions: [], observed_result: "o" }, remediation: { strategy: "upgrade" },
      severity: { likelihood: { score: "high", reason: "r" }, impact: { score: "critical", reason: "r" }, overall_severity: "critical" },
      confidence: { score: "high", reason: "r" }, evidence_vector: [{ source: "rule", state: "confirmed", ref: "loam-sca:GHSA-1" }], evidence_assurance: "source-only" },
    { verdict: "rejected", fingerprint: "x:R:z:1", title: "nope", description: "d", claimed_root_cause: "c",
      trace: [{ kind: "sink", file: "z.ts", line: 1, scope: "s", description: "d" }], evidence: [{ file: "z.ts", line: 1, description: "d" }], reason: "r", evidence_assurance: "source-only" },
  ];
  const pentestFindings = [
    { id: "EV1", check: "security_headers", verdict: "finding", severity: "medium", title: "Missing CSP", target: "http://127.0.0.1:8080", detail: "d" },
    { id: "EV2", check: "csrf", verdict: "error", severity: "info", title: "check failed", target: "t", detail: "timeout" },
  ];
  const engineRaw: import("../security/normalize/types.js").RawFinding[] = [{ engine: "secrets", ruleId: "aws-key", severity: "critical", target: ".env:3", title: "AWS key", detail: "leaked" }];

  const raws = [...auditNormalizer.adapt(auditRecords), ...pentestNormalizer.adapt(pentestFindings), ...engineRaw];
  if (raws.length !== 4) throw new Error(`expected 4 unified findings, got ${raws.length}`);
  const doc = toSarif(raws) as { runs: { results: { ruleId: string }[]; invocations: { executionSuccessful: boolean }[] }[] };
  const rules = doc.runs[0]!.results.map((r) => r.ruleId);
  for (const expected of ["sca:loam-sca:GHSA-1:package-lock.json:1", "recon:security_headers", "secrets:aws-key"]) {
    if (!rules.includes(expected)) throw new Error(`SARIF missing rule ${expected} (got ${rules.join(", ")})`);
  }
  if (doc.runs[0]!.invocations[0]!.executionSuccessful !== true) throw new Error("invocation must be successful");
  if (doc.runs[0]!.results.length !== 3) throw new Error(`expected 3 results (info/error excluded), got ${doc.runs[0]!.results.length}`);
  pass("funnel: 3 channels -> one SARIF (audit + pentest + engine raw)");

  const stable = toSecurityFindings(engineRaw)[0]!.fingerprint;
  if (toSecurityFindings(engineRaw)[0]!.fingerprint !== stable) throw new Error("fingerprint not deterministic");
  pass("fingerprints deterministic");

  const ledger = new CoverageLedger();
  ledger.recordScan("repo", "loam-secrets", { hitCount: 1 });
  ledger.recordScan("repo", "loam-sca", { hitCount: 2, notes: ["kev_unavailable"] });
  const restored = CoverageLedger.fromJson(ledger.toJson());
  if (restored.entries().length !== 2) throw new Error("ledger round-trip lost entries");
  if (restored.get("repo", "loam-sca")!.status !== "partial") throw new Error("partial status not preserved");
  if (!restored.coveredKeys().includes("repo\nloam-sca")) throw new Error("coveredKeys broken");
  pass("coverage ledger round-trip + coveredKeys");
  console.log("all checks passed");
} catch (e) {
  fail("normalize funnel", e);
}
