import { spawn } from "node:child_process";
import fs from "node:fs";

export type ProbeRuntime = "node" | "powershell";

export interface ProbeRequest {
  cwd: string;
  runtime: ProbeRuntime;
  source: string;
  timeoutMs: number;
}

export interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function detectRuntimes(env: NodeJS.ProcessEnv = process.env): ProbeRuntime[] {
  const found: ProbeRuntime[] = [];
  if (env.PATH?.toLowerCase().includes("node") || fs.existsSync(process.execPath)) found.push("node");
  if (process.platform === "win32") found.push("powershell");
  return found;
}

/** Run one probe inside the review copy. Network access is not granted: no proxy env is forwarded. */
export function runProbe(request: ProbeRequest): Promise<ProbeResult> {
  const command = request.runtime === "node"
    ? { file: process.execPath, args: ["-e", request.source] }
    : { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", request.source] };
  return new Promise((resolve) => {
    const child = spawn(command.file, command.args, {
      cwd: request.cwd,
      windowsHide: true,
      shell: false,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        COMSPEC: process.env.COMSPEC ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, request.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < 6000) stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 6000) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.slice(0, 6000), stderr: stderr.slice(0, 6000), timedOut });
    });
  });
}
