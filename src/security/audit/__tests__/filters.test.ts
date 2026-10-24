import { test } from "node:test";
import assert from "node:assert/strict";
import { hardExclusion, tierA } from "../fpFilter.js";
import type { Candidate } from "../fpFilter.js";
import { evidenceGate } from "../evidenceGate.js";
import { cvss31, severityOf } from "../cvss.js";
import { probeSandbox, runInSandbox } from "../sandbox.js";

function cand(over: Record<string, unknown>): Candidate {
  return {
    verdict: "needs_validation", fingerprint: "fp", title: "t", description: "d", claimed_root_cause: "r",
    trace: [], evidence: [], blockers: [], validation_plan: { local: "x" }, evidence_vector: [],
    evidence_assurance: "source-only", ...over,
  } as unknown as Candidate;
}

test("hard exclusions", () => {
  assert.ok(hardExclusion(cand({ title: "Denial of service via big body" })));
  assert.ok(hardExclusion(cand({ title: "Buffer overflow", primary_file: "a.ts" })));
  assert.equal(hardExclusion(cand({ title: "Buffer overflow", primary_file: "a.c" })), null);
  assert.ok(hardExclusion(cand({ title: "SSRF", primary_file: "page.html" })));
  assert.ok(hardExclusion(cand({ title: "Hardcoded API key in source" })));
  assert.equal(hardExclusion(cand({ title: "Hardcoded API key in source" }), false), null);
  assert.equal(hardExclusion(cand({ title: "SQL injection in search" })), null);
});

test("tierA applies the floor and keeps the top slice deterministically", () => {
  const confirmed = (fp: string, score: "low" | "medium" | "high") =>
    cand({ verdict: "confirmed", fingerprint: fp, title: "SQL injection", confidence: { score, reason: "" } });
  const r = tierA([confirmed("b", "high"), confirmed("a", "high"), confirmed("c", "low"), cand({ fingerprint: "n" })],
    { fpFloor: 0.7, keepTop: 2 });
  assert.deepEqual(r.kept.map((c) => c.fingerprint), ["a", "b"]);
  assert.equal(r.dropped.length, 2);
});

test("evidenceGate: only a refutation rejects", () => {
  const e = (state: "confirmed" | "refuted" | "unknown") => ({ source: "llm" as const, state, ref: "r" });
  assert.equal(evidenceGate([e("confirmed"), e("refuted")]), "reject");
  assert.equal(evidenceGate([e("unknown"), e("unknown")]), "needs_validation");
  assert.equal(evidenceGate([e("confirmed"), e("unknown")]), "needs_validation");
  assert.equal(evidenceGate([]), "needs_validation");
  assert.equal(evidenceGate([e("confirmed")]), "pass");
});

test("cvss31 matches published base scores", () => {
  assert.equal(cvss31("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")?.score, 9.8);
  assert.equal(cvss31("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H")?.score, 10);
  assert.equal(cvss31("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")?.score, 6.1);
  assert.equal(cvss31("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N")?.score, 0);
  assert.equal(cvss31("CVSS:3.0/AV:N"), null);
  assert.equal(cvss31("CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), null);
  assert.equal(severityOf(9.8), "critical");
  assert.equal(severityOf(0), "informational");
});

test("the sandbox never runs anything in this build", () => {
  assert.equal(probeSandbox().available, false);
  const r = runInSandbox("id");
  assert.equal(r.available, false);
  assert.ok(r.blocker.length > 0);
});
