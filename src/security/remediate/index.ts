/** Remediation orchestrator — REMEDIATE_INTO_LOAM §6.1 index.ts / §7.3 state
 *  machine (appendix E7). Strings the proven units into one persisted run:
 *  inventory → GATE 1 (HTTP) → resolve → edit in a run-store worktree →
 *  fix gate → GATE 2 (HTTP) → commit → GATE 3 (HTTP) → PR → re-scan → closure.
 *  Model tools only START and READ runs; every gate decision is HTTP/UI-only. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../config.js";
let RUN_DATA_DIR = DATA_DIR;
import { fileURLToPath } from "node:url";
const REPO_ADVISORIES = path.resolve(fileURLToPath(import.meta.url), "../../../../security/advisories");
import { RemediationError } from "./errors.js";
import {
  REMEDIATE_LIMITS, canonicalSha256,
  type FixProposal, type RemediationRun, type RemediationStartInput, type RepoPlan, type VulnRecord,
} from "./types.js";
import { loadEnabledPacks } from "./packs/loader.js";
import { runInventory } from "./inventory/index.js";
import { resolveTarget } from "./resolve/targetResolver.js";
import { approveScope, assertRepoApproved, createWorktree, removeWorktree } from "./gate/index.js";
import { planEdits, applyEditsToFile } from "./gate/index.js";
import { evaluateFixGate, probeDocker, notRunTestRun, compareTestRuns } from "./build/fixGate.js";
import { prBody as buildPrBody, prTitle, prBodyHash, diffHash, branchName } from "./pr/body.js";
import { closureFromRescan, rescanRuntimeInventory } from "./rescan/index.js";
import { planPaths, readRun, writeRun, writeInventory, listRuns } from "./store.js";
import type { ScanFile } from "./inventory/node.js";

function slug(r: string): string {
  const parts = r.split(/[\\/]/).filter(Boolean);
  const tail = parts[parts.length - 1] ?? r;
  return (tail === "workspace" || !tail ? "ws" : tail).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40) || "repo";
}
const git = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

export function setRemediationDataDir(d: string): void { RUN_DATA_DIR = d; }

// ---------------------------------------------------------------------------
// start: inventory, then stop at GATE 1

export async function startRemediation(input: RemediationStartInput, model: string): Promise<RemediationRun> {
  const packs = loadEnabledPacks(REPO_ADVISORIES);
  const ids = (input.advisory_ids ?? [...packs.keys()]).filter((id) => packs.has(id));
  if (ids.length === 0) throw new RemediationError(400, "invalid_input", "no matching enabled advisory packs");

  const repos: Array<{ repoId: string; dir: string }> = (input.repos?.length ? input.repos : ["workspace"]).map((r, i) => ({
    repoId: slug(r),
    dir: r === "workspace" || !r.includes("/") ? (r === "workspace" ? process.cwd() : r) : r,
  }));
  if (repos.length > REMEDIATE_LIMITS.maxRepos) throw new RemediationError(400, "invalid_input", `> ${REMEDIATE_LIMITS.maxRepos} repos`);

  const docker = input.allow_docker ? probeDocker() : { available: false, blocker: "docker not permitted for this run" };
  // RUN_DATA_DIR = DATA_DIR (which already reads MANUS_LOCAL_DATA_DIR at import) unless
  // setRemediationDataDir() pinned an explicit store — never re-read env here, it would clobber the pin.
  const run: RemediationRun = {
    id: randomUUID(), createdAt: new Date().toISOString(),
    state: "inventory",
    advisoryIds: ids, packHashes: Object.fromEntries([...packs].map(([id, p]) => [id, p.sha256])),
    repos: repos.map((r) => r.repoId),
    repoDirs: Object.fromEntries(repos.map((r) => [r.repoId, r.dir])),
    inventory: [], unsearchable: [], scopeApproval: null, plans: [], evidence: [], closures: [],
    host: { platform: process.platform, docker },
    model, budget: { limit: input.budget ?? null, spent: 0 },
  };

  // Inventory (read-only; E8 validation inside).
  const inputs = repos.map((r) => ({ repoId: r.repoId, files: scanFilesOf(r.dir), lockfileContent: readLock(r.dir) }));
  const { records, droppedHits } = runInventory(inputs);
  run.inventory = records.slice(0, REMEDIATE_LIMITS.maxRows);
  run.unsearchable = droppedHits.map((d) => ({ repoId: d.repoId, reason: d.reason }));
  if (run.inventory.length === 0) {
    run.state = "complete";
    run.incompleteReason = "no_vulnerable_rows";
  } else {
    run.state = "awaiting_scope_approval"; // D-2: STOP. No branch exists until GATE 1.
  }
  writeRun(run, RUN_DATA_DIR);
  writeInventory(run.id, run.inventory, RUN_DATA_DIR);
  return run;
}

// ---------------------------------------------------------------------------
// after GATE 1: per-repo pipeline

export async function workApprovedRepos(runId: string): Promise<RemediationRun> {
  const run = requireRun(runId);
  if (run.state !== "scope_approved") throw new RemediationError(409, "wrong_state", `state is ${run.state}`);
  run.state = "working";
  writeRun(run, RUN_DATA_DIR);

  for (const repoId of run.scopeApproval!.repos) {
    assertRepoApproved(run, repoId);
    const advisoryId = run.inventory.find((r) => r.hit.repoId === repoId)?.advisoryId ?? run.advisoryIds[0]!;
    const branch = branchName(advisoryId, run.id);
    const base = "main";
    const sourceDir = run.repoDirs?.[repoId] ?? process.cwd(); // the repo that was actually scanned
    const paths = planPaths(run.id, repoId, RUN_DATA_DIR);
    fs.mkdirSync(paths.base, { recursive: true });

    const plan: RepoPlan = {
      repoId, path: "", branch, baseBranch: base, phase: "resolve",
      vulns: run.inventory.filter((r) => r.hit.repoId === repoId).map((r) => r.id),
      proposal: null, baseline: null, after: null, comparison: null, runtimeDiff: null,
      smoke: null, artifactProof: null, fixGate: null, commitApproval: null, prApproval: null,
      commitSha: null, pr: null, blockedReason: null, rollbackTarget: null,
    };
    run.plans = [...run.plans.filter((p) => p.repoId !== repoId), plan];
    writeRun(run, RUN_DATA_DIR);

    // Resolve targets (evidence-gated).
    const packs = loadEnabledPacks(REPO_ADVISORIES);
    const proposals: FixProposal[] = [];
    for (const vuln of run.inventory.filter((r) => r.hit.repoId === repoId && r.proposedTarget)) {
      const loaded = packs.get(vuln.advisoryId);
      if (!loaded) continue;
      const verification = await resolveTarget(vuln, loaded.pack, loaded.sha256);
      proposals.push({
        vulnId: vuln.id, repoId, verification,
        edits: [], upgradeClass: vuln.upgradeClass, riskLabel: vuln.riskLabel, mitigations: vuln.mitigations,
      });
    }
    if (proposals.length === 0) {
      plan.phase = "blocked";
      plan.blockedReason = "no verified target for any row (vendor_update_required or EOL)";
      run.state = "awaiting_commit_approval"; // user can still discard
      writeRun(run, RUN_DATA_DIR);
      continue;
    }

    // Baseline (no-Docker honest path by design — E10).
    plan.baseline = notRunTestRun("baseline", run.host.docker.available ? "" : run.host.docker.blocker ?? "Docker unavailable");
    plan.rollbackTarget = {};

    // Edit in a run-store worktree.
    plan.path = createWorktree(run.id, repoId, sourceDir, branch, RUN_DATA_DIR);
    const vulns = run.inventory.filter((r) => r.hit.repoId === repoId);
    const edits = planEdits(vulns, (_rid, file, line) => {
      const p = path.join(plan.path, file);
      return fs.existsSync(p) ? fs.readFileSync(p, "utf8").split(/\r?\n/)[line - 1] ?? null : null;
    });
    for (const proposal of proposals) proposal.edits = edits.filter((e) => vulns.some((v) => v.id === proposal.vulnId));
    plan.proposal = proposals[0] ?? null;
    const byFile = new Map<string, typeof edits>();
    for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
    for (const [file, fileEdits] of byFile) {
      const full = path.join(plan.path, file);
      const current = fs.readFileSync(full, "utf8");
      const { content, refused } = applyEditsToFile(current, fileEdits);
      if (refused.length) throw new RemediationError(409, "line_changed_underneath", `${file}: ${refused.length} edit(s) refused — the source changed`);
      fs.writeFileSync(full, content, "utf8");
    }
    fs.writeFileSync(paths.proposal, JSON.stringify(proposals, null, 1), "utf8");

    // Diff + after + fix gate.
    const diff = git(plan.path, ["diff"]);
    fs.writeFileSync(paths.diff, diff, "utf8");
    plan.after = notRunTestRun("after", run.host.docker.available ? "" : run.host.docker.blocker ?? "Docker unavailable");
    plan.comparison = compareTestRuns(plan.baseline, plan.after);
    plan.fixGate = evaluateFixGate({
      verification: plan.proposal?.verification ?? { target: { value: "none", line: "?", packId: advisoryId, packSha256: "" }, status: "not_found", evidence: [] },
      artifactProof: null, comparison: plan.comparison, smoke: null,
      policy: { dockerAvailable: run.host.docker.available, dockerBlocker: run.host.docker.blocker },
    });
    plan.phase = "awaiting_commit";
    // PR body (deterministic template).
    const loaded = packs.get(advisoryId);
    if (loaded) {
      const body = buildPrBody({ runId: run.id, pack: loaded.pack, records: vulns, proposal: plan.proposal, plan, comparison: plan.comparison });
      fs.writeFileSync(paths.prBody, body, "utf8");
    }
    writeRun(run, RUN_DATA_DIR);
  }

  run.state = "awaiting_commit_approval";
  writeRun(run, RUN_DATA_DIR);
  return run;
}

// ---------------------------------------------------------------------------
// after GATE 2: commit on the Remediate branch only

export function commitApproved(runId: string, repoId: string): RemediationRun {
  const run = requireRun(runId);
  const plan = run.plans.find((p) => p.repoId === repoId);
  if (!plan?.commitApproval) throw new RemediationError(403, "repo_not_approved", `GATE 2 has not approved ${repoId}`);
  const paths = planPaths(runId, repoId, RUN_DATA_DIR);
  const body = fs.readFileSync(paths.prBody, "utf8");
  if (canonicalSha256({ body }) !== plan.commitApproval.prBodyHash) throw new RemediationError(409, "pr_body_hash_mismatch", "PR body drifted");
  git(plan.path, ["add", "-A"]);
  const title = planTitle(run, plan);
  git(plan.path, ["-c", "user.name=loam-remediate", "-c", "user.email=remediate@loam.local", "commit", "-qm", title]);
  plan.commitSha = git(plan.path, ["rev-parse", "HEAD"]).trim();
  plan.phase = "awaiting_pr";
  fs.writeFileSync(paths.commit, JSON.stringify({ sha: plan.commitSha, approvedAt: plan.commitApproval.decidedAt, diffHash: plan.commitApproval.diffHash }, null, 1), "utf8");
  run.state = run.plans.every((p) => p.phase !== "awaiting_commit") ? "awaiting_pr_approval" : "awaiting_commit_approval";
  writeRun(run, RUN_DATA_DIR);
  return run;
}

function planTitle(run: RemediationRun, plan: RepoPlan): string {
  const packs = loadEnabledPacks(REPO_ADVISORIES);
  const advisoryId = run.inventory.find((r) => r.hit.repoId === plan.repoId)?.advisoryId ?? run.advisoryIds[0]!;
  const pack = packs.get(advisoryId)?.pack;
  return `${plan.fixGate?.verdict === "patched_unverified" ? "[unverified] " : ""}Remediate: ${pack?.title ?? advisoryId}`;
}

// ---------------------------------------------------------------------------
// after GATE 3: record the PR placeholder (push/creation ride the existing approvePush path)

export function recordPr(runId: string, repoId: string, pr: { number: number; url: string; draft: boolean; provider: string }): RemediationRun {
  const run = requireRun(runId);
  const plan = run.plans.find((p) => p.repoId === repoId);
  if (!plan?.prApproval) throw new RemediationError(403, "repo_not_approved", `GATE 3 has not approved ${repoId}`);
  plan.pr = pr;
  plan.phase = "pr_opened";
  const paths = planPaths(runId, repoId, RUN_DATA_DIR);
  fs.writeFileSync(paths.pr, JSON.stringify(pr, null, 1), "utf8");

  // Phase 8a: re-scan on the fix branch.
  const vulns = run.inventory.filter((r) => r.hit.repoId === repoId);
  const files = scanFilesOf(plan.path);
  const post = rescanRuntimeInventory({ repoId, files, lockfileContent: readLock(plan.path) }, run.advisoryIds);
  for (const vuln of vulns) {
    const postRow = post.records.find((r) => r.hit.file === vuln.hit.file && r.hit.line === vuln.hit.line);
    run.closures = [...run.closures.filter((c) => c.vulnId !== vuln.id), closureFromRescan(vuln, postRow)];
  }
  if (run.plans.every((p) => p.phase === "pr_opened" || p.phase === "discarded" || p.phase === "blocked")) {
    run.state = "complete";
    run.finishedAt = new Date().toISOString();
  }
  writeRun(run, RUN_DATA_DIR);
  return run;
}

export function discardRepo(runId: string, repoId: string): RemediationRun {
  const run = requireRun(runId);
  const plan = run.plans.find((p) => p.repoId === repoId);
  if (!plan) throw new RemediationError(404, "run_not_found", repoId);
  if (plan.commitSha) throw new RemediationError(409, "wrong_state", "repo already committed — discard happens before GATE 2");
  if (plan.path) removeWorktree(runId, repoId, run.repoDirs?.[repoId] ?? process.cwd(), plan.branch, RUN_DATA_DIR);
  plan.phase = "discarded";
  writeRun(run, RUN_DATA_DIR);
  return run;
}

export function cancelRemediation(runId: string): RemediationRun {
  const run = requireRun(runId);
  run.state = "cancelled";
  run.finishedAt = new Date().toISOString();
  writeRun(run, RUN_DATA_DIR);
  return run;
}

/** GATE 1 as exposed to the HTTP layer — dataDir-bound to this run store. */
export function approveScopeForRun(run: RemediationRun, input: Parameters<typeof approveScope>[1]): RemediationRun {
  return approveScope(run, input, RUN_DATA_DIR);
}

export { approveScope, readRun, listRuns };

function requireRun(runId: string): RemediationRun {
  const run = readRun(runId, RUN_DATA_DIR);
  if (!run) throw new RemediationError(404, "run_not_found", runId);
  return run;
}

function scanFilesOf(dir: string): ScanFile[] {
  const out: ScanFile[] = [];
  const walk = (d: string, prefix: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules" || e.name === ".loam") continue;
      const p = path.join(d, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, rel);
      else if (/(^|\/)(Dockerfile|dockerfile.*|\.nvmrc|\.node-version|\.tool-versions|package\.json|package-lock\.json|composer\.json|.*\.ya?ml)$/i.test(rel) || /ansible|playbook|site\.yml|main\.yml/i.test(rel)) {
        try { out.push({ repoId: path.basename(dir), rel, content: fs.readFileSync(p, "utf8") }); } catch { /* unreadable */ }
      }
    }
  };
  walk(dir, "");
  return out;
}

function readLock(dir: string): string | null {
  const p = path.join(dir, "package-lock.json");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

export { canonicalSha256 as _hash, diffHash, prBodyHash };
