/** Per-call desktop metrics: ms, bytes, dispositions and foreground events.
 *  Window ids and app exe names only — never titles, element text or argv of
 *  set-value/type calls (they contain user text). */
import { log } from "../../log.js";
import type { Delivery, Retry } from "./adTypes.js";

export interface DesktopCallEvent {
  tool: string;
  backend: "agent-desktop" | "legacy";
  command: string;
  ms: number;
  stdoutBytes?: number;
  delivery?: Delivery;
  retry?: Retry;
  code?: string;
  foregroundChanged?: boolean;
  mouseMoved?: boolean;
  windowId?: string;
  app?: string;
}

let sink: ((e: DesktopCallEvent) => void) | null = null;

/** Tests install a sink to assert on events; production logs them. */
export function setMetricsSink(fn: ((e: DesktopCallEvent) => void) | null): void {
  sink = fn;
}

export function recordDesktopCall(e: DesktopCallEvent): void {
  if (sink) {
    sink(e);
    return;
  }
  log.info(
    `desktop ${e.tool} backend=${e.backend} cmd=${e.command} ms=${Math.round(e.ms)}` +
      (e.stdoutBytes !== undefined ? ` bytes=${e.stdoutBytes}` : "") +
      (e.delivery ? ` delivery=${e.delivery}` : "") +
      (e.retry ? ` retry=${e.retry}` : "") +
      (e.code ? ` code=${e.code}` : "") +
      (e.foregroundChanged ? ` fgChanged=true` : "") +
      (e.mouseMoved ? ` mouseMoved=true` : "") +
      (e.windowId ? ` win=${e.windowId}` : "") +
      (e.app ? ` app=${e.app}` : ""),
  );
}
