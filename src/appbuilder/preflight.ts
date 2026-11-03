// src/appbuilder/preflight.ts
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface PreflightItem {
  id: "node" | "npm" | "git" | "disk";
  ok: boolean;
  found: string | null;     // version string or free bytes
  need: string;
  fix: string;              // one sentence the UI shows; never run automatically
}

export interface PreflightReport { ok: boolean; items: PreflightItem[]; checkedAt: string }

export const MIN_NODE: [number, number] = [22, 13];
export const MIN_GIT: [number, number] = [2, 38];
export const MIN_FREE_BYTES = 2 * 1024 ** 3;

function atLeast(v: string, min: [number, number]): boolean {
  const m = /(\d+)\.(\d+)/.exec(v);
  if (!m) return false;
  const [maj, minr] = [Number(m[1]), Number(m[2])];
  return maj > min[0] || (maj === min[0] && minr >= min[1]);
}

async function version(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args, { windowsHide: true, timeout: 10_000, shell: process.platform === "win32" && cmd.endsWith(".cmd") });
    return stdout.trim();
  } catch {
    return null;
  }
}

export function appBuilderDataDir(): string {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "loam", "appbuilder");
}

export async function runPreflight(): Promise<PreflightReport> {
  const node = await version("node", ["--version"]);
  const npm = await version(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"]);
  const git = await version("git", ["--version"]);
  const dir = appBuilderDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const st = fs.statfsSync(dir);
  const free = Number(st.bavail) * Number(st.bsize);
  const items: PreflightItem[] = [
    { id: "node", ok: !!node && atLeast(node, MIN_NODE), found: node, need: "22.13 or newer", fix: "Install Node.js 22 LTS or newer from nodejs.org, or run: winget install OpenJS.NodeJS.LTS" },
    { id: "npm", ok: !!npm, found: npm, need: "any version that ships with Node 22", fix: "npm ships with Node.js. Reinstall Node.js and keep the npm option selected." },
    { id: "git", ok: !!git && atLeast(git, MIN_GIT), found: git, need: "2.38 or newer", fix: "Install Git for Windows from git-scm.com, or run: winget install Git.Git" },
    { id: "disk", ok: free >= MIN_FREE_BYTES, found: String(free), need: "2 GB free", fix: `Free at least 2 GB on the drive that holds ${dir}.` },
  ];
  return { ok: items.every((i) => i.ok), items, checkedAt: new Date().toISOString() };
}
