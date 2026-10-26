/**
 * C11: git plumbing for the shared workspace. The run root holds `main`; every worker
 * gets its own git worktree on `worker/<id>/<label>` branches; merges into `main` are
 * engine-executed, serialized per run, and every count returned comes from git output.
 * Style of SwarmService.capture (src/swarm/service.ts): execFile, cwd, 15 s timeout.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GIT_TIMEOUT_MS } from "./types.js";

const exec = promisify(execFile);

export interface GitOut { ok: boolean; out: string }

export async function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitOut> {
  try {
    const r = await exec("git", args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, out: `${String(r.stdout)}${String(r.stderr)}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${String(e.stdout ?? "")}${String(e.stderr ?? "")}\n${String(e.message ?? err)}` };
  }
}

async function gitText(cwd: string, args: string[]): Promise<string | null> {
  try {
    const r = await exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return String(r.stdout);
  } catch {
    return null;
  }
}

const lines = (s: string | null): string[] => (s ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

export const REALSWARM_DIR = path.join(".loam", "realswarm");
export const workerWorktreePath = (runRoot: string, workerId: string): string => path.join(runRoot, REALSWARM_DIR, "workers", workerId);
export const claimBranch = (workerId: string, label: string): string => `worker/${workerId}/${label}`;

/**
 * Prepare the run repository. Fresh: `git init -b main`, optional seed folder copy, first commit.
 * baseRepo: clone a completed run's repository. `.loam/realswarm/` is always excluded from commits.
 */
export async function initRunRepo(runRoot: string, opts: { seedDir?: string; baseRepo?: string } = {}): Promise<boolean> {
  fs.mkdirSync(runRoot, { recursive: true });
  const hasRepo = fs.existsSync(path.join(runRoot, ".git"));
  if (!hasRepo) {
    if (opts.baseRepo) {
      if (!(await git(runRoot, ["clone", "--no-hardlinks", opts.baseRepo, "."])).ok) return false;
      if ((await gitText(runRoot, ["rev-parse", "--verify", "main"])) === null && !(await git(runRoot, ["branch", "main"])).ok) return false;
      if (!(await git(runRoot, ["checkout", "main"])).ok) return false;
    } else if (!(await git(runRoot, ["init", "-b", "main"])).ok) return false;
  }
  if (!(await git(runRoot, ["config", "user.name", "Loam Coding Team"])).ok) return false;
  if (!(await git(runRoot, ["config", "user.email", "realswarm@loam.local"])).ok) return false;
  // Byte-exact merges: a developer machine's core.autocrlf must never rewrite
  // worker files between commit and checkout, or the engine's merge results
  // differ from what the worker wrote and tests.
  if (!(await git(runRoot, ["config", "core.autocrlf", "false"])).ok) return false;
  const exclude = path.join(runRoot, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (!current.split(/\r?\n/).includes(".loam/realswarm/")) fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}.loam/realswarm/\n`);
  if (opts.seedDir && !hasRepo && !opts.baseRepo) {
    const seed = opts.seedDir;
    fs.cpSync(seed, runRoot, {
      recursive: true,
      filter: (src) => !path.relative(seed, src).split(path.sep).some((seg) => seg === ".git" || seg === "node_modules" || seg === ".loam"),
    });
  }
  if ((await gitText(runRoot, ["rev-parse", "--verify", "HEAD"])) === null) {
    await git(runRoot, ["add", "-A"]);
    if (!(await git(runRoot, ["commit", "--allow-empty", "-m", "realswarm: initialize main"])).ok) return false;
  }
  return true;
}

/** One worktree per worker on `worker/<id>/start` (recreated from main on retry). */
export async function addWorkerWorktree(runRoot: string, workerId: string): Promise<string> {
  const wt = workerWorktreePath(runRoot, workerId);
  const listed = lines(await gitText(runRoot, ["worktree", "list", "--porcelain"])).some((l) => l === `worktree ${wt}` || l === `worktree ${wt.replaceAll("\\", "/")}`);
  if (listed && fs.existsSync(wt)) return wt;
  await git(runRoot, ["worktree", "prune"]);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const r = await git(runRoot, ["worktree", "add", "-B", claimBranch(workerId, "start"), wt, "main"]);
  if (!r.ok) throw new Error(`git worktree add failed for ${workerId}: ${r.out.trim().slice(-300)}`);
  return wt;
}

export async function currentBranch(worktree: string): Promise<string | null> {
  const b = (await gitText(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
  return b && b !== "HEAD" ? b : null;
}

export async function isClean(worktree: string): Promise<boolean> {
  const s = await gitText(worktree, ["status", "--porcelain"]);
  return s !== null && s.trim() === "";
}

/**
 * Called when a worker's CLAIM is admitted: put its worktree on `worker/<id>/<label>`.
 * New label: branch from the current main. Existing label: switch back to it.
 * A dirty tree is never switched; the worker is told to commit first.
 */
export async function switchClaimBranch(worktree: string, workerId: string, label: string): Promise<{ ok: boolean; branch: string; note: string }> {
  const branch = claimBranch(workerId, label);
  if ((await currentBranch(worktree)) === branch) return { ok: true, branch, note: `already on ${branch}` };
  if (!(await isClean(worktree))) return { ok: false, branch, note: `uncommitted changes: commit them (git_commit) before claiming; still on ${await currentBranch(worktree)}` };
  const exists = (await gitText(worktree, ["rev-parse", "--verify", branch])) !== null;
  const r = exists ? await git(worktree, ["switch", branch]) : await git(worktree, ["switch", "-c", branch, "main"]);
  return r.ok ? { ok: true, branch, note: `switched to ${branch}${exists ? "" : " (from main)"}` } : { ok: false, branch, note: r.out.trim().slice(-300) };
}

export interface MergeOutcome {
  status: "merged" | "noop" | "conflict" | "error";
  branch: string;
  changedFiles: string[];
  conflicts: string[];
  commit?: string;
  detail: string;
}

const mergeChains = new Map<string, Promise<unknown>>();

/** Runs fn after every earlier merge of the same run root has settled (one merge at a time). */
export function serializePerRun<T>(runRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = mergeChains.get(runRoot) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  mergeChains.set(runRoot, next.catch(() => undefined));
  return next;
}

/** Engine-executed no-ff merge of a worker branch into main, in the run root. Serialized per run. */
export function mergeWorkerBranch(runRoot: string, branch: string, message: string): Promise<MergeOutcome> {
  return serializePerRun(runRoot, async () => {
    if ((await gitText(runRoot, ["rev-parse", "--verify", branch])) === null) return { status: "error", branch, changedFiles: [], conflicts: [], detail: `branch ${branch} does not exist` };
    if ((await currentBranch(runRoot)) !== "main" && !(await git(runRoot, ["checkout", "main"])).ok) return { status: "error", branch, changedFiles: [], conflicts: [], detail: "could not check out main in the run root" };
    const changedFiles = lines(await gitText(runRoot, ["diff", "--name-only", `main...${branch}`]));
    if (!changedFiles.length) return { status: "noop", branch, changedFiles, conflicts: [], detail: `${branch} has no changes relative to main` };
    const m = await git(runRoot, ["merge", "--no-ff", branch, "-m", message]);
    if (!m.ok) {
      const conflicts = lines(await gitText(runRoot, ["diff", "--name-only", "--diff-filter=U"]));
      await git(runRoot, ["merge", "--abort"]);
      return { status: conflicts.length ? "conflict" : "error", branch, changedFiles, conflicts, detail: m.out.trim().slice(-400) };
    }
    const commit = (await gitText(runRoot, ["rev-parse", "HEAD"]))?.trim();
    return { status: "merged", branch, changedFiles, conflicts: [], ...(commit ? { commit } : {}), detail: `merged ${branch} into main` };
  });
}

/** Unified diff of a branch against main (C3 selection fingerprint). */
export async function branchDiff(runRoot: string, branch: string): Promise<string> {
  return (await gitText(runRoot, ["diff", `main...${branch}`])) ?? "";
}

export async function mainCommitCount(runRoot: string): Promise<number> {
  return Number((await gitText(runRoot, ["rev-list", "--count", "main"]))?.trim() ?? 0) || 0;
}

/** Merge commits on main's first-parent line only: a worker's own "merge main into my branch" commit is not a landed merge. */
export async function mainMergeCount(runRoot: string): Promise<number> {
  return Number((await gitText(runRoot, ["rev-list", "--first-parent", "--merges", "--count", "main"]))?.trim() ?? 0) || 0;
}

export async function lastCommitEpochSec(worktree: string): Promise<number | undefined> {
  const t = (await gitText(worktree, ["log", "-1", "--format=%ct"]))?.trim();
  return t ? Number(t) : undefined;
}

/** Run end: remove every worker worktree and prune; branches stay for provenance. */
export async function removeWorktrees(runRoot: string): Promise<number> {
  const dir = path.join(runRoot, REALSWARM_DIR, "workers");
  let n = 0;
  if (fs.existsSync(dir)) {
    for (const id of fs.readdirSync(dir)) {
      if ((await git(runRoot, ["worktree", "remove", "--force", path.join(dir, id)])).ok) n++;
    }
  }
  await git(runRoot, ["worktree", "prune"]);
  return n;
}
