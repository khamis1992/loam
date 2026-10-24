import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Optional history for the wiki. The installer does not ship git, so every call
 * degrades to "no history" instead of failing; the markdown files are the
 * source of truth either way. Local only: no remotes, no push.
 */
let available: boolean | undefined;

function run(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=NUL", "-c", "core.fsmonitor=false", "-c", "credential.helper=", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1_000_000,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  }).trim();
}

export function gitAvailable(): boolean {
  if (available !== undefined) return available;
  try {
    run(process.cwd(), ["--version"]);
    available = true;
  } catch {
    available = false;
  }
  return available;
}

/** Commit every change under `root`. Returns false when git is missing or there was nothing to commit. */
export function commitAll(root: string, message: string): boolean {
  if (!gitAvailable()) return false;
  try {
    if (!fs.existsSync(path.join(root, ".git"))) run(root, ["init"]);
    fs.writeFileSync(path.join(root, ".gitignore"), ".index.sqlite*\n");
    run(root, ["add", "-A"]);
    if (!run(root, ["status", "--porcelain"])) return false;
    run(root, ["-c", "user.name=Loam", "-c", "user.email=loam@localhost", "commit", "-m", message.slice(0, 160)]);
    return true;
  } catch {
    return false;
  }
}

export function history(root: string, rel: string, limit = 10): string[] {
  if (!gitAvailable() || !fs.existsSync(path.join(root, ".git"))) return [];
  try {
    return run(root, ["log", `-${Math.min(limit, 50)}`, "--format=%h %ad %s", "--date=short", "--", rel]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
