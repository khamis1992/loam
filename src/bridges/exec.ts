import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { checkCommand } from "../policy/commands.js";
import { checkCommandRisk } from "../policy/commandRisk/index.js";
import { resolveWrite } from "../policy/paths.js";
import { currentCancelEpoch, isCancelled } from "../server/runControl.js";
import type { ToolContext } from "../tools/registry.js";
import { buildArgv } from "./argv.js";
import { discover } from "./discover.js";
import { toEnvelope } from "./envelope.js";
import { getManifest, isBridgeEnabled } from "./registry.js";
import type { BridgeEnvelope } from "./types.js";

const MAX_CAPTURE = 200_000;

function failure(type: string, message: string): BridgeEnvelope {
  return { ok: false, exitCode: null, timedOut: false, error: { type, message } };
}

function killTree(child: ChildProcess): void {
  try {
    if (child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } catch {
    /* already gone */
  }
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

function spawnOnce(
  exe: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  taskId?: string,
  envOverrides?: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stdoutBuffer: Buffer; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(exe, argv, { cwd, shell: false, windowsHide: true, env: { ...process.env, ...(envOverrides ?? {}) } });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const startEpoch = currentCancelEpoch();
    const finish = (code: number | null, extraErr = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener("abort", onAbort);
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      resolve({ code, stdout: stdoutBuffer.toString("utf8"), stdoutBuffer, stderr: stderr + extraErr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = (): void => killTree(child);
    signal?.addEventListener("abort", onAbort, { once: true });
    const poll = setInterval(() => {
      if ((taskId && isCancelled(taskId)) || currentCancelEpoch() !== startEpoch) killTree(child);
    }, 300);
    poll.unref?.();
    child.stdout.on("data", (d: Buffer) => {
      if (stdoutBytes < MAX_CAPTURE) {
        stdoutChunks.push(d);
        stdoutBytes += d.length;
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString();
    });
    child.on("error", (err) => finish(null, String(err)));
    child.on("close", (code) => finish(code));
  });
}

export interface BridgeDaemon {
  pid: number | null;
  exePath: string;
  stop: () => void;
}

/**
 * Start a long-lived daemon through the same manifest/policy path as runBridge,
 * but return immediately instead of waiting for the process to exit. The caller
 * owns lifecycle and must call stop() (which uses the same tree-kill behavior).
 */
export async function runBridgeDetached(
  ctx: Pick<ToolContext, "cfg" | "workspace" | "signal" | "taskId">,
  bridgeId: string,
  commandId: string,
  args: Record<string, unknown>,
): Promise<BridgeDaemon> {
  const m = getManifest(bridgeId);
  if (!m) throw new Error(`no bridge named ${bridgeId}`);
  if (!isBridgeEnabled(ctx.cfg, m.id)) throw new Error(`bridge ${m.id} is disabled; enable it in Settings › App bridges`);
  const cmd = m.commands.find((c) => c.id === commandId);
  if (!cmd) throw new Error(`${m.id} has no command ${commandId}`);

  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.includes("{{vault:")) throw new Error("vault references are not supported in bridge arguments");
  }
  const built = buildArgv(cmd, args, ctx.workspace);
  if (!built.ok) throw new Error(built.error);

  const found = await discover(m);
  if (!found.exePath) throw new Error(`${m.name} is not installed`);

  const line = [path.basename(found.exePath), ...built.argv.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" ");
  const risk = checkCommandRisk(line, { workingDir: ctx.workspace });
  if (risk.level === "Catastrophic") throw new Error(`blocked by policy: ${risk.reason ?? "command risk is catastrophic"}`);
  if (risk.level === "Confirm") throw new Error(`requires approval: ${risk.reason ?? "command blast radius is outside the workspace"}`);
  const check = checkCommand(ctx.cfg, line);
  if (!check.ok) throw new Error(`blocked by policy: ${check.reason ?? "denied"}`);

  const cwd = resolveWrite(ctx.workspace, undefined);
  const child = spawn(found.exePath, built.argv, { cwd, shell: false, windowsHide: true, env: { ...process.env, ...(cmd.env ?? {}) } });
  return { pid: child.pid ?? null, exePath: found.exePath, stop: () => killTree(child) };
}

/**
 * Run one bridge command. Gate order: enabled flag, argv validation, command
 * policy on the joined line, then spawn with `shell:false`. Approval for
 * exec_script/external effects is the caller's job (appBridgeTools).
 */
export async function runBridge(
  ctx: Pick<ToolContext, "cfg" | "workspace" | "signal" | "taskId">,
  bridgeId: string,
  commandId: string,
  args: Record<string, unknown>,
): Promise<BridgeEnvelope> {
  const m = getManifest(bridgeId);
  if (!m) return failure("unknown_bridge", `no bridge named ${bridgeId}`);
  if (!isBridgeEnabled(ctx.cfg, m.id)) return failure("disabled", `bridge ${m.id} is disabled; enable it in Settings › App bridges`);
  const cmd = m.commands.find((c) => c.id === commandId);
  if (!cmd) return failure("unknown_command", `${m.id} has no command ${commandId}`);

  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.includes("{{vault:")) return failure("vault", "vault references are not supported in bridge arguments");
  }
  const built = buildArgv(cmd, args, ctx.workspace);
  if (!built.ok) return failure("bad_args", built.error);

  const found = await discover(m);
  if (!found.exePath) return failure("missing", `${m.name} is not installed`);

  const line = [path.basename(found.exePath), ...built.argv.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" ");
  const risk = checkCommandRisk(line, { workingDir: ctx.workspace });
  if (risk.level === "Catastrophic") return failure("policy", `blocked by policy: ${risk.reason ?? "command risk is catastrophic"}`);
  if (risk.level === "Confirm") return failure("policy", `requires approval: ${risk.reason ?? "command blast radius is outside the workspace"}`);
  const check = checkCommand(ctx.cfg, line);
  if (!check.ok) return failure("policy", `blocked by policy: ${check.reason ?? "denied"}`);

  let cwd: string;
  try {
    cwd = resolveWrite(ctx.workspace, undefined);
  } catch (err) {
    return failure("cwd", err instanceof Error ? err.message : String(err));
  }
  const seconds = Math.min(cmd.timeoutSeconds ?? ctx.cfg.policy.maxCommandSeconds, ctx.cfg.policy.maxCommandSeconds, 900);
  const res = await spawnOnce(found.exePath, built.argv, cwd, seconds * 1000, ctx.signal, ctx.taskId, cmd.env);
  return toEnvelope(cmd, res);
}
