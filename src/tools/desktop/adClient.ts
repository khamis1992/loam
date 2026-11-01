import { spawn, type ChildProcess } from "node:child_process";

import type { AdErr, AdOk } from "./adTypes.js";

/** Spawn seam: production spawns directly; tests inject a wrapper that pins
 *  fixture env. Always argv arrays — never a shell string. */
export type SpawnFn = (
  exe: string,
  args: string[],
  opts: { shell: false; windowsHide: boolean; env: Record<string, string> },
) => ChildProcess;

export interface AdCallOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  session?: string;
  stateRoot: string;
  headed?: boolean;
}

export interface AdCall<T> {
  env: AdOk<T> | AdErr | null;
  exitCode: number | null;
  stdoutBytes: number;
  ms: number;
  stderr: string;
  timedOut: boolean;
}

const MAX_STDOUT = 4_000_000;

/** The final argv: global flags first (--headed, --session), then the command.
 *  Pure so tests can pin the flag order without spawning anything. */
export function buildAdArgv(argv: string[], o: { headed?: boolean; session?: string }): string[] {
  return [...(o.headed ? ["--headed"] : []), ...(o.session ? ["--session", o.session] : []), ...argv];
}

/** Spawn the agent-desktop CLI with argv (never a shell string), parse its
 *  JSON envelope from stdout, and enforce a hard timeout that kills only the
 *  child we spawned. `--force` is forbidden outright (§1.5). */
export function runAd<T>(
  exe: string,
  argv: string[],
  o: AdCallOpts,
  spawnImpl: SpawnFn = spawn as unknown as SpawnFn,
): Promise<AdCall<T>> {
  const full = buildAdArgv(argv, o);
  if (full.includes("--force")) throw new Error("--force is forbidden");
  const t0 = performance.now();
  return new Promise((resolve) => {
    const child = spawnImpl(exe, full, {
      shell: false,
      windowsHide: true,
      env: {
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        USERPROFILE: process.env.USERPROFILE ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
        AGENT_DESKTOP_HOME: o.stateRoot,
      },
    });
    let out = Buffer.alloc(0);
    let err = "";
    let timedOut = false;
    let settled = false;
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* our own child only */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, (o.timeoutMs ?? 15_000) + 2_000);
    const onAbort = () => kill();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (d: Buffer) => {
      if (out.length < MAX_STDOUT) out = Buffer.concat([out, d]);
    });
    child.stderr!.on("data", (d: Buffer) => {
      if (err.length < 8_000) err += d.toString();
    });
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      let env: AdOk<T> | AdErr | null = null;
      try {
        env = JSON.parse(out.toString("utf8").trim()) as AdOk<T> | AdErr;
      } catch {
        env = null;
      }
      resolve({ env, exitCode: code, stdoutBytes: out.length, ms: performance.now() - t0, stderr: err, timedOut });
    };
    child.on("error", (e) => {
      err += String(e);
      done(null);
    });
    child.on("close", done);
  });
}
