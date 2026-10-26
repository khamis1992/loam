// src/appbuilder/depsCache.ts
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appBuilderDataDir } from "./preflight.js";
import { loadTemplate } from "./templates.js";
import type { AppProject } from "./types.js";

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const READY_MARKER = ".loam-ready";
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const COMMON = ["--no-audit", "--no-fund", "--ignore-scripts"];
const inFlight = new Map<string, Promise<DepsFolder>>();

export interface DepsFolder {
  dir: string;
  /** "created": first install wrote package-lock.json; "reused": folder was ready; "rebuilt": npm ci from the kept lockfile. */
  how: "created" | "reused" | "rebuilt";
}

function composedPackageJson(project: Pick<AppProject, "templateId" | "features">): string {
  const file = loadTemplate(project.templateId, project.features).files.find((f) => f.path === "package.json");
  if (!file) throw new Error("template has no package.json");
  return file.content;
}

export function depsDirFor(project: Pick<AppProject, "templateId" | "features">): string {
  const hash = crypto.createHash("sha256").update(composedPackageJson(project)).digest("hex").slice(0, 12);
  return path.join(appBuilderDataDir(), "deps", `${project.templateId}-${hash}`);
}

function npm(cwd: string, args: string[], onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(NPM, args, { cwd, windowsHide: true, shell: process.platform === "win32" });
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
    const feed = (b: Buffer) => { for (const l of b.toString("utf8").split(/\r?\n/)) if (l.trim()) onLine(l); };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("close", (code) => { clearTimeout(timer); resolve(code ?? 1); });
    child.on("error", () => { clearTimeout(timer); resolve(1); });
  });
}

async function build(project: Pick<AppProject, "templateId" | "features">, onLine: (line: string) => void): Promise<DepsFolder> {
  const dir = depsDirFor(project);
  const marker = path.join(dir, "node_modules", READY_MARKER);
  if (fs.existsSync(marker)) return { dir, how: "reused" };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), composedPackageJson(project), "utf8");
  const hasLock = fs.existsSync(path.join(dir, "package-lock.json"));
  let code: number;
  if (hasLock) {
    code = await npm(dir, ["ci", ...COMMON], onLine);
    if (code !== 0) code = await npm(dir, ["ci", "--offline", ...COMMON], onLine);
  } else {
    code = await npm(dir, ["install", ...COMMON], onLine);
    if (code !== 0) code = await npm(dir, ["install", "--offline", ...COMMON], onLine);
  }
  if (code !== 0) throw new Error("deps_install_failed");
  if (!fs.existsSync(path.join(dir, "package-lock.json"))) throw new Error("deps_lockfile_missing");
  fs.writeFileSync(marker, new Date().toISOString(), "utf8");
  return { dir, how: hasLock ? "rebuilt" : "created" };
}

/** Makes the shared deps folder ready. Concurrent callers for the same folder share one install. */
export function ensureDepsFolder(project: Pick<AppProject, "templateId" | "features">, onLine: (line: string) => void = () => undefined): Promise<DepsFolder> {
  const dir = depsDirFor(project);
  const running = inFlight.get(dir);
  if (running) return running;
  const p = build(project, onLine).finally(() => inFlight.delete(dir));
  inFlight.set(dir, p);
  return p;
}

/** Copies the kept lockfile into the project once, at scaffold time. Never overwrites a project lockfile. */
export function copyLockfileIntoProject(project: AppProject): void {
  const target = path.join(project.workspaceDir, project.appDir, "package-lock.json");
  if (fs.existsSync(target)) return;
  fs.copyFileSync(path.join(depsDirFor(project), "package-lock.json"), target);
}
