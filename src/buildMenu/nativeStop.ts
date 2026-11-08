import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BuildMenuError } from './grants.js';
import { killOwnedTree } from './processLease.js';

export interface NativeLease {
  leaseId: string;
  spawnNonce: string;
  child: ChildProcess;
  tree: boolean;
  stopped: boolean;
}

export function openNativeLease(leaseId: string, child: ChildProcess, tree: boolean): NativeLease {
  return { leaseId, spawnNonce: randomBytes(16).toString('hex'), child, tree, stopped: false };
}

export function watchNativeExit(lease: NativeLease, onExit: () => void): void {
  const report = (): void => {
    if (lease.stopped) return;
    onExit();
  };
  if (lease.child.exitCode !== null || lease.child.signalCode !== null) {
    report();
    return;
  }
  lease.child.once('exit', report);
}

export function waitForReadyFile(file: string, timeoutMs: number, signal: AbortSignal, nonce: string): Promise<boolean> {
  if (signal.aborted || !/^[a-f0-9]{32}$/.test(nonce)) return Promise.resolve(false);
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = (): void => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      if (fs.existsSync(file)) {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          resolve(false);
          return;
        }
        const text = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
        if (text === nonce) {
          resolve(true);
          return;
        }
      }
      if (Date.now() - started > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

export async function stopNativeLease(lease: NativeLease, spawnNonce: string): Promise<void> {
  if (lease.spawnNonce !== spawnNonce) throw new BuildMenuError('not_found', 404);
  if (lease.stopped) return;
  lease.stopped = true;
  const child = lease.child;
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await exitedWithin(child, 1_000)) return;
  if (!lease.tree || child.pid !== pid || child.exitCode !== null) return;
  if (process.platform === 'win32') await killOwnedTree(pid);
  else child.kill('SIGKILL');
  await exitedWithin(child, 3_000);
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
