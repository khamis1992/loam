/** Sandboxed exec bridge — SANDBOX_RUNTIME_INTO_LOAM §7.2 (SP2). Wraps a shell
 *  command through the pinned ASRT library (L3) and returns annotated results.
 *  The session manager is injected by tests; production resolves it via
 *  openSrtSession (hash-verified pin, C1). Violations are attributed to a fresh
 *  ≥22-char unguessable commandId (§2.6) and audited ids-only (C3). */
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { srtAudit } from "./audit.js";
import { openSrtSession, __setSessionForTests } from "./session.js";
import type { SrtExecRequest, SrtExecResult, LoamSrtPolicy } from "./policy.js";

/** 128-bit hex — 32 chars, comfortably over the ≥22 requirement. */
export function newSrtCommandId(): string {
  return randomBytes(16).toString("hex");
}

const MAX_STREAM_BYTES = 512 * 1024;

/** Kill the process tree on timeout/cancel (Windows grandchildren otherwise survive). */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } catch { /* already gone */ }
}

export async function execInSandbox(
  req: SrtExecRequest,
  policy: LoamSrtPolicy,
  workspace: string,
  toolName = "shell_run",
): Promise<SrtExecResult> {
  const commandId = req.commandId ?? newSrtCommandId();
  const started = Date.now();
  const mod = await openSrtSession(policy, workspace);
  const violationsBefore = mod.SandboxManager.getSandboxViolationStore().getTotalCount();

  const { argv, env } = await mod.SandboxManager.wrapWithSandboxArgv(req.command, undefined, undefined, req.signal, req.cwd, { commandId });

  return await new Promise<SrtExecResult>((resolve) => {
    const child = spawn(argv[0] ?? "cmd.exe", argv.slice(1), {
      cwd: req.cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: false,
      signal: req.signal,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = req.timeoutMs && req.timeoutMs > 0
      ? setTimeout(() => { timedOut = true; killTree(child.pid); }, req.timeoutMs)
      : undefined;
    const clip = (s: string, chunk: Buffer): string => (s.length > MAX_STREAM_BYTES ? s : s + chunk.toString("utf8"));
    child.stdout?.on("data", (d: Buffer) => { stdout = clip(stdout, d); });
    child.stderr?.on("data", (d: Buffer) => { stderr = clip(stderr, d); });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      srtAudit().append({ name: "srt_exec", outcome: "failed", commandId, toolName, cwd: req.cwd, durationMs: Date.now() - started, sandboxed: true, detail: err.message.slice(0, 160) });
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut: false, sandboxed: true, commandId, annotatedStderr: stderr, violationCount: 0 });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const violations = Math.max(0, mod.SandboxManager.getSandboxViolationStore().getTotalCount() - violationsBefore);
      const annotatedStderr = mod.SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr);
      srtAudit().append({
        name: "srt_exec",
        outcome: code === 0 && !timedOut ? "completed" : "failed",
        commandId, toolName, cwd: req.cwd, exitCode: code, timedOut, sandboxed: true,
        durationMs: Date.now() - started, violationCount: violations,
      });
      if (violations > 0) {
        srtAudit().append({ name: "srt_violation", outcome: "warned", commandId, violationCount: violations });
      }
      resolve({ code, stdout, stderr, timedOut, sandboxed: true, commandId, annotatedStderr, violationCount: violations });
    });
  });
}

/** Test seam: install a fabricated pinned module (never used in production). */
export { __setSessionForTests };
