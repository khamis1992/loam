/** srt session lifecycle — SANDBOX_RUNTIME_INTO_LOAM §7.5–§7.6 (appendix C1).
 *  The library is loaded by dynamic import() from the data-dir pin AFTER
 *  verifySrtPin() passes — a hash mismatch disables the sandbox entirely
 *  («تعذّر التحقق من ملف العزل»). One session per process (spec design decision);
 *  filesystem-rule changes require close+reopen (Windows re-init semantics). */
import { pathToFileURL } from "node:url";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { log } from "../../log.js";
import { srtAudit } from "./audit.js";
import {
  DEFAULT_WINDOWS_PROXY_PORT_RANGE_FALLBACK,
  type LoamSrtPolicy,
  type SrtSessionStatus,
  isPinInsideWorkspace,
  srtPackageEntry,
  srtSettingsFile,
  srtWinExePath,
  verifySrtPin,
} from "./policy.js";
import fs from "node:fs";
import path from "node:path";

/** Type-only view of the pinned library (C1: types come from the exact devDep;
 *  the runtime module always comes from the pin path below). */
type SrtModule = typeof import("@anthropic-ai/sandbox-runtime");

interface SrtSessionState {
  mod: SrtModule;
  workspace: string;
  policy: LoamSrtPolicy;
  config: SandboxRuntimeConfig;
}

let session: SrtSessionState | undefined;
let loadFailure = "";

async function loadPinnedModule(): Promise<SrtModule> {
  const verify = verifySrtPin();
  if (!verify.ok) {
    loadFailure = verify.reason ?? "pin-verification-failed";
    throw new Error(`srt pin verification failed: ${loadFailure}`);
  }
  loadFailure = "";
  return import(pathToFileURL(srtPackageEntry()).href) as Promise<SrtModule>;
}

/** Map the flat Loam policy onto the ASRT config (§6.3), adding the workspace
 *  roots to allowRead/allowWrite. The literal "." from the flat policy maps to
 *  the workspace root itself — never the bridge process's cwd: a persistent ACL
 *  grant walks the whole write-root tree on first grant, and the repo (with
 *  node_modules) would blow the 600s timeout. Pure — exported for tests. */
export function buildSrtConfig(policy: LoamSrtPolicy, workspace: string, srtWinPath: string): SandboxRuntimeConfig {
  const scope = (paths: string[]): string[] => {
    const out = paths.filter((p) => p !== ".").map((p) => (p.startsWith("~/") ? p : p));
    return [...new Set([...out, workspace])];
  };
  return {
    network: {
      allowedDomains: [...policy.allowedDomains],
      deniedDomains: [],
      strictAllowlist: policy.strictAllowlist,
      allowLocalBinding: policy.allowLocalBinding,
    },
    filesystem: {
      denyRead: [...policy.denyRead],
      allowRead: scope(policy.allowRead),
      allowWrite: scope(policy.allowWrite),
      denyWrite: [...policy.denyWrite],
    },
    windows: {
      proxyPortRange: [...DEFAULT_WINDOWS_PROXY_PORT_RANGE_FALLBACK] as [number, number],
      srtWin: { path: srtWinPath },
    },
  };
}

/** Persist the CLI settings file used by MCP stdio wraps (§7.5). The CLI refuses
 *  to fall back to defaults when the file is invalid, so we always write complete. */
export function writeSrtSettingsFile(policy: LoamSrtPolicy, workspace: string, srtWinPath: string): string {
  const file = srtSettingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(buildSrtConfig(policy, workspace, srtWinPath), null, 2) + "\n", "utf8");
  return file;
}

/** Read-only probe: pin verification + Windows install status (no elevation;
 *  WFP status degrades to cannot-read for non-elevated callers — treated as
 *  "installed/unknown" rather than failure). */
export async function probeSrtStatus(): Promise<SrtSessionStatus> {
  const verify = verifySrtPin();
  if (!verify.ok) {
    return {
      enabled: false,
      platformSupported: process.platform === "win32",
      pinVerified: false,
      pinVersion: "0.0.81",
      windowsInstalled: false,
      windowsMessage: `تعذّر التحقق من ملف العزل (${verify.reason}) — أعد تشغيل node scripts/install-srt.mjs`,
      proxyPortRange: DEFAULT_WINDOWS_PROXY_PORT_RANGE_FALLBACK,
    };
  }
  try {
    const mod = await loadPinnedModule();
    const range = (mod as unknown as { DEFAULT_WINDOWS_PROXY_PORT_RANGE?: readonly [number, number] }).DEFAULT_WINDOWS_PROXY_PORT_RANGE
      ?? DEFAULT_WINDOWS_PROXY_PORT_RANGE_FALLBACK;
    let installed: boolean | "n/a" = "n/a";
    let message: string | undefined;
    if (process.platform === "win32") {
      try {
        const srtWin = mod.resolveSrtWin({ path: verify.srtWin });
        const status = await mod.checkWindowsSandboxStatusAsync({ srtWin });
        installed = status.user.provisioned && status.user.groupExists;
        if (!installed) message = "يلزم التثبيت مرة واحدة (زر «تثبيت عزل النظام»)";
      } catch (err) {
        installed = false;
        message = err instanceof Error ? err.message.slice(0, 160) : String(err);
      }
    }
    return {
      enabled: session !== undefined,
      platformSupported: process.platform === "win32",
      pinVerified: true,
      pinVersion: "0.0.81",
      windowsInstalled: installed,
      windowsMessage: message,
      proxyPortRange: range,
    };
  } catch (err) {
    return {
      enabled: false,
      platformSupported: process.platform === "win32",
      pinVerified: false,
      pinVersion: "0.0.81",
      windowsInstalled: false,
      windowsMessage: `تعذّر تحميل مكتبة العزل: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
      proxyPortRange: DEFAULT_WINDOWS_PROXY_PORT_RANGE_FALLBACK,
    };
  }
}

/** Open (or replace) the process session. Returns the manager for exec use.
 *  Hardening (§6.5/§6.6): refuses when the pin sits inside the sandboxed
 *  workspace; surfaces dependency warnings (residuals) as Arabic warnings. */
export async function openSrtSession(policy: LoamSrtPolicy, workspace: string): Promise<SrtModule> {
  if (isPinInsideWorkspace(workspace)) {
    srtAudit().append({ name: "srt_session_open", outcome: "denied", mode: policy.mode, detail: "pin-inside-workspace" });
    throw new Error("رفض تشغيل العزل: مثبّت srt يقع داخل مساحة العمل نفسها — انقل DATA_DIR خارج مساحة العمل (§6.5)");
  }
  if (session && session.workspace === workspace && JSON.stringify(session.policy) === JSON.stringify(policy)) {
    return session.mod;
  }
  await closeSrtSession();
  const mod = await loadPinnedModule();
  const srtWin = srtWinExePath();
  const config = buildSrtConfig(policy, workspace, srtWin);
  await mod.SandboxManager.initialize(config);
  writeSrtSettingsFile(policy, workspace, srtWin);
  session = { mod, workspace, policy, config };
  srtAudit().append({ name: "srt_session_open", outcome: "completed", mode: policy.mode, allowedDomainsCount: policy.allowedDomains.length, detail: workspace });
  // Dependency/residual warnings (anonymous-token, deny-only SID, Dnscache…) are
  // surfaced as warnings, never hard failures — matches the library's behaviour.
  if (process.platform === "win32") {
    try {
      const deps = await (mod as unknown as { checkWindowsDependenciesAsync?: (o: unknown) => Promise<{ errors?: unknown[]; warnings?: unknown[]; reinstallRequired?: boolean }> }).checkWindowsDependenciesAsync?.({ srtWin: mod.resolveSrtWin({ path: srtWin }) });
      if (deps?.errors?.length || deps?.reinstallRequired) {
        srtAudit().append({ name: "srt_session_open", outcome: "warned", mode: policy.mode, detail: `deps: ${(deps.errors ?? []).length} error(s), reinstallRequired=${!!deps.reinstallRequired}` });
      } else if (deps?.warnings?.length) {
        srtAudit().append({ name: "srt_session_open", outcome: "warned", mode: policy.mode, detail: `residuals: ${deps.warnings.length}` });
      }
    } catch { /* status probe is advisory */ }
  }
  log.info(`srt session open (mode=${policy.mode}, domains=${policy.allowedDomains.length})`);
  return mod;
}

export async function closeSrtSession(): Promise<void> {
  if (!session) return;
  const s = session;
  session = undefined;
  try {
    await s.mod.SandboxManager.reset();
  } catch { /* best effort */ }
  srtAudit().append({ name: "srt_session_close", outcome: "completed", mode: s.policy.mode });
}

export function srtSessionActive(): boolean {
  return session !== undefined;
}

/** Test hook: inject a fabricated session. */
export function __setSessionForTests(s: SrtSessionState | undefined): void {
  session = s;
}
