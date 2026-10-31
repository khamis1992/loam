/**
 * Per-task execution container.
 *
 * The OS sandbox (srt) isolates one command on the host; this module goes one
 * step further and gives each task its own Docker container, so two concurrent
 * tasks share neither filesystem nor process table. The task workspace is the
 * only bind mount (`/workspace`), the container is non-root, drops every
 * capability, has a pid/memory cap and defaults to `--network none`.
 *
 * Opt-in through `sandbox.container.enabled` (or `LOAM_SANDBOX_CONTAINER=1`).
 * The container is created lazily on the first shell command of a task and
 * removed when the task ends; `pruneContainers()` sweeps anything a crash left
 * behind at the next boot.
 */
import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import { log } from "../log.js";

const run = promisify(execFile);

/** Injectable docker CLI plumbing so tests never need a real daemon. */
type DockerRun = (args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>;
const defaultDockerRun: DockerRun = (args, opts) => run("docker", args, opts ?? {});
let dockerRun: DockerRun = defaultDockerRun;
let dockerSpawn: (args: string[]) => ChildProcessWithoutNullStreams = (args) =>
  spawn("docker", args, { windowsHide: true, env: { ...process.env } }) as ChildProcessWithoutNullStreams;

/** Test seam: swap the docker CLI plumbing (also clears the availability probe). */
export function __setDockerForTests(runner: DockerRun | null, spawner?: (args: string[]) => ChildProcessWithoutNullStreams): void {
  dockerRun = runner ?? defaultDockerRun;
  if (spawner) dockerSpawn = spawner;
  dockerProbe = undefined;
}

export const CONTAINER_LABEL = "loam.task";
export const CONTAINER_PREFIX = "loam-task-";
export const DEFAULT_IMAGE = "node:22-alpine";

export interface ContainerLimits {
  image: string;
  network: "none" | "bridge";
  cpus: number;
  memoryMb: number;
}

/** The effective limits, from config with environment overrides. */
export function containerLimits(cfg: Config): ContainerLimits {
  const c = cfg.sandbox?.container;
  const env = process.env;
  return {
    image: env.LOAM_SANDBOX_IMAGE?.trim() || c?.image || DEFAULT_IMAGE,
    network: (env.LOAM_SANDBOX_NETWORK === "bridge" || c?.network === "bridge") ? "bridge" : "none",
    cpus: Number(env.LOAM_SANDBOX_CPUS) > 0 ? Number(env.LOAM_SANDBOX_CPUS) : c?.cpus ?? 2,
    memoryMb: Number(env.LOAM_SANDBOX_MEMORY_MB) > 0 ? Number(env.LOAM_SANDBOX_MEMORY_MB) : c?.memoryMb ?? 2048,
  };
}

/** True when the container mode is switched on (availability is checked separately). */
export function containerModeEnabled(cfg: Config): boolean {
  const env = (process.env.LOAM_SANDBOX_CONTAINER ?? "").trim();
  if (env === "0" || env === "false") return false;
  if (env === "1" || env === "true") return true;
  return cfg.sandbox?.container?.enabled === true;
}

let dockerProbe: Promise<boolean> | undefined;
/** Probe the Docker daemon once per process. */
export function dockerAvailable(): Promise<boolean> {
  dockerProbe ??= dockerRun(["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  return dockerProbe;
}

function containerName(taskId: string): string {
  return `${CONTAINER_PREFIX}${taskId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 60)}`;
}

/** Host path -> `/workspace/...`; a path outside the workspace maps to /workspace. */
export function toContainerPath(hostPath: string, workspace: string): string {
  const ws = workspace.replace(/[\\/]+$/, "");
  const normalized = hostPath.replace(/\\/g, "/");
  const root = ws.replace(/\\/g, "/");
  if (normalized === root) return "/workspace";
  if (normalized.startsWith(`${root}/`)) return `/workspace${normalized.slice(root.length)}`;
  return "/workspace";
}

const creating = new Map<string, Promise<string>>();

/** Create (or reuse) the task's container. One in-flight create per task. */
export function ensureContainer(taskId: string, workspace: string, limits: ContainerLimits): Promise<string> {
  const name = containerName(taskId);
  const inFlight = creating.get(taskId);
  if (inFlight) return inFlight;
  const work = (async (): Promise<string> => {
    const existing = await dockerRun(["inspect", "-f", "{{.State.Running}}", name], { timeout: 10_000 })
      .then((r) => r.stdout.trim())
      .catch(() => "");
    if (existing === "true") return name;
    if (existing === "false") {
      await dockerRun(["start", name], { timeout: 20_000 });
      return name;
    }
    await dockerRun([
      "run", "-d", "--name", name,
      "--label", `${CONTAINER_LABEL}=${taskId}`,
      "--network", limits.network,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "256",
      "--memory", `${limits.memoryMb}m`,
      "--cpus", String(limits.cpus),
      "--user", "1000:1000",
      "--workdir", "/workspace",
      "--env", "HOME=/tmp",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
      "-v", `${workspace}:/workspace`,
      "--entrypoint", "sh",
      limits.image,
      "-c", "tail -f /dev/null",
    ], { timeout: 120_000 });    log.info(`task container ready: ${name} (${limits.image}, network=${limits.network})`);
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
  env?: Record<string, string>;
  limits: ContainerLimits;
}

/** Run a command inside the task container. The host shell is used only as the client. */
export async function spawnInContainer(opts: ContainerExec): Promise<ChildProcessWithoutNullStreams> {
  const name = await ensureContainer(opts.taskId, opts.workspace, opts.limits);
  const args = ["exec", "-i", "--workdir", toContainerPath(opts.cwd, opts.workspace)];
  for (const [key, value] of Object.entries(opts.env ?? {})) args.push("--env", `${key}=${value}`);
  args.push(name, "sh", "-lc", opts.command);
  return dockerSpawn(args);
}

/** Remove the task container and its anonymous volumes. Never throws. */
export async function removeContainer(taskId: string): Promise<void> {
  const name = containerName(taskId);
  try {
    await dockerRun(["rm", "-f", "-v", name], { timeout: 30_000 });
    log.info(`task container removed: ${name}`);
  } catch {
    /* already gone */
  }
}

/** Sweep every container a previous process left behind (boot-time). */
export async function pruneContainers(): Promise<void> {
  if (!(await dockerAvailable())) return;
  try {
    const { stdout } = await dockerRun(["ps", "-aq", "--filter", `label=${CONTAINER_LABEL}`], { timeout: 15_000 });
    const ids = stdout.split(/\s+/).filter(Boolean);
    if (ids.length === 0) return;
    await dockerRun(["rm", "-f", "-v", ...ids], { timeout: 60_000 });
    log.info(`pruned ${ids.length} stale task container(s)`);
  } catch {
    /* docker unavailable or nothing to prune */
  }
}

/** Name for tests/status. */
export function containerNameFor(taskId: string): string {
  return containerName(taskId);
}
