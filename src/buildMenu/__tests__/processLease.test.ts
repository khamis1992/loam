import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildMenuError } from '../grants.js';
import { ProcessLeaseRegistry, ownedTreeStopCommand, releaseStalePid, type StartedLease } from '../processLease.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'leaseFixture.cjs');

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

function hold(port = 0): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
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

test('owned stop command targets the pid and never an image name', () => {
  const args = ownedTreeStopCommand(4242);
  assert.deepEqual(args, ['/PID', '4242', '/T', '/F']);
  assert.equal(args.includes('/IM'), false);
  const source = fs.readFileSync(new URL('../processLease.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('/IM'), false);
  assert.equal(source.includes('prune'), false);
  assert.match(source, /graceMs = 5_000/);
  assert.match(source, /ownedTreeStopCommand\(pid\)/);
});

test('stop is callable twice and does not prune an unrelated process', async () => {
  const held = await hold();
  await closeServer(held.server);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-twice-'));
  const registry = new ProcessLeaseRegistry(200);
  const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const strangerPid = stranger.pid ?? 0;
  assert.equal(strangerPid > 0, true);
  let started: StartedLease | null = null;
  try {
    started = await registry.start({
      projectId: 'app_abcdefghijkl',
      jobId: 'job_twice',
      executable: process.execPath,
      args: [fixture],
      cwd,
      ports: [held.port],
    });
    assert.equal(registry.ownedPids().has(started.pid), true);
    assert.equal(alive(strangerPid), true);
    await registry.stop(started.leaseId, started.jobId);
    await registry.stop(started.leaseId, started.jobId);
    assert.equal(await gone(started.pid), true);
    assert.equal(registry.ownedPids().has(started.pid), false);
    assert.equal(releaseStalePid({ pid: started.pid }, registry.ownedPids()), 'interrupted');
    assert.equal(alive(strangerPid), true);
    assert.equal(registry.liveCount(), 0);
  } finally {
    if (started) await registry.stop(started.leaseId, started.jobId).catch(() => undefined);
    try { stranger.kill(); } catch { /* already gone */ }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('busy port is skipped, secrets stay out, and a foreign job cannot stop it', async () => {
  const occupied = await hold();
  const free = await hold();
  await closeServer(free.server);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-'));
  const registry = new ProcessLeaseRegistry(500);
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-secret';
  let started: StartedLease | null = null;
  try {
    started = await registry.start({
      projectId: 'app_abcdefghijkl',
      jobId: 'job_one',
      executable: process.execPath,
      args: [fixture],
      cwd,
      ports: [occupied.port, free.port],
    });
    assert.equal(started.port, free.port);
    assert.match(started.messageNonce, /^[a-f0-9]{32}$/);
    assert.notEqual(started.messageNonce, started.spawnNonce);
    assert.equal(started.startedAt <= Date.now(), true);
    assert.equal(started.startedAt > Date.now() - 10_000, true);
    assert.equal(started.pid > 0, true);
    const keys = fs.readFileSync(path.join(cwd, 'env-keys.txt'), 'utf8');
    assert.equal(keys.includes('OPENAI_API_KEY'), false);
    assert.equal(keys.includes('sk-test-secret'), false);
    await assert.rejects(
      registry.stop(started.leaseId, 'job_other'),
      (error: unknown) => error instanceof BuildMenuError && error.status === 404,
    );
    assert.equal(alive(started.pid), true);
    const stillHeld = await hold(occupied.port).then(() => false, () => true);
    assert.equal(stillHeld, true);
    await registry.stop(started.leaseId, started.jobId);
    await registry.stop(started.leaseId, started.jobId);
    assert.equal(await gone(started.pid), true);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    occupied.server.close();
    if (started) await registry.stop(started.leaseId, started.jobId).catch(() => undefined);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a fourth preview is refused and one stop leaves the other previews running', async () => {
  const registry = new ProcessLeaseRegistry(500);
  const started: StartedLease[] = [];
  const dirs: string[] = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      const slot = await hold();
      await closeServer(slot.server);
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-'));
      dirs.push(cwd);
      started.push(await registry.start({
        projectId: 'app_abcdefghijkl',
        jobId: `job_${index}`,
        executable: process.execPath,
        args: [fixture],
        cwd,
        ports: [slot.port],
      }));
    }
    const extra = await hold();
    await closeServer(extra.server);
    const refused = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-'));
    dirs.push(refused);
    await assert.rejects(
      registry.start({
        projectId: 'app_abcdefghijkl',
        jobId: 'job_extra',
        executable: process.execPath,
        args: [fixture],
        cwd: refused,
        ports: [extra.port],
      }),
      (error: unknown) => error instanceof BuildMenuError && error.status === 409,
    );
    await registry.stop(started[0]!.leaseId, started[0]!.jobId);
    assert.equal(alive(started[1]!.pid), true);
    assert.equal(alive(started[2]!.pid), true);
  } finally {
    for (const lease of started) await registry.stop(lease.leaseId, lease.jobId).catch(() => undefined);
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cancelling a starting preview stops that process and leaves the other preview up', async () => {
  const registry = new ProcessLeaseRegistry(200);
  const keeperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-keep-'));
  const hangDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-hang-'));
  const earlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-early-'));
  const hangScript = path.join(hangDir, 'hang.cjs');
  fs.writeFileSync(hangScript, 'const fs=require("node:fs");const path=require("node:path");fs.writeFileSync(path.join(process.cwd(),"pid.txt"),String(process.pid));setInterval(()=>{},1000);\n');
  const keeperPort = await hold();
  await closeServer(keeperPort.server);
  const hangPort = await hold();
  await closeServer(hangPort.server);
  const earlyPort = await hold();
  await closeServer(earlyPort.server);
  let keeper: StartedLease | null = null;
  try {
    keeper = await registry.start({
      projectId: 'app_abcdefghijkl',
      jobId: 'job_keep',
      executable: process.execPath,
      args: [fixture],
      cwd: keeperDir,
      ports: [keeperPort.port],
    });
    const controller = new AbortController();
    const pending = registry.start({
      projectId: 'app_abcdefghijkl',
      jobId: 'job_hang',
      executable: process.execPath,
      args: [hangScript],
      cwd: hangDir,
      ports: [hangPort.port],
      readyTimeoutMs: 5_000,
      signal: controller.signal,
    });
    const pidFile = path.join(hangDir, 'pid.txt');
    for (let attempt = 0; attempt < 40 && !fs.existsSync(pidFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fs.existsSync(pidFile), true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof BuildMenuError && error.message === 'cancelled' && error.status === 409,
    );
    assert.equal(await gone(pid), true);
    assert.equal(registry.liveCount(), 1);
    assert.equal(alive(keeper.pid), true);
    const early = new AbortController();
    early.abort();
    await assert.rejects(
      registry.start({
        projectId: 'app_abcdefghijkl',
        jobId: 'job_early',
        executable: process.execPath,
        args: [hangScript],
        cwd: earlyDir,
        ports: [earlyPort.port],
        signal: early.signal,
      }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'cancelled',
    );
    assert.equal(fs.existsSync(path.join(earlyDir, 'pid.txt')), false);
    assert.equal(alive(keeper.pid), true);
    assert.equal(registry.liveCount(), 1);
  } finally {
    if (keeper) await registry.stop(keeper.leaseId, keeper.jobId).catch(() => undefined);
    fs.rmSync(keeperDir, { recursive: true, force: true });
    fs.rmSync(hangDir, { recursive: true, force: true });
    fs.rmSync(earlyDir, { recursive: true, force: true });
  }
});

test('a stale pid is interrupted and not terminated', async () => {
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const pid = sleeper.pid;
  assert.ok(pid);
  try {
    const registry = new ProcessLeaseRegistry(200);
    assert.equal(releaseStalePid({ pid }, registry.ownedPids()), 'interrupted');
    assert.equal(alive(pid), true);
  } finally {
    sleeper.kill();
  }
});

test('shell executables and raw prompts are refused before spawn', async () => {
  const registry = new ProcessLeaseRegistry(200);
  const shell = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
  await assert.rejects(
    registry.start({
      projectId: 'app_abcdefghijkl',
      jobId: 'job_shell',
      executable: shell,
      args: ['/c'],
      cwd: os.tmpdir(),
      ports: [9],
    }),
    /unsafe_path/,
  );
  await assert.rejects(
    registry.start({
      projectId: 'app_abcdefghijkl',
      jobId: 'job_prompt',
      executable: process.execPath,
      args: ['hello\nworld'],
      cwd: os.tmpdir(),
      ports: [9],
    }),
    /unsafe_path/,
  );
  assert.equal(registry.liveCount(), 0);
});

test('a crashed preview restarts once and the second crash stops', async () => {
  const held = await hold();
  await closeServer(held.server);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-crash-'));
  const registry = new ProcessLeaseRegistry(200);
  let started: StartedLease | null = null;
  let gaveUp = 0;
  try {
    started = await registry.start({
      projectId: 'app_abcdefghijkl',
      jobId: 'job_crash',
      executable: process.execPath,
      args: [fixture, '--exit-after-ready'],
      cwd,
      ports: [held.port],
      onGaveUp: () => { gaveUp += 1; },
    });
    const countFile = path.join(cwd, 'crash-count.txt');
    let count = 0;
    for (let attempt = 0; attempt < 40 && count < 2; attempt += 1) {
      count = fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8').length : 0;
      if (count < 2) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    count = fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8').length : 0;
    assert.equal(count, 2);
    assert.equal(gaveUp, 1);
    assert.equal(registry.liveCount(), 0);
    const names = fs.readdirSync(cwd).sort();
    assert.deepEqual(names, ['crash-count.txt', 'env-keys.txt']);
    await registry.stop(started.leaseId, started.jobId);
  } finally {
    if (started) await registry.stop(started.leaseId, started.jobId).catch(() => undefined);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('three busy ports stop the preview and leave the owners listening', async () => {
  const occupied = [await hold(), await hold(), await hold()];
  const spare = await hold();
  await closeServer(spare.server);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-ports-'));
  const registry = new ProcessLeaseRegistry(200);
  let started: StartedLease | null = null;
  try {
    await assert.rejects(
      registry.start({
        projectId: 'app_abcdefghijkl',
        jobId: 'job_ports',
        executable: process.execPath,
        args: [fixture],
        cwd,
        ports: [...occupied.map((item) => item.port), spare.port],
      }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'port_exhausted',
    );
    assert.equal(registry.liveCount(), 0);
    for (const item of occupied) {
      assert.equal((item.server.address() as net.AddressInfo).port, item.port);
    }
    started = await registry.start({
      projectId: 'app_abcdefghijkl',
      jobId: 'job_ports_ok',
      executable: process.execPath,
      args: [fixture],
      cwd,
      ports: [occupied[0]!.port, occupied[1]!.port, spare.port],
    });
    assert.equal(started.port, spare.port);
    const runtime = fs.readFileSync(path.resolve('src/buildMenu/kindRuntime.ts'), 'utf8');
    const serve = runtime.slice(runtime.indexOf('async function serveFile'), runtime.indexOf('function healthMarker'));
    assert.equal(serve.includes('freePorts(3)'), true);
  } finally {
    if (started) await registry.stop(started.leaseId, started.jobId).catch(() => undefined);
    await Promise.all(occupied.map((item) => closeServer(item.server)));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('stopping a preview does not start a replacement', async () => {
  const held = await hold();
  await closeServer(held.server);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-stop-'));
  const registry = new ProcessLeaseRegistry(200);
  let started: StartedLease | null = null;
  let gaveUp = 0;
  try {
    started = await registry.start({
      projectId: 'app_abcdefghijkl',
      jobId: 'job_stop',
      executable: process.execPath,
      args: [fixture],
      cwd,
      ports: [held.port],
      onGaveUp: () => { gaveUp += 1; },
    });
    await registry.stop(started.leaseId, started.jobId);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(fs.existsSync(path.join(cwd, 'crash-count.txt')), false);
    assert.equal(gaveUp, 0);
    assert.equal(registry.liveCount(), 0);
    assert.equal(await gone(started.pid), true);
  } finally {
    if (started) await registry.stop(started.leaseId, started.jobId).catch(() => undefined);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a changed start identity drops the pid and does not spawn taskkill', async () => {
  const hangDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-identity-'));
  const hangScript = path.join(hangDir, 'hang.cjs');
  fs.writeFileSync(hangScript, 'const fs=require("node:fs");const path=require("node:path");fs.writeFileSync(path.join(process.cwd(),"pid.txt"),String(process.pid));setInterval(()=>{},1000);\n');
  const slot = await hold();
  await closeServer(slot.server);
  let atSpawn = true;
  const reads: string[] = [];
  const registry = new ProcessLeaseRegistry(5_000, () => {
    const identity = atSpawn ? 'spawn-identity' : 'live-identity';
    reads.push(identity);
    return identity;
  });
  const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const strangerPid = stranger.pid ?? 0;
  const controller = new AbortController();
  let pid = 0;
  try {
    assert.equal(strangerPid > 0, true);
    const pending = registry.start({
      projectId: 'app_abcdefghijkl',
      jobId: 'job_identity',
      executable: process.execPath,
      args: [hangScript],
      cwd: hangDir,
      ports: [slot.port],
      readyTimeoutMs: 5_000,
      signal: controller.signal,
    });
    const pidFile = path.join(hangDir, 'pid.txt');
    for (let attempt = 0; attempt < 40 && !fs.existsSync(pidFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fs.existsSync(pidFile), true);
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(pid > 0, true);
    assert.deepEqual(reads, ['spawn-identity']);
    atSpawn = false;
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof BuildMenuError && error.message === 'cancelled' && error.status === 409,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(reads, ['spawn-identity', 'live-identity']);
    assert.equal(alive(pid), true);
    assert.equal(alive(strangerPid), true);
    assert.equal(registry.ownedPids().has(pid), false);
    assert.equal(registry.ownedPids().has(strangerPid), false);
    assert.equal(registry.liveCount(), 0);
  } finally {
    atSpawn = false;
    controller.abort();
    if (pid > 0 && alive(pid)) {
      try { process.kill(pid); } catch { /* the preview we spawned is already gone */ }
    }
    if (pid > 0) await gone(pid);
    try { stranger.kill(); } catch { /* the stranger we spawned is already gone */ }
    if (strangerPid > 0) await gone(strangerPid);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        fs.rmSync(hangDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
});
