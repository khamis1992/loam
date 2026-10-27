import { spawn, execFile, type ChildProcess } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

/** Kill a process tree. Windows: `taskkill /T /F` (graphify's multiprocessing workers are children). */
export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (platform === "win32") {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  }
}

/** Spawn without a shell, capture bounded output, enforce timeout + AbortSignal. */
export function run(
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal; maxCaptureBytes?: number; onStdoutLine?: (line: string) => void },
): Promise<RunResult> {
  const cap = opts.maxCaptureBytes ?? 1_000_000;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32", // own process group so killTree reaches workers on POSIX
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let cancelled = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      if (stdout.length < cap) stdout += d;
      if (opts.onStdoutLine) {
        pending += d;
        let i: number;
        while ((i = pending.indexOf("\n")) >= 0) {
          opts.onStdoutLine(pending.slice(0, i).replace(/\r$/, ""));
          pending = pending.slice(i + 1);
        }
      }
    });
    child.stderr?.on("data", (d: string) => { if (stderr.length < cap) stderr += d; });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, opts.timeoutMs);
    const onAbort = (): void => { cancelled = true; killTree(child); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code: number | null): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, cancelled, durationMs: Date.now() - started });
    };
    child.on("error", (err) => { stderr += `\nspawn error: ${err.message}`; finish(null); });
    child.on("close", (code) => finish(code));
  });
}
