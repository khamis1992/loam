import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { SCRIPTS_DIR } from "../../config.js";
import { log } from "../../log.js";

/** One sample from the fg probe: the foreground window handle, its pid, and
 *  the cursor position. Window titles are never part of a sample. */
export interface FgSample {
  hwnd: number;
  pid: number;
  x: number;
  y: number;
}

export interface GuardTarget {
  windowId?: string;
  hwnd?: number;
  pid?: number;
  app?: string;
}

const PROBE_SCRIPT = path.join(SCRIPTS_DIR, "fg-probe.ps1");

/** Lazily started, one per Loam process; killed by stopFgProbe on shutdown. */
let probe: ChildProcess | null = null;
let pending = "";
let waiters: Array<(line: string) => void> = [];

function ensureProbe(): ChildProcess {
  if (probe && probe.exitCode === null) return probe;
  probe = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PROBE_SCRIPT],
    { windowsHide: true },
  );
  pending = "";
  waiters = [];
  probe.stdout!.on("data", (d: Buffer) => {
    pending += d.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const w = waiters.shift();
      if (w) w(line);
    }
  });
  probe.on("exit", () => {
    probe = null;
    const stuck = waiters;
    waiters = [];
    for (const w of stuck) w("");
  });
  return probe;
}

/** Kill the probe at shutdown — it is our own child. */
export function stopFgProbe(): void {
  if (probe) {
    try {
      probe.kill();
    } catch {
      /* own child */
    }
    probe = null;
  }
}

/** Ask the probe for one sample (~ms, no PowerShell restart). */
export function fgSample(): Promise<FgSample | null> {
  return new Promise((resolve) => {
    const child = ensureProbe();
    child.stdin!.write("\n");
    const timer = setTimeout(() => resolve(null), 2_000);
    waiters.push((line) => {
      clearTimeout(timer);
      const parts = line.split(",").map(Number);
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        resolve({ hwnd: parts[0]!, pid: parts[1]!, x: parts[2]!, y: parts[3]! });
      } else {
        resolve(null);
      }
    });
  });
}

export class ForegroundGuard {
  private target: GuardTarget | null = null;
  constructor(
    private probe: () => Promise<FgSample | null>,
    private focusedWindowId: () => Promise<string | null>,
  ) {}

  setTarget(t: GuardTarget): void {
    this.target = t;
  }
  getTarget(): GuardTarget | null {
    return this.target;
  }
  clearTarget(): void {
    this.target = null;
  }

  /** Returns null when input may be sent, else the refusal text. Never throws,
   *  never sends input. No config switch — the guard is always on. */
  async check(): Promise<string | null> {
    const t = this.target;
    if (!t) return "GUARD_BLOCKED: no target window chosen. Call computer_snapshot or computer_focus_window first.";
    if (t.windowId) {
      const f = await this.focusedWindowId();
      if (f === t.windowId) return null;
    }
    const s = await this.probe();
    if (!s) return "GUARD_BLOCKED: foreground probe unavailable; nothing was sent. Re-focus the target and retry.";
    if (t.hwnd !== undefined && s.hwnd === t.hwnd) return null;
    return "GUARD_BLOCKED: the foreground window is not the task window; nothing was sent. Focus the target first.";
  }
}

export interface GuardedOutcome<T> {
  blocked?: string;
  value?: T;
  foregroundChanged?: boolean;
  mouseMoved?: boolean;
}

/** Check the guard, sample before, send, sample after. A refusal means nothing
 *  was sent. Every physical/headed path in the facade goes through this. */
export async function guarded<T>(
  g: ForegroundGuard,
  probe: () => Promise<FgSample | null>,
  send: () => Promise<T>,
): Promise<GuardedOutcome<T>> {
  const refusal = await g.check();
  if (refusal) return { blocked: refusal };
  const before = await probe();
  const value = await send();
  const after = await probe();
  return {
    value,
    foregroundChanged: !!before && !!after && after.hwnd !== before.hwnd,
    mouseMoved: !!before && !!after && (after.x !== before.x || after.y !== before.y),
  };
}

/** Key denylist checked BEFORE the guard: system-level combos are refused
 *  outright no matter what has focus (§3.7). SendKeys and combo forms. */
export function deniedKey(combo: string): string | null {
  const c = combo.trim().toLowerCase();
  if (!c) return "empty key combo";
  if (c === "alt+f4" || c === "%{f4}") return "alt+f4 is denied";
  if (c.startsWith("win+") || c.includes("{lwin}") || c.includes("{rwin}")) return "win-key combos are denied";
  if (c === "ctrl+alt+del" || c === "^%{del}" || c === "ctrl+alt+delete") return "ctrl+alt+del is denied";
  if (c === "ctrl+shift+esc" || c === "^+{esc}") return "ctrl+shift+esc is denied";
  return null;
}

/** Convenience: build a guard wired to the real probe + a focused-window
 *  resolver the facade supplies (agent-desktop list-windows when available). */
export function realGuard(focusedWindowId: () => Promise<string | null>): ForegroundGuard {
  return new ForegroundGuard(fgSample, focusedWindowId);
}

void log;
