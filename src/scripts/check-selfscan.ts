/**
 * check:selfscan — the Loam self-scan (ALL_SERVICES §22): run the first-party
 * deterministic scanners over this repository and compare the finding counts to
 * the recorded baseline (docs/bench/selfscan-baseline.json). A regression beyond
 * the noise allowance fails the gate (§23-10 engine-upgrade rule, applied to our
 * own rules). Also regenerates the baseline with --write.
 * Secrets are counted by rule only — values never leave the scanner.
 */
process.env.MANUS_LOCAL_DATA_DIR ??= `${process.env.TEMP ?? "/tmp"}/loam-check-selfscan-${process.pid}`;

const pass = (m: string): void => console.log(`PASS  ${m}`);
const fail = (m: string, e?: unknown): void => { console.log(`FAIL  ${m}: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; };

const fs = await import("node:fs");
const path = await import("node:path");
const url = await import("node:url");
const { runSecretsScan } = await import("../security/native/secrets/index.js");
const { taintScan } = await import("../security/sast/scan.js");
const { roastDockerfile } = await import("../security/config/dockerfile.js");
const { score } = await import("../security/bench/score.js");

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");
const BASELINE = path.join(ROOT, "docs", "bench", "selfscan-baseline.json");
const NOISE = 2; // absolute allowance per counter (self-scan output has small nondeterminism across tree state)

interface SelfscanCount { secrets: number; taint: number; dockerfile: number; sarifNeither: number }

try {
  // Runtime-artifact directories are excluded from the self-scan so the
  // 20k-file walk budget is spent on shipped source, not on local data:
  // data/ (task workspaces + remediation worktrees that are full repo COPIES —
  // before this exclusion they consumed the whole budget and the scan went
  // BLIND before reaching src/), workspace/ (task runtime), output/ (QA
  // screenshots), release/ (built installers). Recorded as part of the
  // check:selfscan hardening; see docs/security-development-gates.md.
  const SELFSCAN_SKIP = new Set(["data", "workspace", "output", "release"]);
  const secrets = runSecretsScan(ROOT, { skipTopDirs: SELFSCAN_SKIP }).hits.length;
  const taint = taintScan(ROOT).findings.length;
  let docker = 0;
  for (const df of ["Dockerfile"]) {
    try { docker += roastDockerfile(fs.readFileSync(path.join(ROOT, df), "utf8"), df).length; } catch { /* absent */ }
  }
  const current: SelfscanCount = { secrets, taint, dockerfile: docker, sarifNeither: 0 };

  if (process.argv.includes("--write")) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify({ recordedAt: new Date().toISOString(), counts: current }, null, 2) + "\n");
    pass(`baseline written: ${JSON.stringify(current)}`);
  } else {
    const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as { counts: SelfscanCount };
    let drifted = false;
    for (const key of Object.keys(current) as Array<keyof SelfscanCount>) {
      const delta = current[key] - Number(baseline.counts[key]);
      if (Math.abs(delta) > NOISE) { drifted = true; fail(`selfscan ${key}: ${current[key]} vs baseline ${String(baseline.counts[key])} (±${NOISE} allowed)`); }
    }
    if (!drifted) pass(`selfscan counts within baseline ±${NOISE}: ${JSON.stringify(current)}`);
  }

  // The scorer is exercised on the selfscan corpus shape so §20 stays wired here.
  const rows = [
    { id: "self:taint", expected: "vulnerable" as const, actual: (current.taint > 0 ? "finding" : "clean") as "finding" | "clean", cwe: "taint" },
    { id: "self:secrets", expected: "vulnerable" as const, actual: (current.secrets > 0 ? "finding" : "clean") as "finding" | "clean" },
    { id: "self:dockerfile", expected: "vulnerable" as const, actual: (current.dockerfile > 0 ? "finding" : "clean") as "finding" | "clean" },
  ];
  const s = score("selfscan", rows);
  if (typeof s.recall !== "number" || s.cases !== 3) throw new Error("scorer wiring broken");
  pass(`scorer wired on the selfscan corpus (recall=${s.recall})`);

  if (!process.exitCode) console.log("all checks passed");
} catch (e) {
  fail("selfscan", e);
}
