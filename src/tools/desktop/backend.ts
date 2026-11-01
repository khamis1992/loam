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
