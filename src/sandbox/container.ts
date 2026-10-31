/**
 * Per-task execution container (GAP_REVIEW P2#13, blueprint gVisor-class gap).
 *
 * The OS sandbox (srt) isolates one command on the host; this module goes one
 * step further and gives each task its own Docker container, so two concurrent
 * tasks share neither filesystem nor process table. The task workspace is the
 * only bind mount (`/workspace`), the container runs as uid 1000 with every
 * capability dropped, `no-new-privileges`, a pid/memory/cpu cap and defaults
 * to `--network none` (bridge is opt-in and documented as unrestricted).
 *
 * Opt-in through `sandbox.container.enabled` (or `LOAM_SANDBOX_CONTAINER=1`).
 * The container is created lazily on the task's first shell command, reused by
 * every later command and interactive session of that task, and removed when
 * the task ends; `pruneContainers()` sweeps anything a crash left behind at
 * the next boot. Callers fail closed: with the mode enabled but Docker
 * unreachable, commands error out instead of dropping to the host shell.
 *
 * Everything talks to the `docker` CLI through the `impl` seam so unit tests
 * can drive the full argv surface without a daemon (`__setDockerForTests`).
 */
import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import { log } from "../log.js";

export const CONTAINER_LABEL = "loam.task";
export const CONTAINER_PREFIX = "loam-task-";
export const CONTAINER_WORKSPACE = "/workspace";
export const DEFAULT_IMAGE = "node:22-alpine";

/** Everything the module needs from Docker, swappable for tests. */
interface DockerImpl {
  execFile(file: string, args: string[], options: { timeout: number }): Promise<{ stdout: string }>;
  spawn(file: string, args: string[], options: { windowsHide: boolean }): ChildProcessWithoutNullStreams;
}

const realImpl: DockerImpl = {
  execFile: promisify(execFile) as DockerImpl["execFile"],
  spawn: spawn as unknown as DockerImpl["spawn"],
};

let impl: DockerImpl = realImpl;

/** Test seam (srt `__setSessionForTests` convention): swap the docker calls. */
export function __setDockerForTests(next?: Partial<DockerImpl>): void {
  impl = next ? { ...realImpl, ...next } : realImpl;
  dockerProbe = undefined;
}

export interface ContainerLimits {
  image: string;
  network: "none" | "bridge";
  cpus: number;
  memoryMb: number;
}

function clamp(n: number, lo: number, hi: number, dflt: number): number {
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/** The effective limits, from config with environment overrides, clamped. */
export function containerLimits(cfg: Config): ContainerLimits {
  const c = cfg.sandbox?.container;
  const env = process.env;
  const envNetwork = env.LOAM_SANDBOX_NETWORK?.trim();
  return {
    image: env.LOAM_SANDBOX_IMAGE?.trim() || c?.image || DEFAULT_IMAGE,
    network: envNetwork === "bridge" ? "bridge" : envNetwork === "none" ? "none" : c?.network === "bridge" ? "bridge" : "none",
    cpus: Math.round(clamp(Number(env.LOAM_SANDBOX_CPUS), 0.25, 8, c?.cpus ?? 2) * 100) / 100,
    memoryMb: Math.round(clamp(Number(env.LOAM_SANDBOX_MEMORY_MB), 256, 16384, c?.memoryMb ?? 2048)),
  };
}

/** True when the container mode is switched on (availability is checked separately). */
export function containerModeEnabled(cfg: Config): boolean {
  const env = (process.env.LOAM_SANDBOX_CONTAINER ?? "").trim().toLowerCase();
  if (env === "0" || env === "false") return false;
  if (env === "1" || env === "true") return true;
  return cfg.sandbox?.container?.enabled === true;
}

let dockerProbe: Promise<boolean> | undefined;

/** Probe the Docker daemon once per process (tests reset it through the seam). */
export function dockerAvailable(): Promise<boolean> {
  dockerProbe ??= impl
    .execFile("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  return dockerProbe;
}

function containerName(taskId: string): string {
  return `${CONTAINER_PREFIX}${taskId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 60)}`;
}

/** Name for status messages and tests. */
export function containerNameFor(taskId: string): string {
  return containerName(taskId);
}

/** Host path -> `/workspace/...`; a path outside the workspace maps to /workspace. */
export function toContainerPath(hostPath: string, workspace: string): string {
  const normalized = hostPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized === root) return CONTAINER_WORKSPACE;
  if (normalized.startsWith(`${root}/`)) return `${CONTAINER_WORKSPACE}${normalized.slice(root.length)}`;
  return CONTAINER_WORKSPACE;
}

const creating = new Map<string, Promise<string>>();
const pulledImages = new Set<string>();

/** Pull the image on first use so `docker run` cannot fail mid-task with an
 *  opaque pull error (the run timeout is far shorter than a cold pull). */
async function ensureImage(image: string): Promise<void> {
  if (pulledImages.has(image)) return;
  const present = await impl
    .execFile("docker", ["image", "inspect", image], { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!present) {
    log.info(`sandbox: pulling image ${image} (first use)`);
    await impl.execFile("docker", ["pull", image], { timeout: 600_000 });
  }
  pulledImages.add(image);
}

/** Create (or reuse) the task's container. One in-flight create per task. */
export function ensureContainer(taskId: string, workspace: string, limits: ContainerLimits): Promise<string> {
  const name = containerName(taskId);
  const inFlight = creating.get(taskId);
  if (inFlight) return inFlight;
  const work = (async (): Promise<string> => {
    // A missing host workspace would make Docker silently bind-mount an empty
    // directory it just created — the task would "lose" its files. Refuse.
    if (!existsSync(workspace)) {
      throw new Error(`sandbox: task workspace does not exist on host: ${workspace}`);
    }
    const existing = await impl
      .execFile("docker", ["inspect", "-f", "{{.State.Running}}", name], { timeout: 10_000 })
      .then((r) => r.stdout.trim())
      .catch(() => "");
    if (existing === "true") return name;
    if (existing === "false") {
      await impl.execFile("docker", ["start", name], { timeout: 20_000 });
      return name;
    }
    await ensureImage(limits.image);
    await impl.execFile("docker", [
      "run", "-d", "--name", name,
      "--label", `${CONTAINER_LABEL}=${taskId}`,
      "--network", limits.network,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "256",
      "--memory", `${limits.memoryMb}m`,
      "--cpus", String(limits.cpus),
      "--user", "1000:1000",
      "--workdir", CONTAINER_WORKSPACE,
      "--env", "HOME=/tmp",
      "--env", "LANG=C.UTF-8",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
      "-v", `${workspace}:${CONTAINER_WORKSPACE}`,
      "--entrypoint", "sh",
      limits.image,
      "-c", "tail -f /dev/null",
    ], { timeout: 120_000 });
    log.info(`sandbox: task container ready: ${name} (${limits.image}, network=${limits.network})`);
    return name;
  })().finally(() => creating.delete(taskId));
  creating.set(taskId, work);
  return work;
}

export interface ContainerExec {
  taskId: string;
  workspace: string;
  command: string;
  cwd: string;
  /** Minimal environment for the command — callers pass task-scoped vars only,
   *  never the whole host environment. */
  env?: Record<string, string>;
  limits: ContainerLimits;
}

/** Run a command inside the task container. The host `docker` client is only a
 *  pipe: stdout/stderr/exit flow back exactly like a host child process. */
export async function spawnInContainer(opts: ContainerExec): Promise<ChildProcessWithoutNullStreams> {
  const name = await ensureContainer(opts.taskId, opts.workspace, opts.limits);
  const args = ["exec", "-i", "--workdir", toContainerPath(opts.cwd, opts.workspace)];
  for (const [key, value] of Object.entries(opts.env ?? {})) args.push("--env", `${key}=${value}`);
  args.push("--env", "LANG=C.UTF-8", name, "sh", "-lc", opts.command);
  return impl.spawn("docker", args, { windowsHide: true });
}

export interface ContainerInteractive {
  taskId: string;
  workspace: string;
  cwd: string;
  limits: ContainerLimits;
}

/** Start a pipe-driven interactive `sh` inside the task container — the same
 *  stdin/stdout session model the powershell/cmd sessions use, so shell_write /
 *  shell_read / shell_kill drive it unchanged. */
export async function spawnInteractiveInContainer(opts: ContainerInteractive): Promise<ChildProcessWithoutNullStreams> {
  const name = await ensureContainer(opts.taskId, opts.workspace, opts.limits);
  return impl.spawn("docker", [
    "exec", "-i",
    "--workdir", toContainerPath(opts.cwd, opts.workspace),
    "--env", "LANG=C.UTF-8",
    name, "sh", "-l",
  ], { windowsHide: true });
}

/** Remove the task container and its anonymous volumes. Never throws. */
export async function removeContainer(taskId: string): Promise<void> {
  const name = containerName(taskId);
  try {
    await impl.execFile("docker", ["rm", "-f", "-v", name], { timeout: 30_000 });
    log.info(`sandbox: task container removed: ${name}`);
  } catch {
    /* already gone, or docker unreachable — pruneContainers sweeps at next boot */
  }
}

/** Sweep every container a previous process left behind (boot-time). */
export async function pruneContainers(): Promise<void> {
  if (!(await dockerAvailable())) return;
  try {
    const { stdout } = await impl.execFile("docker", ["ps", "-aq", "--filter", `label=${CONTAINER_LABEL}`], { timeout: 15_000 });
    const ids = stdout.split(/\s+/).filter(Boolean);
    if (ids.length === 0) return;
    await impl.execFile("docker", ["rm", "-f", "-v", ...ids], { timeout: 60_000 });
    log.info(`sandbox: pruned ${ids.length} stale task container(s)`);
  } catch {
    /* docker unavailable or nothing to prune */
  }
}
