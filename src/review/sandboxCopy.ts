import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SKIP = new Set([".git", "dist", "build", "coverage", ".next", "out"]);
const LINK = new Set(["node_modules", ".venv", "venv", "vendor"]);

export interface CopyResult {
  dir: string;
  files: number;
  bytes: number;
}

export function reviewPrefix(): string {
  return path.join(os.tmpdir(), "loam-review-");
}

export function copyWorkspace(source: string, runId: string, limits = { maxFiles: 3000, maxBytes: 64 * 1024 * 1024 }): CopyResult | { skipped: "too_large" } {
  const safeId = runId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "run";
  const dir = path.join(os.tmpdir(), `loam-review-${safeId}`);
  if (fs.existsSync(dir)) removeCopy(dir);
  fs.mkdirSync(dir, { recursive: true });
  const tally = { files: 0, bytes: 0 };
  try {
    copyInto(source, dir, source, limits, tally);
  } catch (error) {
    removeCopy(dir);
    if (error instanceof Error && error.message === "too_large") return { skipped: "too_large" };
    throw error;
  }
  for (const name of LINK) {
    const target = path.join(source, name);
    if (!fs.existsSync(target)) continue;
    const link = path.join(dir, name);
    if (fs.existsSync(link)) continue;
    fs.symlinkSync(target, link, "junction");
  }
  return { dir, files: tally.files, bytes: tally.bytes };
}

function copyInto(from: string, to: string, root: string, limits: { maxFiles: number; maxBytes: number }, tally: { files: number; bytes: number }): void {
  for (const name of fs.readdirSync(from)) {
    if (SKIP.has(name) || LINK.has(name)) continue;
    const src = path.join(from, name);
    const dest = path.join(to, name);
    const stat = fs.lstatSync(src);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyInto(src, dest, root, limits, tally);
      continue;
    }
    if (!stat.isFile()) continue;
    tally.files += 1;
    tally.bytes += stat.size;
    if (tally.files > limits.maxFiles || tally.bytes > limits.maxBytes) throw new Error("too_large");
    fs.copyFileSync(src, dest);
  }
}

export function removeCopy(dir: string): void {
  const prefix = reviewPrefix();
  const resolved = path.resolve(dir);
  const same = process.platform === "win32"
    ? resolved.toLowerCase().startsWith(prefix.toLowerCase())
    : resolved.startsWith(prefix);
  if (!same) throw new Error("refusing to delete outside the review prefix");
  for (const name of LINK) {
    const link = path.join(resolved, name);
    try {
      const stat = fs.lstatSync(link);
      if (stat.isSymbolicLink()) fs.unlinkSync(link);
    } catch { /* absent */ }
  }
  deleteTree(resolved);
}

function isReparsePoint(target: string): boolean {
  try {
    fs.readlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

function deleteTree(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const child = path.join(dir, name);
    if (isReparsePoint(child)) {
      fs.unlinkSync(child);
      continue;
    }
    const stat = fs.lstatSync(child);
    if (stat.isDirectory()) deleteTree(child);
    else fs.rmSync(child, { force: true });
  }
  fs.rmdirSync(dir);
}
