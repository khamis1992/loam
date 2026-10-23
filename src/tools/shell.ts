import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { checkCommand, headOutput, tailOutput } from "../policy/commands.js";
import { checkCommandRisk } from "../policy/commandRisk/index.js";
import { resolveWrite } from "../policy/paths.js";
import { currentCancelEpoch, isCancelled } from "../server/runControl.js";
import { planVaultEnv, redactVaultValues, vaultScope } from "./vaultTools.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

interface ExecOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_CAPTURE = 200_000;

/** Read an optional object of string values from tool args (null when absent/invalid). */
function strObj(args: Record<string, unknown>, key: string): Record<string, string> | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") return null;
    out[k] = val;
  }
  return out;
}

/** Kill the shell and its children (taskkill /T /F) — Windows keeps grandchildren alive otherwise. */
function killTree(child: ChildProcessWithoutNullStreams): void {
  try {
    if (child.pid) {
      // synchronous: an async spawn here loses the race against the grandchild
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        shell: process.platform === "win32",
      });
    }
  } catch {
    /* ignore */
  }
  try {
    child.kill();
  } catch {
    /* ignore */
  }
}

function runOnce(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal, taskId?: string, env?: NodeJS.ProcessEnv): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: env ?? { ...process.env } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let exitDrainTimer: NodeJS.Timeout | null = null;
    const finish = (code: number | null, extraErr = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitDrainTimer) clearTimeout(exitDrainTimer);
      clearInterval(poll);
      signal?.removeEventListener("abort", onAbort);
      try {
        child.stdout.destroy();
        child.stderr.destroy();
      } catch {
        /* ignore */
      }
      resolve({ code, stdout, stderr: stderr + extraErr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = (): void => {
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Poll for cancellation: (a) this task's flag, (b) any cancel that happened
    // after this command started. An abort signal does not always reach a tool
    // that is already mid-execution (e.g. inside the orchestrator).
    const startEpoch = currentCancelEpoch();
    if (process.env.MANUS_DEBUG_CANCEL) console.error("[cancel-debug] start taskId=" + taskId + " epoch=" + startEpoch);
    const poll = setInterval(() => {
      const cancelledNow = (taskId && isCancelled(taskId)) || currentCancelEpoch() !== startEpoch;
      if (process.env.MANUS_DEBUG_CANCEL) console.error("[cancel-debug] poll taskId=" + taskId + " isCancelled=" + (taskId ? isCancelled(taskId) : "n/a") + " epoch=" + currentCancelEpoch() + " start=" + startEpoch + " kill=" + Boolean(cancelledNow));
      if (cancelledNow) killTree(child);
    }, 300);
    poll.unref?.();
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString();
    });
    child.on("error", (err) => {
      finish(null, String(err));
    });
    // On Windows, `start /b node server.js` spawns a background grandchild that inherits stdio
    // handles so `close` never fires even after the parent `cmd.exe` has exited. Flush for 250ms
    // after `exit` and resolve cleanly without killing the background server.
    child.on("exit", (code) => {
      if (settled) return;
      exitDrainTimer = setTimeout(() => {
        finish(code);
      }, 250);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}

interface Session {
  id: string;
  shell: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  buffer: string;
  lastRead: number;
  exited: boolean;
  exitCode: number | null;
}

const sessions = new Map<string, Session>();

function spawnShell(shell: string, cwd: string): ChildProcessWithoutNullStreams {
  if (shell === "cmd") {
    return spawn("cmd.exe", [], { cwd, windowsHide: true, env: { ...process.env } }) as ChildProcessWithoutNullStreams;
  }
  return spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", "-"], {
    cwd,
    windowsHide: true,
    env: { ...process.env },
  }) as ChildProcessWithoutNullStreams;
}

export const shellTools: Tool[] = [
  {
    name: "shell_run",
    description:
      "Run a shell command once in the workspace and return exit code + stdout/stderr. Destructive commands are blocked by policy.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command line to execute." },
        cwd: { type: "string", description: "Working directory (inside workspace). Defaults to workspace root." },
        timeoutSeconds: { type: "number", description: "Timeout in seconds (policy max enforced)." },
        env: {
          type: "object",
          description: "Extra environment variables for the child process. Values may contain {{vault:NAME}} references.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["command"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const command = str(args, "command").trim();
      if (!command) return { ok: false, content: "command is required" };
      // Stage 1 of the blast-radius gate: pattern list first (cheap, catches
      // things the structural classifier treats as opaque), then the jcode
      // command-risk classifier for what a denylist cannot see. Must be a union:
      // dropping either half opens a bypass.
      const risk = checkCommandRisk(command, { workingDir: ctx.workspace });
      if (risk.level === "Catastrophic") {
        return { ok: false, content: `blocked by policy: ${risk.reason ?? "command risk is catastrophic"}` };
      }
      if (risk.level === "Confirm") {
        return {
          ok: false,
          content: `requires approval: ${risk.reason ?? "command blast radius is outside the workspace"}\n`
            + `To allow it once for this task, the user must approve it at the gate with a justification; `
            + `a task-scoped rule cannot auto-approve this. Otherwise re-run the command inside the workspace.`,
        };
      }
      const check = checkCommand(ctx.cfg, command);
      if (!check.ok) return { ok: false, content: `blocked by policy: ${check.reason ?? "denied"}` };
      const rawEnv = strObj(args, "env");
      if (rawEnv === null && args.env !== undefined && args.env !== null) {
        return { ok: false, content: "env must be an object of string values" };
      }
      const cwd = resolveWrite(ctx.workspace, str(args, "cwd") || undefined);
      const timeoutMs = Math.min(num(args, "timeoutSeconds", ctx.cfg.policy.maxCommandSeconds), 900) * 1000;

      // Vault refs: resolve ONLY into the child environment (never inline into
      // the command), then redact the values from the returned output.
      let execCommand = command;
      let injected: Record<string, string> = {};
      let childEnv: Record<string, string> = rawEnv ?? {};
      let secrets: string[] = [];
      const envValues = rawEnv ? Object.values(rawEnv) : [];
      if (command.includes("{{vault:") || envValues.some((v) => v.includes("{{vault:"))) {
        try {
          const plan = planVaultEnv([command, ...envValues], vaultScope(ctx));
          injected = plan.env;
          secrets = plan.secrets;
          execCommand = plan.rewrite(command);
          if (rawEnv) {
            const rewritten: Record<string, string> = {};
            for (const [k, v] of Object.entries(rawEnv)) rewritten[k] = plan.inline(v);
            childEnv = rewritten;
          }
        } catch (err) {
          return { ok: false, content: `vault: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      const res = await runOnce(execCommand, cwd, timeoutMs, ctx.signal, ctx.taskId, { ...process.env, ...injected, ...childEnv });
      const stdout = redactVaultValues(res.stdout, secrets);
      const stderr = redactVaultValues(res.stderr, secrets);
      const parts = [
        `exit=${res.code ?? "null"}${res.timedOut ? " (timeout, killed)" : ""}`,
        `cwd=${cwd}`,
      ];
      if (stdout.trim()) parts.push(`stdout:\n${tailOutput(stdout, 6000)}`);
      if (stderr.trim()) parts.push(`stderr:\n${tailOutput(stderr, 4000)}`);
      if (!stdout.trim() && !stderr.trim()) parts.push("(no output)");
      return { ok: res.code === 0, content: parts.join("\n") };
    },
  },
  {
    name: "shell_start",
    description: "Start a persistent interactive shell session (powershell or cmd) in a workspace directory. Returns a session id.",
    parameters: {
      type: "object",
      properties: {
        shell: { type: "string", enum: ["powershell", "cmd"], description: "Shell to launch. Default powershell." },
        cwd: { type: "string", description: "Working directory inside the workspace." },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const shell = str(args, "shell", "powershell").toLowerCase();
      const cwd = resolveWrite(ctx.workspace, str(args, "cwd") || undefined);
      const child = spawnShell(shell, cwd);
      const id = `shell_${crypto.randomBytes(3).toString("hex")}`;
      const session: Session = { id, shell, cwd, child, buffer: "", lastRead: 0, exited: false, exitCode: null };
      child.stdout.on("data", (d: Buffer) => {
        session.buffer += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        session.buffer += d.toString();
      });
      child.on("close", (code) => {
        session.exited = true;
        session.exitCode = code;
        sessions.delete(id);
      });
      sessions.set(id, session);
      return { ok: true, content: `started ${shell} session ${id} (cwd=${cwd}). Use shell_write and shell_read.` };
    },
  },
  {
    name: "shell_write",
    description: "Send a line of input to a persistent shell session (a newline is appended).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Session id from shell_start." },
        input: { type: "string", description: "Text/command to send." },
      },
      required: ["id", "input"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const id = str(args, "id");
      const session = sessions.get(id);
      if (!session) return { ok: false, content: `no such session: ${id}` };
      const input = str(args, "input");
      const check = checkCommand(ctx.cfg, input);
      if (!check.ok) return { ok: false, content: `blocked by policy: ${check.reason ?? "denied"}` };
      const risk = checkCommandRisk(input, { workingDir: session.cwd });
      if (risk.level === "Catastrophic") {
        return { ok: false, content: `blocked by policy: ${risk.reason ?? "command risk is catastrophic"}` };
      }
      if (risk.level === "Confirm") {
        return {
          ok: false,
          content: `requires approval: ${risk.reason ?? "command blast radius is outside the workspace"}\n`
            + `Run this in a one-shot shell_run call the user can approve instead.`,
        };
      }
      session.child.stdin.write(`${input}\n`);
      return { ok: true, content: `sent to ${id}` };
    },
  },
  {
    name: "shell_read",
    description: "Read any new output from a persistent shell session since the last read (waits up to waitMs).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Session id." },
        waitMs: { type: "number", description: "Milliseconds to wait for new output (default 700, max 10000)." },
      },
      required: ["id"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const id = str(args, "id");
      const session = sessions.get(id);
      if (!session) return { ok: false, content: `no such session: ${id}` };
      const waitMs = Math.min(Math.max(num(args, "waitMs", 700), 0), 10_000);
      await new Promise((r) => setTimeout(r, waitMs));
      const fresh = session.buffer.slice(session.lastRead);
      session.lastRead = session.buffer.length;
      if (session.buffer.length > 400_000) {
        session.buffer = session.buffer.slice(-200_000);
        session.lastRead = session.buffer.length;
      }
      return { ok: true, content: fresh.trim() ? headOutput(fresh, 8000) : "(no new output)" };
    },
  },
  {
    name: "shell_list",
    description: "List active persistent shell sessions.",
    parameters: { type: "object", properties: {} },
    async run(): Promise<ToolResult> {
      if (sessions.size === 0) return { ok: true, content: "(no active sessions)" };
      return { ok: true, content: [...sessions.values()].map((s) => `${s.id}\t${s.shell}\t${s.cwd}`).join("\n") };
    },
  },
  {
    name: "shell_kill",
    description: "Terminate a persistent shell session.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      const id = str(args, "id");
      const session = sessions.get(id);
      if (!session) return { ok: false, content: `no such session: ${id}` };
      try {
        session.child.kill();
      } catch {
        /* ignore */
      }
      sessions.delete(id);
      return { ok: true, content: `killed ${id}` };
    },
  },
];

export function disposeShellSessions(): void {
  for (const s of sessions.values()) {
    try {
      s.child.kill();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
}
