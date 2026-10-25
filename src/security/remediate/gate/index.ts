/** GATE implementations + edit engine + worktrees — REMEDIATE_INTO_LOAM §5.2/§7.3
 *  (Phase C). Gates are persisted, hash-bound records; approvals arrive ONLY
 *  from the HTTP/UI layer. Edits refuse when the source line changed underneath.
 *  Worktrees live under the run store — the user's tree is never touched. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RemediationError } from "../errors.js";
import { canonicalSha256, type CommitApproval, type ProposedEdit, type RemediationRun, type ScopeApproval, type VulnRecord } from "../types.js";
import { planPaths, writeRun } from "../store.js";

// ---------------------------------------------------------------------------
// GATE 1 — scope

/** The hash of the inventory as it must be shown for GATE 1 — identical bytes to
 *  what approveScope verifies, so a UI that echoes this back binds the user's
 *  decision to exactly the rows the server rendered. */
export function expectedPlanHash(run: RemediationRun): string {
  return canonicalSha256({
    rows: run.inventory.map((r) => ({ id: r.id, repoId: r.hit.repoId, file: r.hit.file, line: r.hit.line, signal: r.hit.signal, current: r.hit.currentVersion, status: r.status, target: r.proposedTarget, upgradeClass: r.upgradeClass })).sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function approveScope(run: RemediationRun, input: { planHash: string; repos: string[]; rows: string[]; allowMajorUpgrade?: Record<string, boolean>; allowMinorUpgrade?: Record<string, boolean>; allowBaseOsChange?: Record<string, boolean>; allowAppCodeChange?: Record<string, boolean> }, dataDir?: string): RemediationRun {
  if (run.state !== "awaiting_scope_approval") throw new RemediationError(409, "wrong_state", `state is ${run.state}`);
  const targets: Record<string, string | null> = {};
  for (const r of run.inventory) targets[r.id] = r.proposedTarget;
  const expected = expectedPlanHash(run);
  if (input.planHash !== expected) throw new RemediationError(409, "plan_hash_mismatch", "the inventory changed since it was shown — review again");
  const known = new Set(run.inventory.map((r) => r.id));
  for (const row of input.rows) if (!known.has(row)) throw new RemediationError(400, "invalid_input", `unknown row ${row}`);
  const approval: ScopeApproval = {
    planHash: input.planHash,
    repos: input.repos,
    rows: input.rows,
    allowMajorUpgrade: input.allowMajorUpgrade ?? {},
    allowMinorUpgrade: input.allowMinorUpgrade ?? {},
    allowBaseOsChange: input.allowBaseOsChange ?? {},
    allowAppCodeChange: input.allowAppCodeChange ?? {},
    decidedAt: new Date().toISOString(),
    decidedBy: "user",
  };
  run.scopeApproval = approval;
  run.state = "scope_approved";
  writeRun(run, dataDir);
  return run;
}

/** Every mutating function calls this (§5.1 rule map). */
export function assertRepoApproved(run: RemediationRun, repoId: string): void {
  if (!run.scopeApproval || run.state === "awaiting_scope_approval") throw new RemediationError(403, "repo_not_approved", `GATE 1 has not approved ${repoId}`);
  if (!run.scopeApproval.repos.includes(repoId)) throw new RemediationError(403, "repo_not_approved", `${repoId} is not in the approved scope`);
}

// ---------------------------------------------------------------------------
// GATE 2 — commit

export function approveCommit(run: RemediationRun, repoId: string, input: { diffHash: string; prBodyHash: string; acceptUnverified?: boolean }, dataDir?: string): RemediationRun {
  assertRepoApproved(run, repoId);
  const plan = run.plans.find((p) => p.repoId === repoId);
  if (!plan) throw new RemediationError(404, "run_not_found", `no plan for ${repoId}`);
  if (plan.phase !== "awaiting_commit") throw new RemediationError(409, "wrong_state", `repo phase is ${plan.phase}`);
  const paths = planPaths(run.id, repoId, dataDir);
  const actualDiffHash = fs.existsSync(paths.diff) ? canonicalSha256({ diff: fs.readFileSync(paths.diff, "utf8") }) : null;
  if (actualDiffHash !== input.diffHash) throw new RemediationError(409, "diff_hash_mismatch", "the working tree changed after approval was shown");
  const actualBodyHash = canonicalSha256({ body: fs.readFileSync(paths.prBody, "utf8") });
  if (actualBodyHash !== input.prBodyHash) throw new RemediationError(409, "pr_body_hash_mismatch", "PR body changed");
  // OD-7/E10: an unverified fix needs the explicit acceptUnverified tick.
  if (plan.fixGate?.verdict === "patched_unverified" && input.acceptUnverified !== true) {
    throw new RemediationError(400, "invalid_input", "fix is patched_unverified (Docker unavailable) — acceptUnverified checkbox required");
  }
  plan.commitApproval = { repoId, diffHash: input.diffHash, prBodyHash: input.prBodyHash, acceptUnverified: input.acceptUnverified === true, decidedAt: new Date().toISOString(), decidedBy: "user" };
  writeRun(run, dataDir);
  return run;
}

// ---------------------------------------------------------------------------
// GATE 3 — push + PR

export const ALLOWED_PR_OWNERS = ["khamis1992"]; // OD-9

export function approvePr(run: RemediationRun, repoId: string, input: { remote: string; base: string; draft?: boolean }, dataDir?: string): RemediationRun {
  assertRepoApproved(run, repoId);
  const plan = run.plans.find((p) => p.repoId === repoId);
  if (!plan || plan.phase !== "awaiting_pr") throw new RemediationError(409, "wrong_state", `repo phase is ${plan?.phase ?? "none"}`);
  // Owner gate: remote must point at an allowed owner.
  const owner = remoteOwner(input.remote);
  if (owner && !ALLOWED_PR_OWNERS.includes(owner)) throw new RemediationError(403, "owner_not_allowed", `remote owner ${owner} is not in the allowed list`);
  plan.prApproval = { repoId, remote: input.remote, base: input.base, draft: input.draft !== false, decidedAt: new Date().toISOString(), decidedBy: "user" };
  writeRun(run, dataDir);
  return run;
}

function remoteOwner(remote: string): string | null {
  const m = remote.match(/github\.com[/:]([^/]+)\//i) ?? remote.match(/^([^/]+)\/[^/]+$/);
  return m?.[1]?.toLowerCase() ?? null;
}

// ---------------------------------------------------------------------------
// Edit engine (§6.1 edit/*)

/** Build ProposedEdit[] from verified targets + pin style (planEdits). */
export function planEdits(records: VulnRecord[], readLine: (repoId: string, file: string, line: number) => string | null): ProposedEdit[] {
  const edits: ProposedEdit[] = [];
  for (const r of records) {
    if (!r.proposedTarget) continue; // vendor_update_required / eol — nothing to edit
    const before = readLine(r.hit.repoId, r.hit.file, r.hit.line);
    if (before === null) continue;
    // Preserve the variant suffix (e.g. 22.21.0-alpine -> 22.23.4-alpine).
    const current = r.hit.currentVersion ?? "";
    const suffix = before.includes(current) ? before.slice(before.indexOf(current) + current.length) : "";
    const after = before.replace(current, `${r.proposedTarget}${suffix}`);
    if (after !== before) {
      edits.push({ file: r.hit.file, line: r.hit.line, before, after, rationale: `${r.hit.pinStyle} bump ${current} -> ${r.proposedTarget}${suffix || ""} (${r.advisoryId})` });
    }
  }
  return edits;
}

/** Apply edits to a file inside the worktree; refuse when the line changed (§6.1). */
export function applyEditsToFile(content: string, edits: ProposedEdit[]): { content: string; refused: ProposedEdit[] } {
  const lines = content.split(/\r?\n/);
  const refused: ProposedEdit[] = [];
  for (const e of edits) {
    const idx = e.line - 1;
    const actual = lines[idx];
    if (actual === undefined || !actual.includes(e.before.trim().split(/\s{2,}/)[0]!.slice(0, Math.min(24, e.before.trim().length)))) {
      refused.push(e);
      continue;
    }
    lines[idx] = actual.replace(e.before.trim(), e.after.trim()) === actual ? e.after : actual.replace(e.before.trim(), e.after.trim());
  }
  return { content: lines.join("\n"), refused };
}

// ---------------------------------------------------------------------------
// Worktrees (§5.8): under the run store only

export function createWorktree(runId: string, repoId: string, sourceRepoDir: string, branch: string, dataDir?: string): string {
  const paths = planPaths(runId, repoId, dataDir);
  fs.mkdirSync(paths.worktreesDir, { recursive: true });
  const wt = path.join(paths.worktreesDir, repoId);
  execFileSync("git", ["-C", sourceRepoDir, "worktree", "add", "-b", branch, wt], { stdio: "pipe" });
  return wt;
}

export function removeWorktree(runId: string, repoId: string, sourceRepoDir: string, branch: string, dataDir?: string): void {
  const paths = planPaths(runId, repoId, dataDir);
  const wt = path.join(paths.worktreesDir, repoId);
  try { execFileSync("git", ["-C", sourceRepoDir, "worktree", "remove", "--force", wt], { stdio: "pipe" }); } catch { /* already gone */ }
  try { execFileSync("git", ["-C", sourceRepoDir, "branch", "-D", branch], { stdio: "pipe" }); } catch { /* already gone */ }
}
