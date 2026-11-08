import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessLeaseRegistry, type StartedLease } from '../processLease.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'leaseFixture.cjs');

type SpawnOptions = { file?: string; args?: string[] };
type SpawnMethod = (this: ChildProcess, options: SpawnOptions) => unknown;
type KillMethod = (this: ChildProcess, signal?: NodeJS.Signals | number) => boolean;

function isTaskkill(file: string | undefined): boolean {
  const base = path.basename(file ?? '').toLowerCase();
  return base === 'taskkill.exe' || base === 'taskkill';
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

function hold(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('stopping an already stopped preview lease does not throw or spawn a second taskkill', async () => {
  const held = await hold();
  await closeServer(held.server);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-second-stop-'));
  const registry = new ProcessLeaseRegistry(50);
  const proto = ChildProcess.prototype as unknown as { spawn: SpawnMethod; kill: KillMethod };
  const originalSpawn = proto.spawn;
  const originalKill = proto.kill;
  let taskkills = 0;
  proto.spawn = function (this: ChildProcess, options: SpawnOptions): unknown {
    if (isTaskkill(options?.file)) {
      taskkills += 1;
      const node = process.execPath;
      options.file = node;
      options.args = [node, '-e', 'process.exit(0)'];
    }
    return originalSpawn.call(this, options);
  };
  let started: StartedLease | null = null;
  try {
    started = await registry.start({
      projectId: 'app_abcdefghijkl',
      jobId: 'job_second_stop',
      executable: process.execPath,
      args: [fixture],
      cwd,
      ports: [held.port],
    });
    proto.kill = function () {
      return true;
    };
    await registry.stop(started.leaseId, started.jobId);
    const afterFirst = taskkills;
    await assert.doesNotReject(() => registry.stop(started!.leaseId, started!.jobId));
    assert.equal(taskkills, afterFirst);
    assert.equal(afterFirst, process.platform === 'win32' ? 1 : 0);
  } finally {
    proto.spawn = originalSpawn;
    proto.kill = originalKill;
    if (started) {
      for (let attempt = 0; attempt < 20 && alive(started.pid); attempt += 1) {
        try { process.kill(started.pid); } catch { /* the preview is already gone */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await gone(started.pid);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
});
