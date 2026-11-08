import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildMenuError } from '../grants.js';
import { openNativeLease, stopNativeLease, waitForReadyFile, watchNativeExit } from '../nativeStop.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

test('a native lease stops once, ignores a second stop, and rejects another nonce', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, shell: false });
  const pid = child.pid;
  assert.ok(pid);
  let kills = 0;
  const kill = child.kill.bind(child);
  child.kill = ((signal?: NodeJS.Signals) => {
    kills += 1;
    return kill(signal);
  }) as typeof child.kill;
  const lease = openNativeLease('native_job', child, true);
  try {
    await assert.rejects(
      stopNativeLease(lease, 'other-nonce'),
      (error: unknown) => error instanceof BuildMenuError && error.status === 404,
    );
    assert.equal(alive(pid), true);
    assert.equal(kills, 0);
    await stopNativeLease(lease, lease.spawnNonce);
    await stopNativeLease(lease, lease.spawnNonce);
    assert.equal(kills, 1);
    assert.equal(await gone(pid), true);
  } finally {
    if (alive(pid)) child.kill();
  }
});

test('stopping after exit does not signal the process again', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true, shell: false });
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let kills = 0;
  child.kill = (() => {
    kills += 1;
    return true;
  }) as typeof child.kill;
  const lease = openNativeLease('native_done', child, true);
  await stopNativeLease(lease, lease.spawnNonce);
  await stopNativeLease(lease, lease.spawnNonce);
  assert.equal(kills, 0);
});

test('an aborted ready wait returns before the timeout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-ready-'));
  const file = path.join(root, 'window-ready');
  const nonce = 'a'.repeat(32);
  const controller = new AbortController();
  const started = Date.now();
  const pending = waitForReadyFile(file, 10_000, controller.signal, nonce);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(Date.now() - started < 1_000, true);
  fs.writeFileSync(file, 'ready\n');
  assert.equal(await waitForReadyFile(file, 40, new AbortController().signal, nonce), false);
  fs.writeFileSync(file, `${nonce}\n`);
  assert.equal(await waitForReadyFile(file, 1_000, new AbortController().signal, nonce), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a native exit is reported once and a stopped window is not', () => {
  const child = new EventEmitter() as ChildProcess;
  child.exitCode = null;
  child.signalCode = null;
  let exits = 0;
  const lease = openNativeLease('native_exit', child, false);
  watchNativeExit(lease, () => { exits += 1; });
  child.emit('exit', 1, null);
  child.emit('exit', 1, null);
  assert.equal(exits, 1);
  const quietChild = new EventEmitter() as ChildProcess;
  quietChild.exitCode = null;
  quietChild.signalCode = null;
  const quiet = openNativeLease('native_quiet', quietChild, false);
  quiet.stopped = true;
  let ignored = 0;
  watchNativeExit(quiet, () => { ignored += 1; });
  quietChild.emit('exit', 0, null);
  assert.equal(ignored, 0);
});
