import path from "node:path";
import { spawn } from "node:child_process";

import { SCRIPTS_DIR } from "../../config.js";
import { log } from "../../log.js";
import type { ToolContext } from "../registry.js";

/** Today's PowerShell/nut-js path, moved verbatim from the old computerUse.ts
 *  (P4) and kept as the guarded fallback. Behaviour unchanged; only the call
 *  sites moved behind the facade + foreground guard. Test seams: runPsImpl and
 *  clickImpl are injectable so guard tests never move a real mouse. */

const UI_SCRIPT = path.join(SCRIPTS_DIR, "win-ui.ps1");
const INPUT_SCRIPT = path.join(SCRIPTS_DIR, "input.ps1");

export type RunPs = (script: string, args: string[], timeoutMs?: number) => Promise<{ code: number | null; out: string; err: string }>;

export const runPs: RunPs = (script, args, timeoutMs = 60_000) => {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
      windowsHide: true,
      env: { ...process.env },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, out, err: err + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
};

/* ---------- physical input via nut.js (native; PS stays read-only & unflagged) ---------- */

interface NutMouse {
  config: { autoDelayMs: number; mouseSpeed: number };
  setPosition(p: unknown): Promise<void>;
  leftClick(): Promise<void>;
  rightClick(): Promise<void>;
}
interface NutModule {
  mouse: NutMouse;
  Point: new (x: number, y: number) => unknown;
}

let nut: NutModule | null = null;
let nutError: string | null = null;

async function getNut(): Promise<NutModule | null> {
  if (nut) return nut;
  try {
    const mod = (await import("@nut-tree-fork/nut-js")) as unknown as NutModule;
    mod.mouse.config.autoDelayMs = 0;
    mod.mouse.config.mouseSpeed = 6000;
    nut = mod;
    return nut;
  } catch (err) {
    nutError = err instanceof Error ? err.message : String(err);
    log.warn(`nut.js unavailable: ${nutError}`);
    return null;
  }
}

export type ClickPoint = (x: number, y: number, button?: "left" | "right") => Promise<string>;

export const clickPoint: ClickPoint = async (x, y, button = "left") => {
  const n = await getNut();
  if (!n) return `physical input unavailable (${nutError ?? "nut.js not installed"})`;
  await n.mouse.setPosition(new n.Point(x, y));
  if (button === "right") await n.mouse.rightClick();
  else await n.mouse.leftClick();
  return `clicked ${button} at ${x},${y}`;
};

export function parseJson(out: string): Record<string, unknown> | null {
  const lines = out
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("{") || l.trim().startsWith("["));
  const line = lines[lines.length - 1];
  if (!line) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function requireEnabled(ctx: ToolContext): string | null {
  if (!ctx.cfg.computerUse.enabled) return "computer use is disabled in config (computerUse.enabled=false)";
  if (process.platform !== "win32") return "computer use tools are Windows-only in this build";
  return null;
}

export function targetArgs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (args["index"] !== undefined) out.push("-Index", String(args["index"]));
  const name = typeof args["name"] === "string" ? args["name"] : "";
  if (name) out.push("-Name", name);
  const role = typeof args["role"] === "string" ? args["role"] : "";
  if (role) out.push("-Role", role);
  return out;
}

/** Injectable legacy surface for the facade + tests. */
export interface LegacyDeps {
  runPs: RunPs;
  clickPoint: ClickPoint;
}

export const defaultLegacyDeps: LegacyDeps = { runPs, clickPoint };

export function legacyUiScript(): string {
  return UI_SCRIPT;
}
export function legacyInputScript(): string {
  return INPUT_SCRIPT;
}
