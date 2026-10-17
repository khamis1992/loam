import path from "node:path";
import type { Config } from "../config.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

interface PtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pid: number;
}

interface PtyModule {
  spawn(file: string, args: string[], options: Record<string, unknown>): PtyProcess;
}

interface Session {
  id: string;
  shell: string;
  cwd: string;
  proc: PtyProcess;
  buffer: string;
  exited: boolean;
  exitCode: number | null;
  subscribers: Set<(chunk: string) => void>;
}

const sessions = new Map<string, Session>();
let ptyModule: PtyModule | null = null;
let ptyLoadError: string | null = null;

export async function initPty(): Promise<boolean> {
  try {
    const mod = (await import("node-pty")) as unknown as { default?: PtyModule } & PtyModule;
    ptyModule = (mod.default ?? mod) as PtyModule;
    return true;
  } catch (err) {
    ptyLoadError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

export function ptyAvailable(): boolean {
  return ptyModule !== null;
}

export function ptyStatus(): string {
  return ptyModule ? "node-pty loaded (real PTY sessions available)" : `node-pty unavailable: ${ptyLoadError ?? "not installed"}`;
}

function shellCommand(shell: string): { file: string; args: string[] } {
  if (shell === "cmd") return { file: "cmd.exe", args: [] };
  return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile"] };
}

export function startSession(shell: string, cwd: string, cols: number, rows: number): Session {
  if (!ptyModule) throw new Error(`PTY unavailable: ${ptyLoadError ?? "node-pty not installed"}`);
  const { file, args } = shellCommand(shell);
  const proc = ptyModule.spawn(file, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    useConpty: true,
  });
  const id = `pty_${Math.random().toString(36).slice(2, 8)}`;
  const session: Session = {
    id,
    shell,
    cwd,
    proc,
    buffer: "",
    exited: false,
    exitCode: null,
    subscribers: new Set(),
  };
  proc.onData((data: string) => {
    session.buffer += data;
    if (session.buffer.length > 400_000) session.buffer = session.buffer.slice(-200_000);
    for (const sub of session.subscribers) sub(data);
  });
  proc.onExit((e) => {
    session.exited = true;
    session.exitCode = e.exitCode;
    for (const sub of session.subscribers) sub(`\r\n[process exited with code ${e.exitCode}]\r\n`);
    sessions.delete(id);
  });
  sessions.set(id, session);
  return session;
}

export function writeSession(id: string, data: string): void {
  const s = sessions.get(id);
  if (!s) throw new Error(`no such pty session: ${id}`);
  s.proc.write(data);
}

export function resizeSession(id: string, cols: number, rows: number): void {
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.proc.resize(Math.max(20, cols), Math.max(5, rows));
  } catch {
    /* ignore */
  }
}

export function killSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  try {
    s.proc.kill();
  } catch {
    /* ignore */
  }
  sessions.delete(id);
  return true;
}

export function listSessions(): Array<{ id: string; shell: string; cwd: string; exited: boolean; pid: number }> {
  return [...sessions.values()].map((s) => ({ id: s.id, shell: s.shell, cwd: s.cwd, exited: s.exited, pid: s.proc.pid }));
}

export function subscribe(id: string, listener: (chunk: string) => void): (() => void) | null {
  const s = sessions.get(id);
  if (!s) return null;
  s.subscribers.add(listener);
  return () => s.subscribers.delete(listener);
}

export function sessionSnapshot(id: string): { buffer: string } | null {
  const s = sessions.get(id);
  return s ? { buffer: s.buffer } : null;
}

export function disposePty(): void {
  for (const s of sessions.values()) {
    try {
      s.proc.kill();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
}

export const ptyTools: Tool[] = [
  {
    name: "pty_start",
    description: "Start a real interactive terminal (PTY) session with powershell or cmd. Returns a session id. Prefer this over shell_start for interactive programs.",
    parameters: {
      type: "object",
      properties: {
        shell: { type: "string", enum: ["powershell", "cmd"] },
        cwd: { type: "string", description: "Working directory inside the workspace." },
        cols: { type: "number" },
        rows: { type: "number" },
      },
    },
    async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      if (!ptyModule) return { ok: false, content: ptyStatus() };
      const shell = str(args, "shell", "powershell").toLowerCase() === "cmd" ? "cmd" : "powershell";
      const cwd = str(args, "cwd") || process.cwd();
      const session = startSession(shell, cwd, num(args, "cols", 120), num(args, "rows", 30));
      return { ok: true, content: `started PTY ${session.id} (${shell}, pid=${session.proc.pid}, cwd=${cwd})` };
    },
  },
  {
    name: "pty_write",
    description: "Send raw input bytes to a PTY session (append \\n to run a command).",
    parameters: { type: "object", properties: { id: { type: "string" }, data: { type: "string" } }, required: ["id", "data"] },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      writeSession(str(args, "id"), str(args, "data"));
      return { ok: true, content: "sent" };
    },
  },
  {
    name: "pty_read",
    description: "Read recent terminal output (tail of the session buffer).",
    parameters: { type: "object", properties: { id: { type: "string" }, maxChars: { type: "number" } }, required: ["id"] },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      const snap = sessionSnapshot(str(args, "id"));
      if (!snap) return { ok: false, content: `no such pty session: ${str(args, "id")}` };
      const max = Math.max(1000, num(args, "maxChars", 8000));
      const out = snap.buffer.length > max ? snap.buffer.slice(-max) : snap.buffer;
      return { ok: true, content: out.length ? out : "(no output yet)" };
    },
  },
  {
    name: "pty_list",
    description: "List active PTY sessions.",
    parameters: { type: "object", properties: {} },
    async run(): Promise<ToolResult> {
      if (!ptyModule) return { ok: false, content: ptyStatus() };
      const list = listSessions();
      if (list.length === 0) return { ok: true, content: "(no pty sessions)" };
      return { ok: true, content: list.map((s) => `${s.id}\t${s.shell}\tpid=${s.pid}\t${s.cwd}`).join("\n") };
    },
  },
  {
    name: "pty_kill",
    description: "Terminate a PTY session.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      return { ok: killSession(str(args, "id")), content: `kill requested for ${str(args, "id")}` };
    },
  },
];

export function resolveWorkspacePath(cfg: Config, input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(cfg.workspace, input);
}
