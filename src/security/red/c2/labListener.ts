/**
 * Lab callback listener (RED_TEAM_BUILD_SPEC §6.10, spec O-2 default).
 *
 * Detection-only stand-in for a C2 implant: a one-shot loopback listener that
 * proves an exploit achieved a callback. No persistence, no implant, no
 * spreading — and it only ever binds loopback.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { RedAuditLog } from "../audit.js";

export interface CallbackProof {
  at: string;
  remote: string;
  path: string;
  method: string;
}

export interface LabListener {
  port: number;
  callback: Promise<CallbackProof>;
  close: () => void;
}

export interface LabListenerOptions {
  /** 0 selects an ephemeral loopback port (returned in `port`). */
  port?: number;
  timeoutSec: number;
  authzId?: string | null;
  audit?: RedAuditLog;
  signal?: AbortSignal;
}

/** Open a loopback listener before generating a callback payload. */
export async function openLabListener(opts: LabListenerOptions): Promise<LabListener> {
  let settled = false;
  let timer: NodeJS.Timeout;
  let onAbort: (() => void) | undefined;
  let close: () => void = () => {};
  const server = http.createServer((req, res) => {
    res.statusCode = 204;
    res.end();
    if (settled) return;
    settled = true;
    const listenerPort = (server.address() as AddressInfo).port;
    const proof: CallbackProof = {
      at: new Date().toISOString(),
      remote: req.socket.remoteAddress ?? "unknown",
      path: req.url ?? "/",
      method: req.method ?? "GET",
    };
    close();
    opts.audit?.append({
      authzId: opts.authzId ?? null,
      capability: "red.lab_listener",
      action: "callback",
      target: `http://127.0.0.1:${listenerPort}${proof.path}`,
      params: {},
      outcome: "completed",
      reason: `callback from ${proof.remote}`,
    });
    resolveCallback(proof);
  });

  let resolveCallback: (proof: CallbackProof) => void = () => {};
  let rejectCallback: (err: Error) => void = () => {};
  const callback = new Promise<CallbackProof>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const finishError = (err: Error, reason: string): void => {
    if (settled) return;
    settled = true;
    close();
    opts.audit?.append({
      authzId: opts.authzId ?? null,
      capability: "red.lab_listener",
      action: "callback",
      target: `http://127.0.0.1:${(server.address() as AddressInfo | null)?.port ?? opts.port ?? 0}`,
      params: {},
      outcome: "failed",
      reason,
    });
    rejectCallback(err);
  };

  close = (): void => {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    server.closeAllConnections?.();
    server.close();
  };

  server.on("error", (err) => finishError(err, "listener error"));
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1");
  });

  timer = setTimeout(() => finishError(new Error(`callback timeout after ${opts.timeoutSec}s`), "callback timeout"), opts.timeoutSec * 1000);
  onAbort = (): void => finishError(new Error("callback wait aborted"), "callback wait aborted");
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  return { port: (server.address() as AddressInfo).port, callback, close };
}

/** Backward-compatible one-shot helper for existing callers. */
export async function awaitCallback(
  port: number,
  timeoutSec: number,
  opts: { authzId?: string | null; audit?: RedAuditLog; signal?: AbortSignal } = {},
): Promise<CallbackProof> {
  const listener = await openLabListener({ ...opts, port, timeoutSec });
  return listener.callback;
}

/** The port the lab listener would use (helper for capability wiring/tests). */
export function listenerPortFrom(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}
