import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BuildMenuError } from './grants.js';

export const MAX_PREVIEWS = 3;
const PORT_ATTEMPTS = 3;
const BOOT_KEYS = ['PATH', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'SYSTEMROOT', 'WINDIR'] as const;
const UNSAFE_TOOLCHAIN_VALUE = /sk-|bearer|aiza|grant[_-]?id\s*[:=]|https:\/\/|javascript:/i;
const SHELLS = new Set(['cmd.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe', 'sh.exe', 'cmd', 'powershell', 'pwsh', 'bash', 'sh']);

export type StartIdentityReader = (pid: number) => string | null;

export interface LiveLease {
  leaseId: string;
  projectId: string;
  jobId: string;
  spawnNonce: string;
  messageNonce: string;
  startedAt: number;
  pid: number | null;
  port: number | null;
  child: ChildProcess | null;
  state: 'starting' | 'running' | 'stopped' | 'interrupted';
  restarts: number;
  startIdentity: string | null;
  gaveUp?: () => void;
}

export interface StartedLease {
  leaseId: string;
  projectId: string;
  jobId: string;
  spawnNonce: string;
  messageNonce: string;
  startedAt: number;
  pid: number;
  port: number;
  url: string;
}

export function ownedTreeStopCommand(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F'];
}

export function leaseEnv(toolchain: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BOOT_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  for (const [key, value] of Object.entries(toolchain)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) throw new BuildMenuError('unsafe_path', 400);
    if (/secret|token|key|password|api/i.test(key)) throw new BuildMenuError('unsafe_path', 400);
    if (UNSAFE_TOOLCHAIN_VALUE.test(value)) throw new BuildMenuError('unsafe_path', 400);
    env[key] = value;
  }
  return env;
}

export function releaseStalePid(record: { pid: number }, ownedPids: ReadonlySet<number>): 'interrupted' {
  if (ownedPids.has(record.pid)) throw new BuildMenuError('busy', 409);
  return 'interrupted';
}

function assertExecutable(executable: string): void {
  if (!path.isAbsolute(executable)) throw new BuildMenuError('unsafe_path', 400);
  const base = path.basename(executable).toLowerCase();
  if (SHELLS.has(base)) throw new BuildMenuError('unsafe_path', 400);
  if (!fs.existsSync(executable)) throw new BuildMenuError('missing_requirement', 400);
}

function assertArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (!/^[\w./:\\:@+=,-]+$/.test(arg)) throw new BuildMenuError('unsafe_path', 400);
  }
}

function waitForChild(child: ChildProcess, timeoutMs: number, signal?: AbortSignal): Promise<'ready' | 'conflict' | 'failed' | 'aborted'> {
  return new Promise((resolve) => {
    let settled = false;
    let text = '';
    const finish = (outcome: 'ready' | 'conflict' | 'failed' | 'aborted'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish('aborted');
    const timer = setTimeout(() => finish('failed'), timeoutMs);
    if (signal?.aborted) finish('aborted');
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.resume();
    child.stdout?.on('data', (chunk: string) => {
      text += chunk;
      if (text.includes('EADDRINUSE')) finish('conflict');
      else if (text.includes('READY')) finish('ready');
    });
    child.on('exit', (code) => {
      if (code === 98 || text.includes('EADDRINUSE')) finish('conflict');
      else if (text.includes('READY')) finish('ready');
      else finish('failed');
    });
    child.on('error', () => finish('failed'));
  });
}

export class ProcessLeaseRegistry {
  private readonly leases = new Map<string, LiveLease>();
  constructor(
    private readonly graceMs = 5_000,
    private readonly readStartIdentity?: StartIdentityReader,
  ) {}

  runningPid(jobId: string): number | null {
    for (const lease of this.leases.values()) {
      if (lease.jobId !== jobId || lease.state !== 'running' || !lease.pid || !lease.child) continue;
      if (lease.child.exitCode !== null || lease.child.signalCode !== null) continue;
      return lease.pid;
    }
    return null;
  }

  liveCount(): number {
    let count = 0;
    for (const lease of this.leases.values()) {
      if (lease.state === 'starting' || lease.state === 'running') count += 1;
    }
    return count;
  }

  ownedPids(): Set<number> {
    const pids = new Set<number>();
    for (const lease of this.leases.values()) {
      if (lease.pid) pids.add(lease.pid);
    }
    return pids;
  }

  async start(input: {
    projectId: string;
    jobId: string;
    executable: string;
    args: readonly string[];
    cwd: string;
    ports: readonly number[];
    toolchainEnv?: Readonly<Record<string, string>>;
    readyTimeoutMs?: number;
    signal?: AbortSignal;
    onGaveUp?: () => void;
  }): Promise<StartedLease> {
    if (input.signal?.aborted) throw new BuildMenuError('cancelled', 409);
    if (this.liveCount() >= MAX_PREVIEWS) throw new BuildMenuError('busy', 409);
    assertExecutable(input.executable);
    assertArgs(input.args);
    const ports = input.ports.slice(0, PORT_ATTEMPTS);
    if (ports.length === 0 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new BuildMenuError('invalid_request', 400);
    }
    const lease: LiveLease = {
      leaseId: `lease_${randomBytes(8).toString('hex')}`,
      projectId: input.projectId,
      jobId: input.jobId,
      spawnNonce: randomBytes(16).toString('hex'),
      messageNonce: randomBytes(16).toString('hex'),
      startedAt: Date.now(),
      pid: null,
      port: null,
      child: null,
      state: 'starting',
      restarts: 0,
      startIdentity: null,
      gaveUp: input.onGaveUp,
    };
    this.leases.set(lease.leaseId, lease);
    const env = leaseEnv(input.toolchainEnv);
    try {
      for (const port of ports) {
        const args = [...input.args, '--port', String(port)];
        assertArgs(args);
        const child = spawn(input.executable, args, {
          cwd: input.cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        lease.child = child;
        lease.pid = child.pid ?? null;
        lease.port = port;
        this.rememberIdentity(lease);
        const outcome = await waitForChild(child, input.readyTimeoutMs ?? 5_000, input.signal);
        if (outcome === 'aborted') {
          await this.forceChild(child);
          throw new BuildMenuError('cancelled', 409);
        }
        if (outcome === 'ready' && child.pid) {
          lease.state = 'running';
          this.armCrashRestart(lease, { executable: input.executable, args, cwd: input.cwd, env });
          return {
            leaseId: lease.leaseId,
            projectId: lease.projectId,
            jobId: lease.jobId,
            spawnNonce: lease.spawnNonce,
            messageNonce: lease.messageNonce,
            startedAt: lease.startedAt,
            pid: child.pid,
            port,
            url: `http://127.0.0.1:${port}/`,
          };
        }
        await this.forceChild(child);
        lease.child = null;
        lease.pid = null;
        if (outcome !== 'conflict') throw new BuildMenuError('tool_failed', 500);
      }
      throw new BuildMenuError('port_exhausted', 503);
    } catch (error) {
      lease.state = 'stopped';
      this.leases.delete(lease.leaseId);
      throw error;
    }
  }

  async stop(leaseId: string, jobId: string): Promise<void> {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.jobId !== jobId) throw new BuildMenuError('not_found', 404);
    if (lease.state === 'stopped' || lease.state === 'interrupted') return;
    lease.state = 'stopped';
    const child = lease.child;
    const pid = lease.pid;
    const recorded = lease.startIdentity;
    lease.child = null;
    if (!child || child.pid !== pid) return;
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM'); } catch { /* grace then owned-tree force */ }
      const exited = await exitedWithin(child, this.graceMs);
      if (!exited && child.pid === pid && child.exitCode === null && child.signalCode === null) await this.forceOwnedTree(child, recorded);
    }
    if (child.exitCode !== null || child.signalCode !== null) lease.pid = null;
  }

  private async forceOwnedTree(child: ChildProcess, recorded: string | null): Promise<void> {
    const pid = child.pid;
    if (!pid || child.exitCode !== null || child.signalCode !== null) return;
    if (this.startIdentityDiffers(pid, recorded)) {
      this.dropPid(pid);
      return;
    }
    if (process.platform === 'win32') await killOwnedTree(pid);
    else child.kill('SIGKILL');
    await exitedWithin(child, this.graceMs);
  }

  private rememberIdentity(lease: LiveLease): void {
    const pid = lease.pid;
    if (!pid || !this.readStartIdentity) {
      lease.startIdentity = null;
      return;
    }
    try {
      lease.startIdentity = this.readStartIdentity(pid);
    } catch {
      lease.startIdentity = null;
    }
  }

  private startIdentityDiffers(pid: number, recorded: string | null): boolean {
    if (!this.readStartIdentity) return false;
    let live: string | null;
    try {
      live = this.readStartIdentity(pid);
    } catch {
      live = null;
    }
    return live !== recorded;
  }

  private dropPid(pid: number): void {
    for (const lease of this.leases.values()) {
      if (lease.pid === pid) lease.pid = null;
    }
  }

  private recordedIdentity(child: ChildProcess): string | null {
    for (const lease of this.leases.values()) {
      if (lease.child === child) return lease.startIdentity;
    }
    return null;
  }

  private armCrashRestart(lease: LiveLease, spec: { executable: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }): void {
    const child = lease.child;
    if (!child || lease.state !== 'running') return;
    const again = (): void => this.restartOrGiveUp(lease, spec, child);
    if (child.exitCode !== null || child.signalCode !== null) {
      again();
      return;
    }
    child.once('exit', again);
  }

  private restartOrGiveUp(lease: LiveLease, spec: { executable: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }, exited: ChildProcess): void {
    if (lease.state !== 'running' || lease.child !== exited) return;
    if (lease.restarts >= 1) {
      lease.state = 'interrupted';
      lease.child = null;
      lease.pid = null;
      const notify = lease.gaveUp;
      lease.gaveUp = undefined;
      try { notify?.(); } catch { /* the lease is already interrupted */ }
      return;
    }
    lease.restarts += 1;
    const next = spawn(spec.executable, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    next.stdout?.resume();
    next.stderr?.resume();
    next.on('error', () => undefined);
    lease.child = next;
    lease.pid = next.pid ?? null;
    this.rememberIdentity(lease);
    this.armCrashRestart(lease, spec);
  }

  private async forceChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await this.forceOwnedTree(child, this.recordedIdentity(child));
  }
}

export function killOwnedTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise((resolve) => {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ownedTreeStopCommand(pid), {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('exit', () => resolve());
    killer.once('error', () => resolve());
  });
}

function exitedWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode !== null || child.signalCode !== null), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
