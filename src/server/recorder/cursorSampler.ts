// cursor-sampler.exe prints one JSON line per sample. Coordinates are physical
// pixels. A display capture leaves bounds empty, so they are normalized against
// the physical virtual screen. Cursor images stay out of the sidecar.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CursorPoint {
  timeMs: number;
  cx: number;
  cy: number;
  visible: boolean;
  interactionType: "move" | "click" | "mouseup";
}

const SCREEN_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LoamDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
}
"@
[void][LoamDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
Write-Output ([LoamDpi]::GetSystemMetrics(76).ToString() + " " + [LoamDpi]::GetSystemMetrics(77) + " " + [LoamDpi]::GetSystemMetrics(78) + " " + [LoamDpi]::GetSystemMetrics(79))
`;

let cachedScreen: ScreenRect | null | undefined;

export function readPhysicalScreen(): ScreenRect | null {
  if (cachedScreen !== undefined) return cachedScreen;
  cachedScreen = null;
  if (process.platform !== "win32") return cachedScreen;
  try {
    const text = execFileSync("powershell.exe", ["-NoProfile", "-Command", SCREEN_SCRIPT], {
      encoding: "utf8",
      timeout: 8_000,
      windowsHide: true,
    });
    const parts = text.trim().split(/\s+/).map(Number);
    const [x, y, width, height] = parts;
    if (parts.length >= 4 && typeof x === "number" && typeof y === "number" && typeof width === "number" && typeof height === "number" && width > 0 && height > 0 && parts.slice(0, 4).every(Number.isFinite)) {
      cachedScreen = { x, y, width, height };
    }
  } catch {
    cachedScreen = null;
  }
  return cachedScreen ?? null;
}

export function cursorSamplerPath(helperPath: string): string | null {
  const candidate = path.join(path.dirname(helperPath), "cursor-sampler.exe");
  return fs.existsSync(candidate) ? candidate : null;
}

function rectOf(raw: Record<string, unknown>, screen: ScreenRect | null): ScreenRect | null {
  const bounds = raw.bounds;
  if (bounds && typeof bounds === "object") {
    const box = bounds as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    if (typeof box.x === "number" && typeof box.y === "number" && typeof box.width === "number" && typeof box.height === "number" && box.width > 0 && box.height > 0) {
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }
  }
  return screen;
}

export function cursorPointFromSample(raw: unknown, originMs: number, screen: ScreenRect | null): CursorPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Record<string, unknown>;
  if (event.type !== "sample") return null;
  if (typeof event.x !== "number" || typeof event.y !== "number" || typeof event.timestampMs !== "number") return null;
  const bounds = rectOf(event, screen);
  if (!bounds) return null;
  const cx = (event.x - bounds.x) / bounds.width;
  const cy = (event.y - bounds.y) / bounds.height;
  const inside = cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1;
  const interactionType = event.leftButtonPressed === true ? "click" : event.leftButtonReleased === true ? "mouseup" : "move";
  return {
    timeMs: Math.max(0, Math.round(event.timestampMs - originMs)),
    cx,
    cy,
    visible: event.visible !== false && inside,
    interactionType,
  };
}

export interface CursorTrackFile {
  samples: number;
  clicks: number;
  path: string | null;
}

export interface CursorSampler {
  finish(): Promise<CursorTrackFile>;
  discard(): void;
}

export function startCursorSampler(exe: string, sidecarPath: string, screen: ScreenRect | null = readPhysicalScreen()): CursorSampler {
  const points: CursorPoint[] = [];
  let originMs = 0;
  let ready = false;
  let buffer = "";
  const child: ChildProcess = spawn(exe, ["33"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const take = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let payload: { type?: string; timestampMs?: number };
      try { payload = JSON.parse(line) as { type?: string; timestampMs?: number }; } catch { continue; }
      if (payload.type === "ready" && typeof payload.timestampMs === "number") {
        originMs = payload.timestampMs;
        ready = true;
        continue;
      }
      const point = cursorPointFromSample(payload, originMs, screen);
      if (point && ready && points.length < 120_000) points.push(point);
    }
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", () => undefined);
  const kill = () => { try { child.kill(); } catch { /* already gone */ } };
  return {
    discard: kill,
    finish() {
      kill();
      return new Promise((resolve) => {
        const write = () => {
          const clicks = points.filter((point) => point.interactionType === "click" && point.visible).length;
          if (points.length === 0) {
            resolve({ samples: 0, clicks, path: null });
            return;
          }
          fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
          fs.writeFileSync(sidecarPath, JSON.stringify({ version: 2, provider: "native", samples: points, assets: [] }));
          resolve({ samples: points.length, clicks, path: sidecarPath });
        };
        if (child.exitCode !== null) write();
        else {
          const timer = setTimeout(write, 1_500);
          child.once("exit", () => { clearTimeout(timer); write(); });
        }
      });
    },
  };
}
