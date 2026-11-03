/**
 * check:fuzz — fuzz/AIxCC pipeline gate, offline: a real *.fuzz.ts target is
 * discovered; the campaign runs through a fake exec that simulates Jazzer's
 * FINDING_EXIT + crash artifacts, triage keeps the real crash and drops oom;
 * the patch proposal stays PROPOSAL-ONLY. The real fuzzer is exercised in the
 * sandboxed lanes; this gate proves the wiring without it.
 */
process.env.MANUS_LOCAL_DATA_DIR ??= `${process.env.TEMP ?? "/tmp"}/loam-check-fuzz-${process.pid}`;

const pass = (m: string): void => console.log(`PASS  ${m}`);
const fail = (m: string, e: unknown): void => { console.log(`FAIL  ${m}: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; };

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const { jazzerPlan, DEFAULTS, FINDING_EXIT } = await import("../security/native/fuzz/plan.js");
const { discoverFuzzTargets, runJazzerScan } = await import("../security/native/fuzz/run.js");
const { parseJazzerStderr, triage } = await import("../security/native/fuzz/triage.js");
const { draftGuardProposal } = await import("../tools/fuzzTools.js");
try {
  const plan = jazzerPlan({ entry: "src/a.fuzz.ts", corpusDir: "corpus", runs: 100 });
  if (!plan.argv.includes("-runs=100")) throw new Error("runs flag missing");
  if (!plan.okCodes.includes(FINDING_EXIT)) throw new Error("finding exit must be an ok code");
  if (DEFAULTS.runs !== 5_000) throw new Error("bounded default expected");
  pass("planner: bounded argv + finding exit accepted");
} catch (e) { fail("planner", e); }

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "loam-fuzz-fixture-"));
try {
  try {
    fs.mkdirSync(path.join(ws, "src"));
    fs.writeFileSync(path.join(ws, "src", "a.fuzz.ts"), "export function fuzz(data: Buffer): void { if (data.length === 3) throw new Error('boom'); }\n");
    const found = discoverFuzzTargets(ws);
    if (found.length !== 1 || !found[0]!.endsWith("a.fuzz.ts")) throw new Error(`discovery: ${found.join(",")}`);
    pass("target discovery finds the .fuzz.ts target");
  } catch (e) { fail("discovery", e); }

  try {
    const crash = "==7==Uncaught Exception: TypeError: x is not a function\n    at parse (src/app/parse.ts:10:5)";
    const real = triage(parseJazzerStderr(crash));
    if (real.kept.length !== 1 || real.kept[0]!.kind !== "crash") throw new Error("project crash must be kept");
    const oom = triage(parseJazzerStderr("==9==ERROR: libFuzzer: out-of-memory (malloc(2MB))\n#0 0x55 in fuzz src/a.fuzz.ts:2:53"));
    if (oom.kept.length !== 0) throw new Error("oom must be dropped by the taxonomy");
    const harness = triage(parseJazzerStderr("==9==ERROR: libFuzzer: deadly signal\n#0 0x55 in fuzz src/a.fuzz.ts:2:53"));
    if (harness.kept.length !== 0 || harness.dropped[0]?.reason !== "fuzz-harness artifact") throw new Error("harness-frame crash must drop");
    pass("triage taxonomy: project crash kept; oom + harness frames dropped");
  } catch (e) { fail("triage", e); }

  try {
    const exec = async (_exe: string, argv: string[]) => {
      void argv;
      return { code: FINDING_EXIT, stdout: "artifact_prefix='jazzer-artifacts/'; crash-0123456789abcdef\n", stderr: "==7==Uncaught Exception: TypeError: x is not a function\n    at parse (src/app/parse.ts:10:5)\n", timedOut: false, spawnError: undefined };
    };
    const outcome = await runJazzerScan({ target: ws, scratch: path.join(ws, ".scratch"), exec, sandboxProbe: () => ({ available: true, blocker: "" }), dynamic: false } as never);
    if (outcome.hits.length < 1) throw new Error(`expected a finding hit, got ${JSON.stringify(outcome.reports)}`);
    pass("campaign wiring: simulated jazzer run produces a funnel hit");
  } catch (e) { fail("campaign", e); }

  try {
    const p = draftGuardProposal("jazzer:crash-x", "src/a.fuzz.ts", 2, "  if (data.length === 3) throw new Error('boom');");
    if (!p.candidateDiff.includes("PROPOSAL") && !p.candidateDiff.includes("loam:fuzz-guard (proposal)")) throw new Error("draft must be labelled a proposal");
    if (p.regressionPass !== false) throw new Error("unvalidated by construction");
    pass("patch proposal: labelled draft, unvalidated until re-run");
  } catch (e) { fail("proposal", e); }

  if (!process.exitCode) console.log("all checks passed");
} finally {
  try { fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}
