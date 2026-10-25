import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { checkCommand, headOutput, tailOutput } from "../policy/commands.js";
import { checkCommandRisk } from "../policy/commandRisk/index.js";
import { resolveSrtPolicy, shouldSandboxCommand } from "../sandbox/srt/policy.js";
import { execInSandbox } from "../sandbox/srt/exec.js";
import { srtAudit } from "../sandbox/srt/audit.js";
import { taskPermissionMode } from "../server/approvalRules.js";
import { DEFAULT_PERMISSION_MODE } from "../policy/permissionModes.js";
import { getSettings } from "../server/settings.js";
import { resolveWrite } from "../policy/paths.js";
import { currentCancelEpoch, isCancelled } from "../server/runControl.js";
import { planVaultEnv, redactVaultValues, vaultScope } from "./vaultTools.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";
import { BoundedMap } from "../memory/cache.js";
import { registerCacheStats } from "../memory/stats.js";

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

/**
 * Persistent shell sessions (J6). Each entry owns a live child process, so the
 * map is capped and the evicted session's process tree is killed — otherwise a
 * long run that starts many shells leaks a process (and its buffer) each time.
 * Sessions still close explicitly through shell_kill / process exit.
 */
const sessions = new BoundedMap<string, Session>(32, "shell-sessions", (_id, session) => {
  try {
    killTree(session.child);
  } catch {
    /* already gone */
  }
});
registerCacheStats("shell-sessions", () => sessions.stats());

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
      "Run a single shell command in the workspace and get back its exit code plus captured stdout and stderr. Destructive commands are blocked by policy before execution, and {{vault:NAME}} references are resolved into the child environment and redacted from the returned output. Use cwd to run in a subdirectory (defaults to the workspace root), timeoutSeconds to bound it (the policy maximum is enforced), and env for extra variables. Independent read-only commands may be issued in parallel; keep mutating commands serial. When NOT to use: use shell_start/shell_write/shell_read for an interactive session, file_read/file_search for in-workspace files, and code_symbols instead of a shell grep; never pipe file contents through shell cat/type when file_read fits.",
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
      // Stage 1 of the blast-radius gate: the jcode command-risk classifier
      // first, for what a denylist cannot see, then the substring pattern list
      // (cheap, catches things the structural classifier treats as opaque).
      // Both are gates, so the order only changes the message; what must hold is
      // the union: dropping either half opens a bypass.
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

      // L3 containment (sandbox-runtime): after L0–L2 gates pass, the command may
      // still execute inside the OS sandbox when the mode says so (C6: untrusted_only
      // exempts a run whose task permission mode is the user's explicit full trust).
      const srtSettings = getSettings();
      const srtMode = srtSettings.sandboxMode ?? "off";
      if (shouldSandboxCommand(srtMode, taskPermissionMode(ctx.taskId ?? "") ?? DEFAULT_PERMISSION_MODE)) {
        const policy = resolveSrtPolicy({ sandboxMode: srtMode, sandboxAllowedDomains: srtSettings.sandboxAllowedDomains });
        const res = await execInSandbox({ command: execCommand, cwd, timeoutMs: Math.max(timeoutMs, policy.timeoutMs), signal: ctx.signal }, policy, ctx.workspace);
        const stdout = redactVaultValues(res.stdout, secrets);
        const stderr = redactVaultValues(res.annotatedStderr || res.stderr, secrets);
        const parts = [
          `exit=${res.code ?? "null"}${res.timedOut ? " (timeout, killed)" : ""}`,
          `cwd=${cwd}`,
          "sandboxed=true (عزل الأوامر مفعّل — لا شبكة خارج النطاقات المسموحة ولا قراءة لمسارات المفاتيح)",
        ];
        if (stdout.trim()) parts.push(`stdout:\n${tailOutput(stdout, 6000)}`);
        if (stderr.trim()) parts.push(`stderr:\n${tailOutput(stderr, 4000)}`);
        if (!stdout.trim() && !stderr.trim()) parts.push("(no output)");
        return { ok: res.code === 0, content: parts.join("\n") };
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
    description:
      "Start a persistent interactive shell session (powershell or cmd) in a workspace directory and get a session id back. Use it when you need a stateful shell — a long-running server, a REPL, or a command whose environment must survive across steps. Drive it with shell_write to send input and shell_read to collect output, and end it with shell_kill. Independent sessions may run concurrently. When NOT to use: use shell_run for a one-shot command that finishes on its own, and always kill a session when the task ends rather than leaving it running.",
    parameters: {
      type: "object",
      properties: {
        shell: { type: "string", enum: ["powershell", "cmd"], description: "Shell to launch. Default powershell." },
        cwd: { type: "string", description: "Working directory inside the workspace." },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      // OD-6: long-lived interactive shells stay UNSANDBOXED in v1, so they are
      // refused outright while the command sandbox is enabled — an interactive
      // session inside the srt-sandbox user is a v2 concern (SANDBOX_RUNTIME §9).
      const srtMode = getSettings().sandboxMode ?? "off";
      if (srtMode !== "off") {
        srtAudit().append({ name: "srt_blocked_tool", outcome: "denied", toolName: "shell_start", mode: srtMode });
        return {
          ok: false,
          content: "shell_start غير متاح أثناء تفعيل «عزل الأوامر» (الجلسات التفاعلية تبقى خارج العزل في هذه الإصدارة). استخدم shell_run — يُنفَّذ معزولًا تلقائيًا، أو أوقف العزل من الإعدادات.",
        };
      }
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
    description:
      "Send a line of input to a persistent shell session started with shell_start; a newline is appended automatically. The input is still checked against policy before it is written. Use it to drive an interactive program step by step, then follow with shell_read to see what happened. When NOT to use: use shell_run for a self-contained command, and shell_start to create the session before writing to it.",
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
    description:
      "Read any output a persistent shell session has produced since your last read, waiting up to waitMs (default 700, maximum 10000) for new data. Use it after shell_write to collect results, or on its own to poll a long-running process. The buffer is consumed, so each call returns only fresh output while the session keeps its own history. When NOT to use: use shell_run for one-shot output, shell_list to enumerate sessions, and shell_kill to terminate one.",
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
    description:
      "List the active persistent shell sessions with their id, shell and working directory. Use it to recover a session id you have lost track of, or to check for sessions that should be cleaned up before the task ends. It is a cheap read and may be batched with other reads. When NOT to use: use shell_read/shell_write to interact with a known session, shell_start to create one, and shell_kill to end one.",
    parameters: { type: "object", properties: {} },
    async run(): Promise<ToolResult> {
      if (sessions.size === 0) return { ok: true, content: "(no active sessions)" };
      return { ok: true, content: [...sessions.values()].map((s) => `${s.id}\t${s.shell}\t${s.cwd}`).join("\n") };
    },
  },
  {
    name: "shell_kill",
    description:
      "Terminate a persistent shell session and free its resources. Use it when a session is no longer needed or has stalled, and always when a task finishes with a session still open. It is a mutating effect. When NOT to use: use shell_read to drain the final output first if you need it, and shell_list to confirm the id before killing.",
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
