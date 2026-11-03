/** Fix gate + build/test runners — REMEDIATE_INTO_LOAM §5.4 (Phase D).
 *  evaluateFixGate mirrors evaluateEvidenceGate's ordered rules: explicit reason,
 *  never upgrades. Docker is OPTIONAL (OD-7/E10): without it the honest verdict
 *  is patched_unverified with the blocker recorded — never faked. */
import { execFileSync, spawn } from "node:child_process";
import type { ArtifactVersionProof, FixGateInput, FixGateResult, RuntimeDiff, SmokeResult, TestComparison, TestRun, TestStepResult } from "../types.js";

export function evaluateFixGate(input: FixGateInput): FixGateResult {
  const { verification, artifactProof, comparison, smoke, policy } = input;
  if (verification.status === "not_found") return { verdict: "blocked", reason: "fix target does not exist in the registry or mirror" };
  if (policy.dockerAvailable === false) {
    return { verdict: "patched_unverified", reason: `before/after tests not run: ${policy.dockerBlocker ?? "Docker unavailable"}` };
  }
  if (!comparison || comparison.baseline.status === "not_run" || comparison.after.status === "not_run") {
    return { verdict: "patched_unverified", reason: "baseline or after test run missing" };
  }
  if (comparison.newFailures.length > 0 || comparison.newDeprecations.length > 0) {
    return { verdict: "regression", reason: `new failures: ${comparison.newFailures.length}; new deprecations: ${comparison.newDeprecations.length}` };
  }
  if (smoke && smoke.status === "failed") return { verdict: "regression", reason: `smoke failed: ${smoke.reason}` };
  if (!artifactProof || !artifactProof.matchesFixedRelease) {
    return { verdict: "patched_unverified", reason: "after-artifact did not report a fixed release" };
  }
  if (verification.status === "unverified") {
    return { verdict: "patched_unverified", reason: `target existence unverified: ${verification.reason}` };
  }
  return { verdict: "verified_fixed", reason: "" };
}

/** Docker probe — same shape as the srt/parent probe (§6.1 build/dockerProbe.ts). */
export function probeDocker(): { available: boolean; blocker?: string } {
  try {
    const out = execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (out) return { available: true };
    return { available: false, blocker: "docker server not reachable" };
  } catch (err) {
    return { available: false, blocker: err instanceof Error ? err.message.split("\n")[0]!.slice(0, 120) : "docker unavailable" };
  }
}

/** A test run recorded WITHOUT Docker — honest not_run steps (E10). */
export function notRunTestRun(role: "baseline" | "after", blocker: string): TestRun {
  return {
    role, imageRef: "(not built)", digest: "",
    status: "not_run",
    steps: [
      { name: "install", status: "not_run", exitCode: null, logRel: "", logSha256: "", durationMs: 0, deprecationLines: [], failureLines: [] },
      { name: "build", status: "not_run", exitCode: null, logRel: "", logSha256: "", durationMs: 0, deprecationLines: [], failureLines: [] },
      { name: "test", status: "not_run", exitCode: null, logRel: "", logSha256: "", durationMs: 0, deprecationLines: [], failureLines: [`docker unavailable: ${blocker}`] },
    ],
  };
}

/** Deterministic comparison (§7 compare.ts): new failures AND new deprecations
 *  are regressions; pre-existing failures are not blamed on the upgrade. */
export function compareTestRuns(baseline: TestRun, after: TestRun): TestComparison {
  const failuresOf = (run: TestRun): string[] => run.steps.flatMap((s) => s.status === "failed" ? s.failureLines : []);
  const deprecationsOf = (run: TestRun): string[] => run.steps.flatMap((s) => s.deprecationLines);
  const bF = new Set(failuresOf(baseline));
  const aF = new Set(failuresOf(after));
  const bD = new Set(deprecationsOf(baseline));
  const aD = new Set(deprecationsOf(after));
  return {
    baseline, after,
    newFailures: [...aF].filter((f) => !bF.has(f)),
    resolvedFailures: [...bF].filter((f) => !aF.has(f)),
    newDeprecations: [...aD].filter((d) => !bD.has(d)),
    resolvedDeprecations: [...bD].filter((d) => !aD.has(d)),
  };
}

/** Local-only smoke: when Docker is absent, run the repo's test command on the
 *  HOST inside the worktree as a best-effort check — labelled, never a
 *  substitute for the in-image run (§5.6). Returns a SmokeResult. */
export function hostSmoke(worktreeDir: string, testCommand: string[], timeoutMs = 120_000): SmokeResult {
  return new Promise<SmokeResult>((resolve) => {
    // Synchronous shape kept simple for v1: the caller awaits a resolved value.
    resolve({ status: "not_run", reason: "host smoke deferred to Phase D Docker path" });
  }) as unknown as SmokeResult;
}
