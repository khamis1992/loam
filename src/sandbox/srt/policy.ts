/** Sandbox Runtime (ASRT / srt) policy + types — SANDBOX_RUNTIME_INTO_LOAM_INTEGRATION
 *  §6.3, §6.7, §8 (repo appendix C1/C8). The library itself is NEVER a production
 *  dependency: it resolves at runtime from the data-dir pin (install verified by
 *  scripts/install-srt.mjs against the triple hash below). L3 containment only —
 *  Loam's permission modes, checkCommand and riskTiers (L0–L2) stay authoritative. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../config.js";

export const SRT_PACKAGE = "@anthropic-ai/sandbox-runtime";
export const SRT_VERSION_PIN = "0.0.81";
/** npm tarball sha256 (spec §6.7, OBSERVED on the analysis box 2026-10-25). */
export const SRT_TARBALL_SHA256 = "0e0b8249062047f7b592c7995f8ec2f251f3bbebdc0402db1ee23af09983953f";
/** Vendored Windows helper hashes (both arches ship in the package). */
export const SRT_WIN_X64_SHA256 = "a8e22bc098ac1146ec9b9151d5f1770c05b897cd1ac588161e1287a248cc9176";
export const SRT_WIN_ARM64_SHA256 = "c7b204c8fab94059dbf7a6a805b844abad3deb82614e07e4b8d4b5bb5c4374f7";
export const SRT_WIN_X64_BYTES = 4_020_736;
export const SRT_WIN_ARM64_BYTES = 3_598_336;
/** ASRT's loopback proxy port range (§2.2); kept as a fallback for defensive probes. */
export const DEFAULT_WINDOWS_PROXY_PORT_RANGE_FALLBACK: readonly [number, number] = [60080, 60089];

/** Where the verified pin lives — outside every workspace allowWrite root (§6.5). */
export function srtPinRoot(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, "bin", "srt", SRT_VERSION_PIN);
}
/** The pinned library entrypoint (dynamic-import target; C1 — never a prod dep). */
export function srtPackageEntry(dataDir: string = DATA_DIR): string {
  return path.join(srtPinRoot(dataDir), "node_modules", SRT_PACKAGE, "dist", "index.js");
}
/** The pinned srt CLI (used by windows-install and the MCP stdio wrap). */
export function srtCliEntry(dataDir: string = DATA_DIR): string {
  return path.join(srtPinRoot(dataDir), "node_modules", SRT_PACKAGE, "dist", "cli.js");
}
/** Vendored helper per arch — package layout vendor/srt-win/<arch>/srt-win.exe. */
export function srtWinExePath(arch: string = process.arch, dataDir: string = DATA_DIR): string {
  return path.join(srtPinRoot(dataDir), "node_modules", SRT_PACKAGE, "vendor", "srt-win", arch, "srt-win.exe");
}
export function srtWinSha256(arch: string = process.arch): string {
  return arch === "arm64" ? SRT_WIN_ARM64_SHA256 : SRT_WIN_X64_SHA256;
}
export function srtWinBytes(arch: string = process.arch): number {
  return arch === "arm64" ? SRT_WIN_ARM64_BYTES : SRT_WIN_X64_BYTES;
}

/** Verify the data-dir pin for the running arch: entry exists + vendored helper
 *  size and sha256 match. A mismatch must DISABLE the sandbox (§6.7) — never run
 *  an unverified srt-win.exe. Pure filesystem check; no library import. */
export function verifySrtPin(dataDir: string = DATA_DIR, arch: string = process.arch): { ok: boolean; reason?: string; srtWin: string } {
  const srtWin = srtWinExePath(arch, dataDir);
  const entry = srtPackageEntry(dataDir);
  if (!fs.existsSync(entry)) return { ok: false, reason: "pin-entry-missing", srtWin };
  try {
    const stat = fs.statSync(srtWin);
    if (stat.size !== srtWinBytes(arch)) return { ok: false, reason: "srt-win-size-mismatch", srtWin };
    const got = createHash("sha256").update(fs.readFileSync(srtWin)).digest("hex");
    if (got !== srtWinSha256(arch)) return { ok: false, reason: "srt-win-sha256-mismatch", srtWin };
  } catch {
    return { ok: false, reason: "srt-win-missing", srtWin };
  }
  return { ok: true, srtWin };
}

/** §6.5: the pin must never live inside a workspace the sandbox itself can write —
 *  a sandboxed process could otherwise rewrite ASRT. Refuse when contained. */
export function isPinInsideWorkspace(workspace: string, dataDir: string = DATA_DIR): boolean {
  const rel = path.relative(path.resolve(workspace), path.resolve(srtPinRoot(dataDir)));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
/** Loam's own ASRT settings file (NOT ~/.srt-settings.json — §7.5, no Claude Code clash). */
export function srtSettingsFile(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, "srt", "loam-srt-settings.json");
}
/** Append-only audit trail (appendix C3). */
export function srtAuditPath(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, "srt", "audit.jsonl");
}

export type SrtExecMode = "off" | "untrusted_only" | "all_shell";

/** Flat Loam policy → mapped onto the ASRT SandboxRuntimeConfig at session open. */
export interface LoamSrtPolicy {
  mode: SrtExecMode;
  strictAllowlist: boolean;
  allowedDomains: string[];
  denyRead: string[];
  allowRead: string[];
  allowWrite: string[];
  denyWrite: string[];
  allowLocalBinding: boolean;
  timeoutMs: number;
}

/** Default-deny posture (§6.3): empty allowlist = no egress at all; credential
 *  directories unreadable; .env-style files unwritable. Workspace roots are added
 *  to allowRead/allowWrite by the session opener. */
export const DEFAULT_LOAM_SRT_POLICY: LoamSrtPolicy = {
  mode: "off", // OD-1: stays off until the W-checklist passes; flip is Khamis's call
  strictAllowlist: true,
  allowedDomains: [],
  denyRead: [
    "~/.ssh",
    "~/.gnupg",
    "~/.aws",
    "~/.azure",
    "~/.kube",
    "~/.docker",
    "~/.config/gh",
    "~/.config/gcloud",
  ],
  allowRead: ["."],
  allowWrite: ["."],
  denyWrite: [".env", ".env.local", ".env.*", "**/.env", "**/.env.*"],
  allowLocalBinding: false, // OD-5
  timeoutMs: 120_000,
};

/** Probe shape returned by the status endpoint (SP1). */
export interface SrtSessionStatus {
  enabled: boolean;
  platformSupported: boolean;
  /** Pin verification result — a mismatch disables the sandbox (§6.7). */
  pinVerified: boolean;
  pinVersion: typeof SRT_VERSION_PIN;
  windowsInstalled: boolean | "n/a";
  windowsMessage?: string;
  proxyPortRange: readonly [number, number];
}

export interface SrtExecRequest {
  command: string;
  cwd: string;
  /** ≥22 chars of unguessable randomness (128-bit) for violation attribution (§2.6). */
  commandId?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SrtExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  sandboxed: boolean;
  commandId: string;
  annotatedStderr: string;
  violationCount: number;
}

/** C6 semantics: should this shell_run be contained? `untrusted_only` exempts runs
 *  whose permission mode is the user's explicit full trust; `all_shell` never exempts. */
export function shouldSandboxCommand(mode: SrtExecMode, permissionMode: string | undefined): boolean {
  if (mode === "off") return false;
  if (mode === "all_shell") return true;
  return permissionMode !== "full_access";
}

/** Validate user-provided settings fragments before they reach the policy. */
export function normalizeSrtMode(value: unknown): SrtExecMode {
  return value === "untrusted_only" || value === "all_shell" ? value : "off";
}

export function normalizeDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const d of value) {
    if (typeof d !== "string") continue;
    const t = d.trim().toLowerCase();
    if (t.length > 0 && t.length <= 253 && /^[a-z0-9*._:-]+$/.test(t)) seen.add(t);
  }
  return [...seen].sort();
}

/** Merge persisted user settings onto the default policy (never widens deny lists). */
export function resolveSrtPolicy(user: {
  sandboxMode?: unknown;
  sandboxAllowedDomains?: unknown;
  skipProfileGrant?: boolean;
}): LoamSrtPolicy {
  const domains = normalizeDomains(user.sandboxAllowedDomains);
  return {
    ...DEFAULT_LOAM_SRT_POLICY,
    mode: normalizeSrtMode(user.sandboxMode),
    ...(domains.length > 0 ? { allowedDomains: domains } : {}),
  };
}
