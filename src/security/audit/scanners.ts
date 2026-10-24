/** Phase 0 scanner adapters. Each CLI runs as a separate process (argv array, no shell); failures never block a run. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dedupeHits, sarifToHits } from "./sarif.js";
import { runPkgIntel } from "../native/pkgintel/index.js";
import { runScaScan, toSarif } from "../native/sca/osvClient.js";
import type { FetchFn } from "../native/sca/osvClient.js";
import { runSecretsScan } from "../native/secrets/index.js";
import { runJazzerScan } from "../native/fuzz/run.js";
import type { ReconHit, ScannerTool } from "./types.js";

export type ScannerStatus = "ok" | "unavailable" | "tool_error" | "timeout" | "skipped";
export interface ScannerReport {
  tool: ScannerTool;
  status: ScannerStatus;
  hitCount: number;
  detail?: string;
}
export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}
export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the executable could not be started (not installed). */
  spawnError?: string;
}
export type Exec = (exe: string, argv: string[], opts: ExecOptions) => Promise<ExecResult>;

export interface Adapter {
  tool: ScannerTool;
  exe: string;
  /** One or more invocations; each yields SARIF either in `outFile` or on stdout. */
  plan(target: string, scratch: string): { argv: string[]; outFile?: string; guard?: () => boolean }[];
  /** Exit codes that still carry results. */
  okCodes: number[];
  /** Why the adapter skipped everything (all guards false); default "no applicable manifest". */
  skipDetail?: () => string;
}

const has = (target: string, rel: string): boolean => fs.existsSync(path.join(target, rel));

/** Live scan target for DAST tools (nuclei). Opt-in: only an explicit http(s) URL counts. */
export function liveScanTarget(src: NodeJS.ProcessEnv = process.env): string | null {
  const v = src.LOAM_AUDIT_LIVE_TARGET;
  return typeof v === "string" && /^https?:\/\//i.test(v) ? v : null;
}

export const ADAPTERS: Record<string, Adapter> = {
  gitleaks: {
    tool: "gitleaks", exe: "gitleaks", okCodes: [0, 1],
    plan: (t, s) => [{
      argv: ["detect", "--source", t, "--no-git", "--report-format", "sarif", "--report-path", path.join(s, "gitleaks.sarif"), "--redact", "--exit-code", "0"],
      outFile: path.join(s, "gitleaks.sarif"),
    }],
  },
  osv: {
    tool: "osv", exe: "osv-scanner", okCodes: [0, 1],
    plan: (t, s) => [{
      argv: has(t, "package-lock.json")
        ? ["scan", "source", "--lockfile", path.join(t, "package-lock.json"), "--format", "sarif", "--output", path.join(s, "osv.sarif")]
        : ["scan", "source", "-r", t, "--format", "sarif", "--output", path.join(s, "osv.sarif")],
      outFile: path.join(s, "osv.sarif"),
    }],
  },
  guarddog: {
    tool: "guarddog", exe: "guarddog", okCodes: [0, 1],
    plan: (t) => [
      { argv: ["pypi", "verify", path.join(t, "requirements.txt"), "--output-format", "sarif"], guard: () => has(t, "requirements.txt") },
      { argv: ["npm", "verify", path.join(t, "package.json"), "--output-format", "sarif"], guard: () => has(t, "package.json") },
    ],
  },
  opengrep: {
    tool: "opengrep", exe: "opengrep", okCodes: [0, 1],
    plan: (t, s) => [{
      argv: ["scan", "--config", path.join(ruleDir(), "loam"), "--sarif", "--output", path.join(s, "opengrep.sarif"), "--error=false", t],
      outFile: path.join(s, "opengrep.sarif"),
    }],
  },
  trivy: {
    tool: "trivy", exe: "trivy", okCodes: [0],
    plan: (t, s) => [{
      argv: ["fs", "--format", "sarif", "--output", path.join(s, "trivy.sarif"), "--exit-code", "0", "--scanners", "vuln,misconfig,secret", t],
      outFile: path.join(s, "trivy.sarif"),
    }],
  },
  nuclei: {
    tool: "nuclei", exe: "nuclei", okCodes: [0],
    plan: (t, s) => [{
      argv: ["-u", liveScanTarget()!, "-sarif-export", path.join(s, "nuclei.sarif"), "-silent", "-nc"],
      outFile: path.join(s, "nuclei.sarif"),
      guard: () => liveScanTarget() !== null,
    }],
    skipDetail: () => "no live target configured (set LOAM_AUDIT_LIVE_TARGET to an http(s) URL)",
  },
};

/** In-process scanners: no executable to install, so they are always available. */
type NativeRun = (target: string, fetchFn?: FetchFn) => Promise<{ hits: ReconHit[]; sarif?: unknown; error?: string; notes?: string[] }>;
export const NATIVE: Record<string, NativeRun> = {
  "loam-secrets": async (t) => runSecretsScan(t),
  "loam-sca": async (t, fetchFn) => {
    const r = await runScaScan(t, fetchFn ? { fetchFn } : {});
    return {
      hits: r.hits, sarif: toSarif(r.hits),
      ...(r.error ? { error: r.error } : {}), ...(r.notes?.length ? { notes: r.notes } : {}),
    };
  },
  "loam-pkg": async (t) => ({ hits: runPkgIntel(t) }),
};

/** Directory holding `loam/*.yml` rules. Overridable for tests and packaging. */
let rulesRoot = path.resolve(process.cwd(), "rules");
export const ruleDir = (): string => rulesRoot;
export function setRuleDir(dir: string): void {
  rulesRoot = dir;
}

const ENV_ALLOW = ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG"];
export function scrubbedEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOW) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

export const defaultExec: Exec = (exe, argv, opts) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, argv, { cwd: opts.cwd, shell: false, windowsHide: true, env: scrubbedEnv() });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: String(e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const kill = (): void => {
      try { child.kill(); } catch { /* already gone */ }
    };
    const done = (r: Partial<ExecResult> & { code: number | null }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      resolve({ stdout, stderr, timedOut, ...r });
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    opts.signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < opts.maxBytes) stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < 20_000) stderr += d.toString(); });
    child.on("error", (err) => done({ code: null, spawnError: String(err) }));
    child.on("close", (code) => done({ code }));
  });

export interface ScanContext {
  target: string;
  scratch: string;
  tools: string[];
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  exec?: Exec;
  /** Network seam for the native SCA scanner (tests inject a fake). */
  fetchFn?: FetchFn;
}
export interface ScanOutcome {
  hits: ReconHit[];
  reports: ScannerReport[];
  /** Merged SARIF documents, one per scanner that produced output. */
  sarif: { tool: ScannerTool; doc: unknown }[];
}

export async function runScanners(ctx: ScanContext): Promise<ScanOutcome> {
  const exec = ctx.exec ?? defaultExec;
  const hits: ReconHit[] = [];
  const reports: ScannerReport[] = [];
  const sarif: ScanOutcome["sarif"] = [];
  fs.mkdirSync(ctx.scratch, { recursive: true });
  for (const name of ctx.tools) {
    const native = NATIVE[name];
    if (native) {
      if (ctx.signal?.aborted) {
        reports.push({ tool: name as ScannerTool, status: "skipped", hitCount: 0, detail: "cancelled" });
        continue;
      }
      try {
        const r = await native(ctx.target, ctx.fetchFn);
        const deduped = dedupeHits(r.hits);
        hits.push(...deduped);
        if (r.sarif) sarif.push({ tool: name as ScannerTool, doc: r.sarif });
        const detail = [r.error, ...(r.notes ?? [])].filter(Boolean).join("; ") || undefined;
        reports.push({ tool: name as ScannerTool, status: r.error ? "tool_error" : "ok", hitCount: deduped.length, ...(detail ? { detail } : {}) });
      } catch (e) {
        reports.push({ tool: name as ScannerTool, status: "tool_error", hitCount: 0, detail: String(e).slice(0, 200) });
      }
      continue;
    }
    if (name === "jazzer") {
      if (ctx.signal?.aborted) {
        reports.push({ tool: "jazzer", status: "skipped", hitCount: 0, detail: "cancelled" });
        continue;
      }
      try {
        // Dynamic proof stays gated on the sandbox ([U2]); jazzer only runs when explicitly listed in tools.
        const r = await runJazzerScan({ target: ctx.target, scratch: ctx.scratch, timeoutMs: ctx.timeoutMs, signal: ctx.signal, exec });
        hits.push(...r.hits);
        reports.push(...r.reports);
        if (r.sarif) sarif.push(r.sarif);
      } catch (e) {
        reports.push({ tool: "jazzer", status: "tool_error", hitCount: 0, detail: String(e).slice(0, 200) });
      }
      continue;
    }
    const adapter = ADAPTERS[name];
    if (!adapter) {
      reports.push({ tool: name as ScannerTool, status: "skipped", hitCount: 0, detail: "no adapter in this build" });
      continue;
    }
    if (ctx.signal?.aborted) {
      reports.push({ tool: adapter.tool, status: "skipped", hitCount: 0, detail: "cancelled" });
      continue;
    }
    const toolHits: ReconHit[] = [];
    let status: ScannerStatus = "ok";
    let detail: string | undefined;
    let ran = 0;
    for (const step of adapter.plan(ctx.target, ctx.scratch)) {
      if (step.guard && !step.guard()) continue;
      ran++;
      const r = await exec(adapter.exe, step.argv, {
        cwd: ctx.scratch, timeoutMs: ctx.timeoutMs ?? 120_000, maxBytes: ctx.maxBytes ?? 20_000_000, signal: ctx.signal,
      });
      if (r.spawnError) { status = "unavailable"; detail = r.spawnError.slice(0, 200); break; }
      if (r.timedOut) { status = "timeout"; detail = "wall-clock limit"; break; }
      if (r.code === null || !adapter.okCodes.includes(r.code)) {
        status = "tool_error"; detail = `exit ${r.code}: ${r.stderr.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? ""}`;
        break;
      }
      let text = r.stdout;
      if (step.outFile) {
        try { text = fs.readFileSync(step.outFile, "utf8"); } catch { text = ""; }
      }
      if (!text.trim()) continue;
      let doc: unknown;
      try { doc = JSON.parse(text); } catch {
        status = "tool_error"; detail = "malformed SARIF"; break;
      }
      const parsed = sarifToHits(doc, adapter.tool);
      toolHits.push(...parsed.hits);
      sarif.push({ tool: adapter.tool, doc });
    }
    if (ran === 0 && status === "ok") { status = "skipped"; detail = adapter.skipDetail?.() ?? "no applicable manifest"; }
    const deduped = dedupeHits(toolHits);
    hits.push(...deduped);
    reports.push({ tool: adapter.tool, status, hitCount: deduped.length, ...(detail ? { detail } : {}) });
  }
  return { hits: dedupeHits(hits), reports, sarif };
}
