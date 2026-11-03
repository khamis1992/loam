import { spawn } from "node:child_process";

import { runAd, type AdCall, type SpawnFn } from "./adClient.js";
import { AD_REF_RE, type AdSnapshot, type RefAction } from "./adTypes.js";
import { notDelivered, type ActResult, type DesktopBackend, type DesktopTarget, type ObserveOpts } from "./backend.js";

/** The agent-desktop implementation of DesktopBackend (§3.4). Every call goes
 *  through runAd with argv arrays only; `typeHeaded` is headed and its caller
 *  MUST have passed the foreground guard first (checked in the facade).
 *  `spawnImpl` is a test seam — production always spawns directly. */
export function agentDesktopBackend(
  exe: string,
  stateRoot: string,
  session: string,
  signal?: AbortSignal,
  spawnImpl: SpawnFn = spawn as unknown as SpawnFn,
): DesktopBackend {
  const call = <T>(argv: string[], timeoutMs?: number, headed = false) =>
    runAd<T>(exe, argv, { stateRoot, session, signal, timeoutMs, headed }, spawnImpl);
  const toResult = (c: AdCall<unknown>): ActResult => {
    if (!c.env) {
      return {
        ok: false,
        backend: "agent-desktop",
        delivery: "unknown",
        retry: "unknown",
        code: c.timedOut ? "TIMEOUT" : "NO_ENVELOPE",
        message: c.stderr.slice(0, 500) || `exit ${c.exitCode}`,
      };
    }
    if (c.env.ok) {
      const d = (c.env.data as { disposition?: { delivery?: ActResult["delivery"]; retry?: ActResult["retry"] } } | undefined)
        ?.disposition;
      return {
        ok: true,
        backend: "agent-desktop",
        delivery: d?.delivery ?? "delivered_unverified",
        retry: d?.retry ?? "unsafe",
        message: c.env.command,
        raw: c.env.data,
      };
    }
    const e = c.env.error;
    return {
      ok: false,
      backend: "agent-desktop",
      delivery: e.disposition?.delivery ?? "unknown",
      retry: e.disposition?.retry ?? "unknown",
      code: e.code,
      message: e.message,
      suggestion: e.suggestion,
      needsFreshSnapshot: !!e.recovery?.requires_fresh_snapshot,
      raw: e.details,
    };
  };
  const scope = (o: DesktopTarget) => [...(o.app ? ["--app", o.app] : []), ...(o.windowId ? ["--window-id", o.windowId] : [])];
  const badRef = (r: string) => !AD_REF_RE.test(r);
  return {
    id: "agent-desktop",
    async available() {
      const c = await call<{ version: string }>(["version"], 5_000);
      return c.env?.ok ? { ok: true, version: String((c.env.data as { version?: unknown }).version ?? "") } : { ok: false, reason: "version failed" };
    },
    async listWindows(t = {}) {
      return toResult(await call(["list-windows", ...scope(t)]));
    },
    async snapshot(o: ObserveOpts) {
      if (o.root && badRef(o.root)) return notDelivered("agent-desktop", "INVALID_ARGS", "root must be @sid:eN from the latest snapshot");
      const tm = o.timeoutMs ?? 3000;
      const argv = [
        "snapshot",
        ...scope(o),
        ...(o.interactiveOnly !== false ? ["-i"] : []),
        ...(o.compact !== false ? ["--compact"] : []),
        ...(o.skeleton ? ["--skeleton"] : []),
        ...(o.root ? ["--root", o.root] : []),
        ...(o.includeBounds ? ["--include-bounds"] : []),
        "--max-depth",
        String(Math.min(Math.max(o.maxDepth ?? 10, 1), 30)),
        "--timeout-ms",
        String(tm),
      ];
      const c = await call<AdSnapshot>(argv, tm + 5_000);
      const r = toResult(c);
      return c.env?.ok ? { ...r, snapshot: c.env.data as AdSnapshot } : r;
    },
    async find(t) {
      const lim = Math.min(Math.max(t.limit ?? 20, 1), 20);
      return toResult(
        await call([
          "find",
          ...scope(t),
          ...(t.role ? ["--role", t.role] : []),
          ...(t.name ? ["--name", t.name] : []),
          ...(t.exact ? ["--exact"] : []),
          "--limit",
          String(lim),
        ]),
      );
    },
    async act(ref: string, action: RefAction, value?: string) {
      if (badRef(ref)) return notDelivered("agent-desktop", "INVALID_ARGS", "ref must be @sid:eN from the latest snapshot");
      return toResult(await call([action, ref, ...(value !== undefined && value !== "" ? [value] : [])]));
    },
    async typeHeaded(ref, text) {
      // caller MUST have passed the guard
      if (badRef(ref)) return notDelivered("agent-desktop", "INVALID_ARGS", "ref must be @sid:eN");
      return toResult(await call(["type", ref, text], undefined, true));
    },
    async press(combo, t) {
      // never --force; the guard guarantees the target is frontmost
      return toResult(await call(["press", combo, ...scope(t)]));
    },
    async focusWindow(id) {
      return toResult(await call(["focus-window", "--window-id", id]));
    },
    async screenshot(t) {
      return toResult(await call(["screenshot", ...scope(t), t.out]));
    },
  };
}
