import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { rootAsset } from "../../config.js";

/** agent-desktop release pin. Updating = bump version + BOTH sha256 values in
 *  one commit; never `@latest`, never the npm package's postinstall. */
export const AD_VERSION_PIN = "1.0.2";
export const AD_ASSET = "agent-desktop-v1.0.2-x86_64-pc-windows-msvc.tar.gz";
export const AD_RELEASE_BASE = "https://github.com/vercel-labs/agent-desktop/releases/download/v1.0.2/";
export const AD_TARBALL_SHA256 = "2186c76e7df197c0e67365e45d36d869f74714c56bb8a73817e2a66f3e18e222";
export const AD_EXE_SHA256 = "409e58cbdd6aed47e29771ffa60bc122a9843505a227af488cded85215943988";

/** Dev checkout: <repo>/resources/agent-desktop/agent-desktop.exe. Packaged:
 *  app.asar.unpacked/resources/agent-desktop/agent-desktop.exe (rootAsset picks
 *  the unpacked copy). LOAM_AGENT_DESKTOP_EXE overrides — tests and local dev
 *  only, where the sha check is skipped on purpose. */
export function adExePath(resourcesDir?: string): string {
  if (process.env.LOAM_AGENT_DESKTOP_EXE) return process.env.LOAM_AGENT_DESKTOP_EXE;
  if (resourcesDir) return path.join(resourcesDir, "agent-desktop", "agent-desktop.exe");
  return rootAsset("resources", "agent-desktop", "agent-desktop.exe");
}

interface VerifyResult {
  exe: string;
  ok: boolean;
  reason?: string;
}

let cache: VerifyResult | null = null;

/** Verify the pinned binary exists and matches the pinned sha256. Cached per
 *  path; an explicit LOAM_AGENT_DESKTOP_EXE override is trusted (fake exe in
 *  tests, local builds in dev). */
export function verifyAdBinary(exe: string): VerifyResult {
  if (cache?.exe === exe) return cache;
  if (!fs.existsSync(exe)) {
    cache = { exe, ok: false, reason: "binary missing" };
    return cache;
  }
  if (process.env.LOAM_AGENT_DESKTOP_EXE) {
    cache = { exe, ok: true };
    return cache;
  }
  const hash = crypto.createHash("sha256").update(fs.readFileSync(exe)).digest("hex");
  cache = hash === AD_EXE_SHA256 ? { exe, ok: true } : { exe, ok: false, reason: `sha256 mismatch ${hash}` };
  return cache;
}

/** Tests only: drop the memo so a new exe path or file content is re-checked. */
export function _resetAdBinaryCache(): void {
  cache = null;
}

/** agent-desktop state root: %APPDATA%\Loam\agent-desktop by default; sessions
 *  older than 7 days are removed at startup by the caller. */
export function resolveStateRoot(configured: string | undefined, appData: string = process.env.APPDATA ?? ""): string {
  if (configured && configured.trim()) return path.resolve(configured);
  return path.join(appData, "Loam", "agent-desktop");
}
