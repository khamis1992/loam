/** Desktop backend contract shared by agent-desktop and the legacy path.
 *  `computerUse.ts` talks only to this interface (§3.4). */
import type { AdSnapshot, Delivery, RefAction, Retry } from "./adTypes.js";

export type BackendId = "agent-desktop" | "legacy";

export interface DesktopTarget {
  app?: string;
  windowId?: string;
}

export interface ObserveOpts extends DesktopTarget {
  interactiveOnly?: boolean;
  compact?: boolean;
  skeleton?: boolean;
  root?: string;
  maxDepth?: number;
  includeBounds?: boolean;
  timeoutMs?: number;
}

export interface ActResult {
  ok: boolean;
  backend: BackendId;
  delivery: Delivery;
  retry: Retry;
  code?: string;
  message: string;
  suggestion?: string;
  needsFreshSnapshot?: boolean;
  foregroundChanged?: boolean;
  raw?: unknown;
}

export interface DesktopBackend {
  id: BackendId;
  available(): Promise<{ ok: boolean; reason?: string; version?: string }>;
  listWindows(t?: DesktopTarget): Promise<ActResult>;
  snapshot(o: ObserveOpts): Promise<ActResult & { snapshot?: AdSnapshot }>;
  find(t: DesktopTarget & { role?: string; name?: string; exact?: boolean; limit?: number }): Promise<ActResult>;
  act(ref: string, action: RefAction, value?: string): Promise<ActResult>;
  typeHeaded(ref: string, text: string): Promise<ActResult>;
  press(combo: string, t: DesktopTarget): Promise<ActResult>;
  focusWindow(windowId: string): Promise<ActResult>;
  screenshot(t: DesktopTarget & { out: string }): Promise<ActResult>;
}

/** A structured refusal for input we never sent (invalid ref, forbidden flag):
 *  nothing happened, so a fresh attempt with corrected args is safe. */
export const notDelivered = (backend: BackendId, code: string, message: string): ActResult => ({
  ok: false,
  backend,
  delivery: "not_delivered",
  retry: "safe",
  code,
  message,
});

/** §3.4 selector: agent-desktop when the verified binary exists on win32 and
 *  the config did not pin legacy; otherwise legacy. The choice (and its
 *  reason) is logged once per process — no window titles in the log. */
let loggedUnavailable = false;

export function pickBackend(
  ctx: import("../registry.js").ToolContext,
  deps: {
    verify: (exe: string) => { ok: boolean; reason?: string };
    exePath: () => string;
    stateRoot: string;
    make: (exe: string, stateRoot: string, session: string, signal?: AbortSignal) => DesktopBackend;
  },
): DesktopBackend | { legacy: true; reason: string } {
  const c = ctx.cfg.computerUse;
  if (c.backend !== "legacy" && process.platform === "win32") {
    const exe = deps.exePath();
    const v = deps.verify(exe);
    if (v.ok) return deps.make(exe, deps.stateRoot, `loam-${ctx.taskId ?? "adhoc"}`, ctx.signal);
    if (!loggedUnavailable) {
      console.warn(`[agent-desktop] unavailable (${v.reason}); using legacy backend`);
      loggedUnavailable = true;
    }
    if (c.backend === "agent-desktop") {
      return { legacy: true, reason: `agent-desktop backend requested but unavailable: ${v.reason ?? "unknown"}` };
    }
  }
  return { legacy: true, reason: c.backend === "legacy" ? "config backend=legacy" : process.platform === "win32" ? "" : "non-win32 platform" };
}
