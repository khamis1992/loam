import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Roadmap §7 — isolated environment per task using a container runtime, or a
 * documented fallback. Pure isolation layer for the swarm engine: detect an
 * available container runtime (Docker first, then Podman), wrap verification
 * commands as sandboxed run specs, and degrade gracefully to plain local
 * execution when no runtime exists (this Windows dev machine has no guaranteed
 * runtime). No imports from the swarm service — the lead wires this in later;
 * the runner and detector are injectable so every path is testable offline. */

export type SandboxKind = "docker" | "podman" | null;

export interface SandboxInfo { kind: SandboxKind; version: string | null }

const execFileAsync = promisify(execFile);

/** Runs `<runtime> --version`; a missing binary or any spawn failure resolves
 * to null so detection never throws on machines without a runtime. */
async function defaultRunner(cmd: string, args: string[]): Promise<{ stdout: string } | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args);
    return { stdout };
  } catch {
    return null;
  }
}

const RUNTIME_PROBES: ReadonlyArray<"docker" | "podman"> = ["docker", "podman"];

/** Probes docker first, then podman, and returns the first runtime that
 * responds. `version` is the trimmed `--version` stdout (e.g.
 * "Docker version 24.0.7, build …"); a response with empty output still counts
 * as detection with a null version. Nothing responds → kind null. */
export async function detectSandbox(
  run: (cmd: string, args: string[]) => Promise<{ stdout: string } | null> = defaultRunner,
): Promise<SandboxInfo> {
  for (const kind of RUNTIME_PROBES) {
    const result = await run(kind, ["--version"]);
    if (!result) continue; // runtime absent or probe failed — try the next one
    const version = result.stdout.trim();
    return { kind, version: version.length > 0 ? version : null };
  }
  return { kind: null, version: null };
}

/** `C:\x\y` → `/c/x/y` (drive letter lowercased, backslashes to slashes) — the
 * MSYS-style mount path container runtimes on Windows accept for `-v`.
 * POSIX or relative inputs pass through unchanged. */
export function winToPosix(p: string): string {
  const forward = p.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(forward);
  if (!drive) return forward;
  return `/${drive[1]!.toLowerCase()}${drive[2] ?? ""}`;
}

export interface IsolatedSpec { kind: "sandboxed" | "local"; command: string; args: string[]; note: string }

export const DEFAULT_SANDBOX_IMAGE = "node:22-alpine";

/** Wraps a shell command line for the given sandbox. With a runtime present the
 * spec is `<runtime> run --rm -v <workspace>:/work -w /work <image> sh -c <command>`
 * so the task executes inside a throwaway container over its workspace. With no
 * runtime the spec degrades to a documented local fallback (cmd.exe on win32,
 * /bin/sh elsewhere). An empty/whitespace command throws — verifying nothing is
 * a caller bug, not something to paper over. */
export function buildIsolatedSpec(
  command: string,
  opts: { sandbox: SandboxInfo; workspace: string; image?: string },
): IsolatedSpec {
  if (command.trim().length === 0) throw new Error("empty command");
  const image = opts.image ?? DEFAULT_SANDBOX_IMAGE;
  if (opts.sandbox.kind !== null) {
    return {
      kind: "sandboxed",
      command: opts.sandbox.kind,
      args: ["run", "--rm", "-v", `${winToPosix(opts.workspace)}:/work`, "-w", "/work", image, "sh", "-c", command],
      note: `sandboxed via ${opts.sandbox.kind} (image ${image}); workspace mounted at /work`,
    };
  }
  if (process.platform === "win32") {
    return {
      kind: "local",
      command: "cmd.exe",
      args: ["/d", "/s", "/c", command],
      note: "no container runtime detected; local execution fallback",
    };
  }
  return { kind: "local", command: "/bin/sh", args: ["-c", command], note: "no container runtime detected; local execution fallback" };
}

export interface IsolationPolicy { mode: "off" | "auto"; image?: string }

/** LOAM_SWARM_SANDBOX: "off" (or unset, or any unrecognized value) → off — the
 * safe default; "auto"/"1" → auto, with the sandbox image taken from
 * LOAM_SWARM_SANDBOX_IMAGE when set to a non-empty value. */
export function readPolicy(env: NodeJS.ProcessEnv = process.env): IsolationPolicy {
  const raw = (env["LOAM_SWARM_SANDBOX"] ?? "").trim().toLowerCase();
  if (raw !== "auto" && raw !== "1") return { mode: "off" };
  const image = (env["LOAM_SWARM_SANDBOX_IMAGE"] ?? "").trim();
  return image.length > 0 ? { mode: "auto", image } : { mode: "auto" };
}

/** End-to-end resolution for one command: policy off (never probes) or a failed
 * detection yields the local fallback spec; policy auto with a detected runtime
 * yields the sandboxed spec with the policy image applied. */
export async function resolveExecution(
  command: string,
  opts: { workspace: string; env?: NodeJS.ProcessEnv; detect?: typeof detectSandbox },
): Promise<IsolatedSpec> {
  const policy = readPolicy(opts.env ?? process.env);
  let sandbox: SandboxInfo = { kind: null, version: null };
  if (policy.mode === "auto") {
    try {
      sandbox = await (opts.detect ?? detectSandbox)();
    } catch {
      sandbox = { kind: null, version: null }; // detection must never break execution
    }
  }
  if (sandbox.kind === null) {
    return buildIsolatedSpec(command, { sandbox, workspace: opts.workspace });
  }
  return buildIsolatedSpec(command, { sandbox, workspace: opts.workspace, image: policy.image });
}
