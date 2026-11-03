import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULTS, FINDING_EXIT, exitMeaning, jazzerPlan } from "../fuzz/plan.js";
import { parseCrashArtifacts, parseJazzerStderr, toHits, triageJazzerRun, triage } from "../fuzz/triage.js";
import { discoverFuzzTargets, runJazzerScan } from "../fuzz/run.js";
import { runScanners } from "../../audit/scanners.js";
import type { Exec } from "../../audit/scanners.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "loam-fuzz-"));
const OPEN_PROBE = { sandboxProbe: () => ({ available: true, blocker: "" }) };
const execOk: Exec = async () => ({ code: FINDING_EXIT, stdout: "Test unit written to corpus/crash-" + "f".repeat(40), stderr: "", timedOut: false });

test("jazzerPlan builds a bounded argv with resource caps", () => {
  const p = jazzerPlan({ entry: "fuzz/target.ts", corpusDir: "corpus" });
  assert.deepEqual(p.argv, [
    "--no-install", "jazzer", "fuzz/target.ts", "corpus",
    "--", "-timeout=10", `-runs=${DEFAULTS.runs}`, `-rss_limit_mb=${DEFAULTS.rssLimitMb}`, `-max_len=${DEFAULTS.maxLen}`,
  ]);
  assert.deepEqual(p.okCodes, [0, FINDING_EXIT]);
  const tight = jazzerPlan({ entry: "e", corpusDir: "c", runs: 10, rssLimitMb: 512, timeoutMs: 1000, maxLen: 64, sync: true, regression: true, artifactDir: "art" });
  assert.ok(tight.argv.includes("--sync"));
  assert.ok(tight.argv.includes("--mode"));
  assert.ok(tight.argv.includes("-timeout=1"));
  assert.ok(tight.argv.includes("-runs=10"));
  assert.ok(tight.argv.includes("-rss_limit_mb=512"));
  assert.ok(tight.argv.includes("-max_len=64"));
  assert.ok(tight.argv.includes("-artifact_prefix=art/"));
});

test("exit codes map to meanings", () => {
  assert.equal(exitMeaning(0), "clean run");
  assert.equal(exitMeaning(77), "fuzzing found a crash or a bug-detector hit");
  assert.equal(exitMeaning(78), "unexpected fuzzing error (not a target finding)");
  assert.equal(exitMeaning(127), null);
});

const STDERR = [
  "==4242== Error: Command Injection",
  "    in exec(): called with 'jaz_zer'",
  "    at Object.<anonymous> (fuzz/target.ts:10:11)",
  "==4242== Uncaught Exception: Error: boom",
  "    at run (fuzz/target.ts:3:1)",
].join("\n");

test("parseJazzerStderr maps detector titles and uncaught exceptions", () => {
  const f = parseJazzerStderr(STDERR);
  assert.equal(f.length, 2);
  assert.equal(f[0]!.kind, "command-injection");
  assert.ok(f[0]!.detail.includes("exec()"));
  assert.equal(f[1]!.kind, "crash");
});

test("harness artifacts are dropped in triage", () => {
  const f = parseJazzerStderr(STDERR + "\n==4242== Error: assertion in the harness\n    at driver");
  const t = triage(f);
  assert.equal(t.kept.length, 2);
  assert.deepEqual(t.dropped, [{ title: "Error: assertion in the harness", reason: "fuzz-harness artifact" }]);
});

test("crash artifact hashes are parsed from libFuzzer stdout", () => {
  const h = "abcd0123" + "e".repeat(32);
  assert.deepEqual(parseCrashArtifacts(`artifact_prefix='corpus/'; Test unit written to corpus/crash-${h}`), [h]);
  assert.deepEqual(parseCrashArtifacts("no artifacts here"), []);
});

test("toHits maps kinds to audit classes and severities", () => {
  const [hit] = toHits([{ kind: "remote-code-execution", title: "Remote Code Execution", detail: "", raw: "" }], { entry: "fuzz/target.ts" });
  assert.equal(hit!.tool, "jazzer");
  assert.equal(hit!.ruleId, "jazzer/remote-code-execution");
  assert.equal(hit!.cls, "injection");
  assert.equal(hit!.severity, "critical");
  assert.equal(hit!.deterministic, true);
});

test("triageJazzerRun end to end", () => {
  const h = "f".repeat(40);
  const r = triageJazzerRun({ entry: "fuzz/target.ts", stdout: `Test unit written to corpus/crash-${h}`, stderr: STDERR });
  assert.equal(r.hits.length, 2);
  assert.equal(r.crashHashes[0], h);
  assert.deepEqual(r.hits.map((x) => x.ruleId).sort(), ["jazzer/command-injection", "jazzer/crash"]);
});

test("discoverFuzzTargets finds *.fuzz.ts and skips vendored trees", () => {
  const d = tmp();
  try {
    fs.mkdirSync(path.join(d, "src", "deep"), { recursive: true });
    fs.mkdirSync(path.join(d, "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(d, "src", "deep", "api.fuzz.ts"), "export function fuzz() {}\n");
    fs.writeFileSync(path.join(d, "node_modules", "x", "evil.fuzz.ts"), "export function fuzz() {}\n");
    fs.writeFileSync(path.join(d, "fuzz.ts"), "export function fuzz() {}\n");
    assert.deepEqual(discoverFuzzTargets(d).map((p) => path.relative(d, p)), ["fuzz.ts", path.join("src", "deep", "api.fuzz.ts")]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("runJazzerScan stays skipped while the dynamic sandbox is off ([U2])", async () => {
  const d = tmp();
  const scratch = tmp();
  try {
    fs.writeFileSync(path.join(d, "a.fuzz.ts"), "export function fuzz() {}\n");
    const r = await runJazzerScan({ target: d, scratch, exec: execOk });
    assert.equal(r.reports[0]!.status, "skipped");
    assert.ok(r.reports[0]!.detail!.includes("dynamic confirmation is disabled"));
    assert.equal(r.hits.length, 0);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("runJazzerScan executes and triages when the probe is opened", async () => {
  const d = tmp();
  const scratch = tmp();
  try {
    fs.writeFileSync(path.join(d, "a.fuzz.ts"), "export function fuzz() {}\n");
    const exec: Exec = async () => ({
      code: FINDING_EXIT,
      stdout: `Test unit written to corpus/crash-${"a".repeat(40)}`,
      stderr: STDERR,
      timedOut: false,
    });
    const r = await runJazzerScan({ target: d, scratch, exec, ...OPEN_PROBE });
    assert.equal(r.reports[0]!.status, "ok");
    assert.equal(r.reports[0]!.hitCount, 2);
    assert.ok(r.hits.every((h) => h.tool === "jazzer"));
    assert.ok(r.sarif && (r.sarif.doc as { runs: unknown[] }).runs.length === 1);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("runJazzerScan reports unavailable when jazzer cannot start", async () => {
  const d = tmp();
  const scratch = tmp();
  try {
    fs.writeFileSync(path.join(d, "a.fuzz.ts"), "export function fuzz() {}\n");
    const r = await runJazzerScan({ target: d, scratch, exec: async () => ({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" }), ...OPEN_PROBE });
    assert.equal(r.reports[0]!.status, "unavailable");
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("runJazzerScan skips cleanly with no fuzz targets", async () => {
  const d = tmp();
  const scratch = tmp();
  try {
    const r = await runJazzerScan({ target: d, scratch, exec: execOk, ...OPEN_PROBE });
    assert.equal(r.reports[0]!.status, "skipped");
    assert.ok(r.reports[0]!.detail!.includes("no fuzz targets"));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("runScanners keeps jazzer behind the dynamic gate by default", async () => {
  const d = tmp();
  const scratch = tmp();
  try {
    fs.writeFileSync(path.join(d, "a.fuzz.ts"), "export function fuzz() {}\n");
    const out = await runScanners({ target: d, scratch, tools: ["jazzer"], exec: execOk });
    assert.equal(out.reports[0]!.tool, "jazzer");
    assert.equal(out.reports[0]!.status, "skipped");
    assert.ok(out.reports[0]!.detail!.includes("dynamic confirmation is disabled"));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("runScanners opens the jazzer gate when dynamic mode is on", async () => {
  const d = tmp();
  const scratch = tmp();
  try {
    fs.writeFileSync(path.join(d, "a.fuzz.ts"), "export function fuzz() {}\n");
    const exec: Exec = async () => ({ code: FINDING_EXIT, stdout: `Test unit written to corpus/crash-${"b".repeat(40)}`, stderr: STDERR, timedOut: false });
    const out = await runScanners({ target: d, scratch, tools: ["jazzer"], exec, dynamic: true });
    assert.equal(out.reports[0]!.status, "ok");
    assert.equal(out.reports[0]!.hitCount, 2);
    assert.ok(out.hits.every((h) => h.tool === "jazzer"));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("fastPath turns a jazzer crash into a confirmed record with proof", async () => {
  const { fastPath } = await import("../../audit/fastPath.js");
  const mk = (raw: Record<string, unknown>) => ({
    tool: "jazzer" as const, ruleId: "jazzer/command-injection", message: "Command Injection in exec() 'jaz_zer'",
    file: "fuzz/api.fuzz.ts", line: 1, cls: "injection", severity: "high" as const, deterministic: true, raw,
  });
  const crash = fastPath([mk({ crashHash: "a".repeat(40), artifactSha256: "deadbeef", artifactRel: "jazzer/crash-aaaa" })]);
  assert.equal(crash.hints.length, 0);
  const rec = crash.records[0]!;
  assert.equal(rec.verdict, "confirmed");
  assert.equal(rec.proof?.kind, "crash");
  assert.equal(rec.proof?.sha256, "deadbeef");
  const bare = fastPath([mk({})]);
  assert.equal(bare.records[0]!.verdict, "needs_validation");
});
