/**
 * Lab callback listener (RED_TEAM_BUILD_SPEC §6.10, spec O-2 default).
 *
 * Detection-only stand-in for a C2 implant: a one-shot loopback listener that
 * proves an exploit achieved a callback (e.g. the deser URLDNS OOB proof).
 * No persistence, no implant, no spreading — and it only ever binds loopback.
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

/**
 * Await one callback on 127.0.0.1:<port>. Resolves with the proof on the first
 * request, then closes the listener. Rejects on timeout or abort. When an
 * audit log is provided the outcome is recorded either way.
 */
export function awaitCallback(
  port: number,
  timeoutSec: number,
  opts: { authzId?: string | null; audit?: RedAuditLog; signal?: AbortSignal } = {},
): Promise<CallbackProof> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.statusCode = 204;
      res.end();
      const proof: CallbackProof = {
        at: new Date().toISOString(),
        remote: req.socket.remoteAddress ?? "unknown",
        path: req.url ?? "/",
        method: req.method ?? "GET",
      };
      cleanup();
      opts.audit?.append({
        authzId: opts.authzId ?? null,
        capability: "red.lab_listener",
        action: "callback",
        target: `http://127.0.0.1:${port}${proof.path}`,
        params: {},
        outcome: "completed",
        reason: `callback from ${proof.remote}`,
      });
      resolve(proof);
    });
    const timer = setTimeout(() => {
      cleanup();
      opts.audit?.append({
        authzId: opts.authzId ?? null,
        capability: "red.lab_listener",
        action: "callback",
        target: `http://127.0.0.1:${port}`,
        params: {},
        outcome: "failed",
        reason: "callback timeout",
      });
      reject(new Error(`callback timeout after ${timeoutSec}s`));
    }, timeoutSec * 1000);
    const onAbort = (): void => {
      cleanup();
      reject(new Error("callback wait aborted"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      server.close();
    };
    server.on("error", (err) => {
      cleanup();
      reject(err);
    });
    // Lab-only: the listener binds loopback so it can never face the network.
    server.listen(port, "127.0.0.1");
  });
}

/** The port the lab listener would use (helper for capability wiring/tests). */
export function listenerPortFrom(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}
