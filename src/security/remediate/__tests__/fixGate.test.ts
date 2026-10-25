import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFixGate, probeDocker, notRunTestRun, compareTestRuns } from "../build/fixGate.js";
import type { TestRun, TargetVerification } from "../types.js";

function verified(): TargetVerification {
  return { target: { value: "22.23.4", line: "22", packId: "node-2026-10-21", packSha256: "x" }, status: "verified", evidence: [] };
}

function stepRun(role: "baseline" | "after", failures: string[], deprecations: string[]): TestRun {
  return {
    role, imageRef: "node:22@sha256:abc", digest: "sha256:abc", status: failures.length ? "failed" : "ok",
    steps: [{ name: "test", status: failures.length ? "failed" : "ok", exitCode: failures.length ? 1 : 0, logRel: "t.log", logSha256: "h", durationMs: 10, deprecationLines: deprecations, failureLines: failures }],
  };
}

function proof(matches = true) {
  return { command: "node -v", observed: matches ? "v22.23.4" : "v22.21.0", matchesFixedRelease: matches, evidenceId: "EV0001" };
}

test("fix gate, no Docker: honest patched_unverified with the recorded blocker (E10 primary path)", () => {
  const gate = evaluateFixGate({
    verification: verified(), artifactProof: null, comparison: null, smoke: null,
    policy: { dockerAvailable: false, dockerBlocker: "docker server not reachable" },
  });
  assert.equal(gate.verdict, "patched_unverified");
  assert.match(gate.reason, /docker server not reachable/);
});

test("fix gate ordered rules: not_found -> blocked; regression before proof; proof before verified", () => {
  const nf = evaluateFixGate({ verification: { ...verified(), status: "not_found" }, artifactProof: null, comparison: null, smoke: null, policy: { dockerAvailable: true } });
  assert.equal(nf.verdict, "blocked");

  const reg = evaluateFixGate({
    verification: verified(), artifactProof: proof(), comparison: { baseline: stepRun("baseline", [], []), after: stepRun("after", ["planted regression"], []), newFailures: ["planted regression"], resolvedFailures: [], newDeprecations: [], resolvedDeprecations: [] },
    smoke: null, policy: { dockerAvailable: true },
  });
  assert.equal(reg.verdict, "regression");
  assert.match(reg.reason, /new failures: 1/);

  const ok = evaluateFixGate({ verification: verified(), artifactProof: proof(), comparison: { baseline: stepRun("baseline", [], []), after: stepRun("after", [], []), newFailures: [], resolvedFailures: [], newDeprecations: [], resolvedDeprecations: [] }, smoke: { status: "ok", reason: "" }, policy: { dockerAvailable: true } });
  assert.equal(ok.verdict, "verified_fixed");

  const wrongProof = evaluateFixGate({ verification: verified(), artifactProof: proof(false), comparison: { baseline: stepRun("baseline", [], []), after: stepRun("after", [], []), newFailures: [], resolvedFailures: [], newDeprecations: [], resolvedDeprecations: [] }, smoke: null, policy: { dockerAvailable: true } });
  assert.equal(wrongProof.verdict, "patched_unverified");
  assert.match(wrongProof.reason, /did not report a fixed release/);
});

test("compareTestRuns: pre-existing failures are not new; new deprecations count", () => {
  const baseline = stepRun("baseline", ["pre-existing flake"], ["old deprecation"]);
  const after = stepRun("after", ["pre-existing flake", "NEW break"], ["old deprecation", "NEW deprecation"]);
  const cmp = compareTestRuns(baseline, after);
  assert.deepEqual(cmp.newFailures, ["NEW break"]);
  assert.deepEqual(cmp.resolvedFailures, []);
  assert.deepEqual(cmp.newDeprecations, ["NEW deprecation"]);
  // A failure resolved by the upgrade is GOOD, not a regression.
  const fixed = compareTestRuns(stepRun("baseline", ["x"], []), stepRun("after", [], []));
  assert.deepEqual(fixed.newFailures, []);
  assert.deepEqual(fixed.resolvedFailures, ["x"]);
});

test("probeDocker returns the honest shape on this machine (no server expected)", () => {
  const probe = probeDocker();
  assert.equal(typeof probe.available, "boolean");
  if (!probe.available) assert.ok(probe.blocker && probe.blocker.length > 0);
});

test("notRunTestRun records the blocker in the test step's failure lines", () => {
  const run = notRunTestRun("baseline", "no docker on this PC");
  assert.equal(run.status, "not_run");
  assert.ok(run.steps.find((s) => s.name === "test")!.failureLines[0]!.includes("no docker on this PC"));
});
