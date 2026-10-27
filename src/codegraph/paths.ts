import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GRAPHIFY_PIN, type CodeGraphConfig } from "./config.js";

/**
 * Engine home. Machine-local (LOCALAPPDATA), not roaming: the venv is ~200 MB
 * and graphs are regenerable caches. Layout:
 *   <home>/runtime/<version>/venv/            pinned graphifyy + deps
 *   <home>/runtime/<version>/python/          uv-managed CPython (when Loam provisions it)
 *   <home>/projects/<projectId>/graphify-out/ graph.json, manifest.json, cache/ (graphify --out target)
 *   <home>/projects/<projectId>/loam-index.json
 *   <home>/mcp-cwd/                           empty dir; MCP server cwd (multi-project mode)
 *   <home>/audit.jsonl
 */
export function codeGraphHome(cfg: Pick<CodeGraphConfig, "home">, platform: NodeJS.Platform = process.platform): string {
  if (cfg.home && cfg.home.trim()) return path.resolve(cfg.home);
  const env = process.env.LOAM_CODEGRAPH_HOME;
  if (env && env.trim()) return path.resolve(env);
  if (platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "Loam", "codegraph");
  }
  return path.join(os.homedir(), ".local", "share", "loam", "codegraph");
}

export function runtimeDir(home: string): string {
  return path.join(home, "runtime", GRAPHIFY_PIN.version);
}

export function venvDir(home: string): string {
  return path.join(runtimeDir(home), "venv");
}

/** Executables inside the venv. Windows uses Scripts\*.exe (console-script shims). */
export function engineExecutables(home: string, platform: NodeJS.Platform = process.platform): { python: string; graphify: string; graphifyMcp: string } {
  const venv = process.env.LOAM_CODEGRAPH_VENV?.trim() ? path.resolve(process.env.LOAM_CODEGRAPH_VENV) : venvDir(home);
  if (platform === "win32") {
    const s = path.join(venv, "Scripts");
    return { python: path.join(s, "python.exe"), graphify: path.join(s, "graphify.exe"), graphifyMcp: path.join(s, "graphify-mcp.exe") };
  }
  const b = path.join(venv, "bin");
  return { python: path.join(b, "python"), graphify: path.join(b, "graphify"), graphifyMcp: path.join(b, "graphify-mcp") };
}

/** Canonical project root: realpath, forward-slash-free compare key lowercased on Windows. */
export function canonicalRoot(root: string, platform: NodeJS.Platform = process.platform): string {
  let r = path.resolve(root);
  try {
    r = fs.realpathSync.native(r);
  } catch {
    /* keep resolved path; existence is checked by the caller */
  }
  return platform === "win32" ? r.toLowerCase() : r;
}

/** Stable 16-hex project id derived from the canonical root. */
export function projectIdFor(root: string, platform: NodeJS.Platform = process.platform): string {
  return createHash("sha256").update(canonicalRoot(root, platform)).digest("hex").slice(0, 16);
}

/** graphify --out target; graphify writes <storeDir>/graphify-out/ (OBSERVED: scan root left untouched). */
export function projectStoreDir(home: string, projectId: string): string {
  return path.join(home, "projects", projectId);
}

export function graphJsonPath(storeDir: string): string {
  return path.join(storeDir, "graphify-out", "graph.json");
}

export function recordPath(storeDir: string): string {
  return path.join(storeDir, "loam-index.json");
}

export function mcpCwd(home: string): string {
  return path.join(home, "mcp-cwd");
}

export function auditPath(home: string): string {
  return path.join(home, "audit.jsonl");
}

/** True when `child` is `parent` or inside it (case-insensitive on Windows). */
export function isInsideOrEqual(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string): string => (platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
