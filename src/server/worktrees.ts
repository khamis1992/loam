/**
 * Git helpers for project context (option 17): read the real branch of a
 * project folder and create Loam worktrees under it with `git worktree add`.
 * Nothing here executes the project itself.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

const execOpts = { windowsHide: true, timeout: 20_000 } as const;

export interface GitBranchInfo {
  isGit: boolean;
  branch: string | null;
  /** Raw git stderr reason when detection failed. */
  reason?: string;
}

/**
 * Resolve the worktree root git reports for `folder`. `git rev-parse` walks up the
 * parent chain, so a folder that merely lives inside some ancestor repository
 * (e.g. `%TEMP%` under a user home that is itself a git repo) would still resolve a
 * branch. Callers asking "is *this* folder a project repo" need the discovered root to
 * be the folder itself, so anything resolving outside it is reported as not a git folder.
 */
async function gitWorktreeRoot(folder: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", folder, "rev-parse", "--show-toplevel"], execOpts);
    return stdout.trim().replace(/\/+$/, "").toLowerCase();
  } catch {
    return null;
  }
}

function isSamePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  try {
    return norm(a) === norm(b);
  } catch {
    return a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
  }
}

export async function readGitBranch(folder: string): Promise<GitBranchInfo> {
  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    return { isGit: false, branch: null, reason: "folder is not a directory" };
  }
  const root = await gitWorktreeRoot(folder);
  if (!root) return { isGit: false, branch: null, reason: "not a git worktree" };
  if (!isSamePath(root, folder)) {
    return { isGit: false, branch: null, reason: `folder is inside another repository: ${root}` };
  }
  try {
    const { stdout } = await execFileAsync("git", ["-C", folder, "rev-parse", "--abbrev-ref", "HEAD"], execOpts);
    const branch = stdout.trim();
    if (!branch) return { isGit: true, branch: null, reason: "empty branch name" };
    return { isGit: true, branch };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { isGit: false, branch: null, reason: (e.stderr ?? e.message ?? "git failed").trim().slice(0, 200) };
  }
}

/** Worktree names are simple slugs to keep paths shell-safe. */
export function safeWorktreeName(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  const cleaned = raw.replace(/[^\w-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return cleaned || `run-${Date.now().toString(36)}`;
}

export type WorktreeResult = { ok: true; path: string; branch: string } | { error: string };

/** `git worktree add <folder>/.loam-worktrees/<name> -b loam/<name> HEAD`. */
export async function createWorktree(folder: string, nameInput?: unknown): Promise<WorktreeResult> {
  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return { error: "project folder is not a directory" };
  const base = await readGitBranch(folder);
  if (!base.isGit) return { error: `not a git repository: ${base.reason ?? "unknown"}` };
  const name = safeWorktreeName(nameInput);
  const branch = `loam/${name}`;
  const wtPath = path.join(folder, ".loam-worktrees", name);
  if (fs.existsSync(wtPath)) return { error: `worktree path already exists: ${wtPath}` };
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  try {
    await execFileAsync("git", ["-C", folder, "worktree", "add", "-b", branch, wtPath, "HEAD"], { ...execOpts, timeout: 60_000 });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { error: (e.stderr ?? e.message ?? "git worktree add failed").trim().slice(0, 300) };
  }
  return { ok: true, path: wtPath, branch };
}
