/** Repo-relative path syntax and run-file reading shared by the validators. */
import fs from "node:fs";
import path from "node:path";
import { readBounded, safeRead, captureRootIdentity } from "./safeRead.js";
import type { ReadEnv, SafeReadResult } from "./safeRead.js";
import type { Assurance } from "./types.js";

/** Null when acceptable. Repo paths are POSIX-style, relative, with no dot segments. */
export function checkRepoPath(p: unknown): string | null {
  if (typeof p !== "string" || p.length === 0) return "empty path";
  if (/^[A-Za-z]:/.test(p)) return "drive path";
  if (p.startsWith("/") || p.startsWith("\\")) return "absolute or UNC path";
  if (p.includes("\\")) return "backslash";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return "control character";
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return `bad segment "${seg}"`;
  }
  return null;
}

export function envFor(platform?: NodeJS.Platform): ReadEnv | undefined {
  if (!platform) return undefined;
  return { platform, constants: platform === "win32" ? { O_RDONLY: 0 } : fs.constants };
}

export function readRunFile(runDir: string, name: string, maxBytes: number, platform?: NodeJS.Platform): SafeReadResult {
  return readBounded(path.join(runDir, name), maxBytes, envFor(platform));
}

export function readRunRel(runDir: string, rel: string, maxBytes: number, platform?: NodeJS.Platform): SafeReadResult {
  let id;
  try {
    id = captureRootIdentity(runDir);
  } catch (e) {
    return { ok: false, step: "root-identity", detail: (e as Error).message };
  }
  return safeRead(runDir, rel, id, { perFile: maxBytes, total: maxBytes }, 0, envFor(platform));
}

export const weakest = (list: Assurance[]): "full" | "reduced-win32" | "source-only" =>
  list.length === 0 ? "source-only" : list.includes("reduced-win32") ? "reduced-win32" : "full";
