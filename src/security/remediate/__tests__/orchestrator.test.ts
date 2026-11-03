/** Orchestrator E2E — REMEDIATE_INTO_LOAM §7.3 state machine over a real fixture
 *  repo. Locks the DoD spine: D-2 (stop at GATE 1 with zero branches), edits only
 *  inside a run-store worktree (user tree never touched), honest no-Docker verdict
 *  patched_unverified, hash-bound GATE 2, [unverified] commit title + attribution,
 *  owner-scoped GATE 3, re-scan closure fixed_pending_deploy, discard/cancel. */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FIXTURES, materialize } from "./fixtures.js";
import {
  setRemediationDataDir, startRemediation, workApprovedRepos,
  commitApproved, recordPr, discardRepo, cancelRemediation,
} from "../index.js";
import { approveScope, approveCommit, approvePr } from "../gate/index.js";
import { canonicalSha256 } from "../types.js";
import { planPaths } from "../store.js";
import { DATA_DIR } from "../../../config.js";

const fixture = FIXTURES.find((f) => f.name === "node-vuln-app")!;
let dataDir = "";
let repo = "";
const git = (args: string[], cwd = repo) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const planHashOf = (run: any) =>
  canonicalSha256({
    rows: run.inventory.map((r: any) => ({ id: r.id, repoId: r.hit.repoId, file: r.hit.file, line: r.hit.line, signal: r.hit.signal, current: r.hit.currentVersion, status: r.status, target: r.proposedTarget, upgradeClass: r.upgradeClass })).sort((a: any, b: any) => a.id.localeCompare(b.id)),
  });

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-orch-"));
  setRemediationDataDir(dataDir);
  repo = materialize(fixture, dataDir);
});

afterEach(() => {
  setRemediationDataDir(DATA_DIR);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("full lifecycle: gate stops, worktree edits, honest verdict, commit, PR, closure", async () => {
  // D-2: inventory stops at GATE 1 — no branch exists yet, user tree untouched.
  const run = await startRemediation({ repos: [repo] }, "test-model");
  assert.equal(run.state, "awaiting_scope_approval");
  assert.equal(run.inventory.length, fixture.expect.length);
  assert.equal(git(["branch", "--list", "loam/remediate/*"]).trim(), "");
  assert.equal(git(["status", "--porcelain"]).trim(), "");
  assert.equal(run.repoDirs?.[run.repos[0]!], repo);

  // GATE 1 rejects a stale plan hash (409 plan_hash_mismatch).
  assert.throws(() => approveScope(run, { planHash: "stale", repos: run.repos, rows: [] }, dataDir), /plan_hash_mismatch/);

  // GATE 1 correct → work: resolve → edit in run-store worktree → fix gate.
  const hash = planHashOf(run);
  approveScope(run, { planHash: hash, repos: run.repos, rows: run.inventory.map((r: any) => r.id) }, dataDir);
  const worked = await workApprovedRepos(run.id);
  assert.equal(worked.state, "awaiting_commit_approval");
  const plan = worked.plans[0]!;
  assert.equal(plan.phase, "awaiting_commit");
  assert.equal(plan.fixGate?.verdict, "patched_unverified"); // no Docker on this path — honest verdict (OD-7/E10)
  for (const rel of ["Dockerfile", ".nvmrc", ".github/workflows/ci.yml"]) {
    const content = fs.readFileSync(path.join(plan.path, rel), "utf8");
    assert.ok(content.includes("22.23.4"), `${rel} not bumped:\n${content}`);
  }
  assert.ok(plan.path.startsWith(path.join(dataDir, "security-remediations")), "worktree must live under the run store");
  assert.equal(git(["status", "--porcelain"]).trim(), ""); // user tree never touched

  const paths = planPaths(run.id, plan.repoId, dataDir);
  assert.ok(fs.existsSync(paths.diff) && fs.existsSync(paths.prBody));
  const body = fs.readFileSync(paths.prBody, "utf8");
  assert.ok(body.includes("CognitionAI"), "MIT attribution footer required (§10.4)");

  // GATE 2: stale diff hash rejected; unverified fix needs the explicit tick.
  assert.throws(() => approveCommit(worked, plan.repoId, { diffHash: "x", prBodyHash: "y" }, dataDir), /diff_hash_mismatch/);
  assert.throws(() => approveCommit(worked, plan.repoId, { diffHash: canonicalSha256({ diff: fs.readFileSync(paths.diff, "utf8") }), prBodyHash: canonicalSha256({ body }) }, dataDir), /acceptUnverified/);

  approveCommit(worked, plan.repoId, { diffHash: canonicalSha256({ diff: fs.readFileSync(paths.diff, "utf8") }), prBodyHash: canonicalSha256({ body }), acceptUnverified: true }, dataDir);
  const committed = commitApproved(run.id, plan.repoId);
  const sha = committed.plans[0]!.commitSha!;
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.ok(git(["rev-parse", "--abbrev-ref", "HEAD"], plan.path).startsWith("loam/remediate/"));
  assert.ok(git(["log", "-1", "--format=%s"], plan.path).startsWith("[unverified]"), "unverified fix commits carry the [unverified] prefix");

  // GATE 3: foreign remote owner refused; allowed owner → PR → re-scan closure.
  assert.throws(() => approvePr(committed, plan.repoId, { remote: "https://github.com/evil/fixture", base: "main" }, dataDir), /owner_not_allowed/);
  approvePr(committed, plan.repoId, { remote: "https://github.com/khamis1992/fixture", base: "main" }, dataDir);
  const prRun = recordPr(run.id, plan.repoId, { number: 1, url: "https://github.com/khamis1992/fixture/pull/1", draft: true, provider: "local" });
  assert.equal(prRun.plans[0]!.phase, "pr_opened");
  assert.equal(prRun.state, "complete");
  assert.equal(prRun.closures.length, fixture.expect.length);
  for (const c of prRun.closures) assert.equal(c.state, "fixed_pending_deploy"); // D-6: fixed on branch, NOT closed as fixed
});

test("discard removes worktree + branch from the repo only; cancel works pre-gate", async () => {
  const run = await startRemediation({ repos: [repo] }, "test-model");
  approveScope(run, { planHash: planHashOf(run), repos: run.repos, rows: run.inventory.map((r: any) => r.id) }, dataDir);
  const worked = await workApprovedRepos(run.id);
  const plan = worked.plans[0]!;
  assert.ok(git(["branch", "--list", "loam/remediate/*"]).includes(plan.branch), "branch exists while working");
  const discarded = discardRepo(run.id, plan.repoId);
  assert.equal(discarded.plans[0]!.phase, "discarded");
  assert.equal(git(["branch", "--list", "loam/remediate/*"]).trim(), "", "branch deleted on discard");
  assert.equal(git(["status", "--porcelain"]).trim(), "", "user tree still untouched");

  const run2 = await startRemediation({ repos: [repo] }, "test-model");
  assert.equal(cancelRemediation(run2.id).state, "cancelled");
});

test("slug uses the dir tail so repoIds are branch/path-safe on Windows", async () => {
  const run = await startRemediation({ repos: [repo] }, "test-model");
  assert.deepEqual(run.repos, ["node-vuln-app"]);
  assert.ok(!run.repos[0]!.includes(":") && !run.repos[0]!.includes("\\"), "repoId must be path-safe");
});
