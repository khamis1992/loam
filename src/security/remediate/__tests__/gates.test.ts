import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { approveScope, approveCommit, approvePr, assertRepoApproved, planEdits, applyEditsToFile, createWorktree, removeWorktree, ALLOWED_PR_OWNERS } from "../gate/index.js";
import { RemediationError } from "../errors.js";
import { canonicalSha256, type RemediationRun, type VulnRecord, type RepoPlan, type FixGateResult } from "../types.js";
import { FIXTURES, materialize, readFixtureFiles } from "./fixtures.js";
import { runInventory } from "../inventory/index.js";
import { planPaths, writeRun } from "../store.js";

const advisories = path.resolve(process.cwd(), "security", "advisories");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-gates-"));

function makeRun(records: VulnRecord[]): RemediationRun {
  return {
    id: "test-run", createdAt: new Date().toISOString(), state: "awaiting_scope_approval",
    advisoryIds: ["node-2026-10-21"], packHashes: {}, repos: [...new Set(records.map((r) => r.hit.repoId))],
    inventory: records, unsearchable: [], scopeApproval: null, plans: [], evidence: [], closures: [],
    host: { platform: process.platform, docker: { available: false, blocker: "no docker (test)" } },
    model: "cloud-test", budget: { limit: null, spent: 0 },
  };
}

function currentPlanHash(records: VulnRecord[]): string {
  return canonicalSha256({
    rows: records.map((r) => ({ id: r.id, repoId: r.hit.repoId, file: r.hit.file, line: r.hit.line, signal: r.hit.signal, current: r.hit.currentVersion, status: r.status, target: r.proposedTarget, upgradeClass: r.upgradeClass })).sort((a, b) => a.id.localeCompare(b.id)),
  });
}

test("GATE 1: run stops awaiting_scope_approval; wrong hash -> 409; correct hash -> scope_approved", () => {
  const dir = materialize(FIXTURES.find((f) => f.name === "node-vuln-app")!, dataDir);
  const result = runInventory([{ repoId: "nva", files: readFixtureFiles(dir), lockfileContent: null }], advisories);
  const run = makeRun(result.records);
  // State machine: no approval possible before inventory -> set to awaiting.
  run.state = "awaiting_scope_approval";

  // No branch exists before GATE 1 (D-2).
  const branches = git(dir, ["branch", "--list", "loam/remediate/*"]);
  assert.equal(branches.trim(), "");

  assert.throws(() => approveScope(run, { planHash: "deadbeef", repos: ["nva"], rows: [] }), (e: unknown) => e instanceof RemediationError && e.code === "plan_hash_mismatch");

  const hash = currentPlanHash(run.inventory);
  const approved = approveScope(run, { planHash: hash, repos: ["nva"], rows: run.inventory.map((r) => r.id) });
  assert.equal(approved.state, "scope_approved");
  assert.equal(approved.scopeApproval?.decidedBy, "user");

  // assertRepoApproved now passes for the approved repo, throws for others.
  assertRepoApproved(approved, "nva");
  assert.throws(() => assertRepoApproved(approved, "other"), (e: unknown) => e instanceof RemediationError && e.code === "repo_not_approved");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("edit engine: planEdits preserves the -alpine variant; applyEdits refuses a changed line", () => {
  const dir = materialize(FIXTURES.find((f) => f.name === "node-vuln-app")!, dataDir);
  const result = runInventory([{ repoId: "nva", files: readFixtureFiles(dir), lockfileContent: null }], advisories);
  const readLine = (repoId: string, file: string, line: number): string | null => {
    const fx = FIXTURES.find((f) => f.name === "node-vuln-app")!;
    return (fx.files[file] ?? "").split(/\r?\n/)[line - 1] ?? null;
  };
  const edits = planEdits(result.records, readLine);
  const dockerfileEdit = edits.find((e) => e.file === "Dockerfile")!;
  assert.ok(dockerfileEdit.after.includes("22.23.4-alpine"), dockerfileEdit.after);
  assert.ok(!dockerfileEdit.after.includes("22.21.0"));

  // Apply to the real content.
  const applied = applyEditsToFile(FIXTURES.find((f) => f.name === "node-vuln-app")!.files["Dockerfile"]!, edits.filter((e) => e.file === "Dockerfile"));
  assert.equal(applied.refused.length, 0);
  assert.ok(applied.content.includes("FROM node:22.23.4-alpine"));

  // Refuse when the line changed underneath.
  const tampered = "FROM node:20.0.0-alpine\nWORKDIR /app\n";
  const refused = applyEditsToFile(tampered, edits.filter((e) => e.file === "Dockerfile"));
  assert.equal(refused.refused.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("worktree: created under the run store, user tree stays clean; removal drops branch", () => {
  const dir = materialize(FIXTURES.find((f) => f.name === "node-vuln-app")!, dataDir);
  const branch = "loam/remediate/node-2026-10-21/test1";
  const wt = createWorktree("wt-run", "nva", dir, branch, dataDir);
  assert.ok(wt.includes("worktrees"), wt);
  assert.ok(fs.existsSync(path.join(wt, "Dockerfile")));
  // User tree untouched.
  assert.equal(git(dir, ["status", "--porcelain"]).trim(), "");
  // Branch exists in the shared repo (from the worktree).
  assert.ok(git(dir, ["branch", "--list", branch]).includes(branch));

  removeWorktree("wt-run", "nva", dir, branch, dataDir);
  assert.ok(!fs.existsSync(wt));
  assert.equal(git(dir, ["branch", "--list", branch]).trim(), "");
  assert.equal(git(dir, ["status", "--porcelain"]).trim(), "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("GATE 2: wrong diffHash -> 409; acceptUnverified required for patched_unverified", () => {
  const dir = materialize(FIXTURES.find((f) => f.name === "node-vuln-app")!, dataDir);
  const result = runInventory([{ repoId: "nva", files: readFixtureFiles(dir), lockfileContent: null }], advisories);
  const run = makeRun(result.records);
  run.state = "scope_approved";
  run.scopeApproval = { planHash: "x", repos: ["nva"], rows: [], allowMajorUpgrade: {}, allowMinorUpgrade: {}, allowBaseOsChange: {}, allowAppCodeChange: {}, decidedAt: new Date().toISOString(), decidedBy: "user" };
  const plan: RepoPlan = {
    repoId: "nva", path: "/tmp/x", branch: "b", baseBranch: "main", phase: "awaiting_commit",
    vulns: [], proposal: null, baseline: null, after: null, comparison: null, runtimeDiff: null,
    smoke: null, artifactProof: null,
    fixGate: { verdict: "patched_unverified", reason: "no docker" } satisfies FixGateResult,
    commitApproval: null, prApproval: null, commitSha: null, pr: null, blockedReason: null, rollbackTarget: null,
  };
  run.plans = [plan];
  // Write the diff + PR body the hashes are computed against.
  const paths = planPaths(run.id, "nva", dataDir);
  fs.mkdirSync(paths.base, { recursive: true });
  fs.writeFileSync(paths.diff, "+FROM node:22.23.4-alpine\n", "utf8");
  fs.writeFileSync(paths.prBody, "# Remediate\n", "utf8");
  writeRun(run, dataDir);

  const diffHash = canonicalSha256({ diff: "+FROM node:22.23.4-alpine\n" });
  const prBodyHash = canonicalSha256({ body: "# Remediate\n" });
  assert.throws(() => approveCommit(run, "nva", { diffHash: "stale", prBodyHash }, dataDir), (e: unknown) => e instanceof RemediationError && e.code === "diff_hash_mismatch");
  // patched_unverified without the checkbox.
  assert.throws(() => approveCommit(run, "nva", { diffHash, prBodyHash }, dataDir), (e: unknown) => e instanceof RemediationError && e.code === "invalid_input" && /acceptUnverified/.test(e.message));
  const ok = approveCommit(run, "nva", { diffHash, prBodyHash, acceptUnverified: true }, dataDir);
  assert.equal(ok.plans[0]!.commitApproval?.acceptUnverified, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("GATE 3: foreign owner refused; draft defaults true", () => {
  const run = makeRun([]);
  run.state = "scope_approved";
  run.scopeApproval = { planHash: "x", repos: ["nva"], rows: [], allowMajorUpgrade: {}, allowMinorUpgrade: {}, allowBaseOsChange: {}, allowAppCodeChange: {}, decidedAt: new Date().toISOString(), decidedBy: "user" };
  run.plans = [{ repoId: "nva", path: "", branch: "b", baseBranch: "main", phase: "awaiting_pr", vulns: [], proposal: null, baseline: null, after: null, comparison: null, runtimeDiff: null, smoke: null, artifactProof: null, fixGate: null, commitApproval: null, prApproval: null, commitSha: "abc", pr: null, blockedReason: null, rollbackTarget: null }];
  assert.throws(() => approvePr(run, "nva", { remote: "https://github.com/stranger/repo.git", base: "main" }), (e: unknown) => e instanceof RemediationError && e.code === "owner_not_allowed");
  const ok = approvePr(run, "nva", { remote: "https://github.com/khamis1992/loam.git", base: "main" });
  assert.equal(ok.plans[0]!.prApproval?.draft, true);
  assert.deepEqual(ALLOWED_PR_OWNERS, ["khamis1992"]);
});

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}
