import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, spawn } from 'node:child_process';
import { BuildMenuError } from '../grants.js';
import { resetKernelSessions, runKernelCell } from '../notebooks/kernel.js';
import { configureKernelRecovery, recoverKernelLease } from '../notebooks/kernelLease.js';

const image = `loam-notebook@sha256:${'c'.repeat(64)}`;

test('a finished cell keeps the kernel lease idle and recovery does not rewrite outputs', async () => {
  resetKernelSessions();
  configureKernelRecovery(null);
  const pin = JSON.parse(fs.readFileSync(path.resolve('src/buildMenu/notebooks/python/image-pin.json'), 'utf8')) as { status?: unknown; digest?: unknown };
  assert.equal(pin.status, 'unresolved');
  assert.equal(pin.digest, null);
  const recovery = fs.readFileSync(path.resolve('src/buildMenu/notebooks/kernelLease.ts'), 'utf8');
  assert.equal(recovery.includes('child_process'), false);
  assert.equal(recovery.includes('docker'), false);
  assert.equal(recovery.includes('spawn'), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notebook-lease-'));
  const dockerPath = path.join(root, 'docker.exe');
  fs.writeFileSync(dockerPath, '');
  writeBook(root);
  const lease = path.join(root, '.loam', 'build-menu', 'kernel-lease.json');
  const stops: string[][] = [];
  let spawned = 0;
  try {
    const result = await runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_done',
      image,
      dockerPath,
      nonce: '0123456789abcdef',
      spawnImpl: fakeRun(lease, 'job_done', () => { spawned += 1; }),
      stopImpl: stopCollector(stops),
    });
    assert.equal(result.text, '2\n');
    assert.equal(spawned, 1);
    assert.deepEqual(stops, []);
    const running = JSON.parse(fs.readFileSync(lease, 'utf8')) as { phase?: string; activeCellJobId?: string | null; cellId?: string; containerId?: string };
    assert.equal(running.phase, 'running');
    assert.equal(running.activeCellJobId, null);
    assert.equal(running.cellId, 'cell-1');
    assert.equal(running.containerId, undefined);
    const saved = fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'));
    const book = JSON.parse(saved.toString('utf8')) as { cells: Array<{ source?: string[]; outputs?: Array<{ text?: string[] }> }> };
    assert.deepEqual(book.cells[0]?.outputs?.[0]?.text, ['2\n']);
    assert.deepEqual(book.cells[1]?.source, ['print(2)\n']);
    assert.equal(recoverKernelLease(root), true);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'notebook.ipynb')).equals(saved), true);
    const interrupted = JSON.parse(fs.readFileSync(lease, 'utf8')) as { phase?: string; containerId?: string };
    assert.equal(interrupted.phase, 'interrupted');
    assert.equal(interrupted.containerId, undefined);
    assert.equal(JSON.stringify(interrupted).includes('container'), false);
    assert.deepEqual(stops, []);
    assert.equal(recoverKernelLease(root), false);
  } finally {
    resetKernelSessions();
    configureKernelRecovery(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cancelling a cell stops only that kernel and removes its lease', async () => {
  resetKernelSessions();
  configureKernelRecovery(null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notebook-cancel-'));
  const dockerPath = path.join(root, 'docker.exe');
  fs.writeFileSync(dockerPath, '');
  writeBook(root);
  const notebook = path.join(root, 'app', 'notebook.ipynb');
  const lease = path.join(root, '.loam', 'build-menu', 'kernel-lease.json');
  const stops: string[][] = [];
  const controller = new AbortController();
  try {
    const pending = runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_cancel',
      image,
      dockerPath,
      nonce: 'fedcba9876543210',
      timeoutMs: 5_000,
      signal: controller.signal,
      spawnImpl: fakeRun(lease, 'job_cancel', () => undefined, controller),
      stopImpl: stopCollector(stops),
    });
    await assert.rejects(pending, (error: unknown) => error instanceof BuildMenuError && error.message === 'cancelled' && error.status === 409);
    assert.deepEqual(stops, [['stop', 'loamkfedcba9876543210']]);
    assert.equal(stops.some((command) => command.includes('prune')), false);
    assert.equal(fs.existsSync(lease), false);
    const saved = JSON.parse(fs.readFileSync(notebook, 'utf8')) as {
      cells: Array<{ source?: string[]; outputs?: Array<{ ename?: string; text?: string[] }> }>;
    };
    assert.equal(saved.cells[0]?.outputs?.[0]?.ename, 'interrupted');
    assert.deepEqual(saved.cells[0]?.source, ['print(1)\n']);
    assert.deepEqual(saved.cells[1]?.source, ['print(2)\n']);
    assert.deepEqual(saved.cells[1]?.outputs, []);
  } finally {
    resetKernelSessions();
    configureKernelRecovery(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an in-flight kernel lease is marked interrupted without a container id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notebook-inflight-'));
  writeBook(root);
  const lease = path.join(root, '.loam', 'build-menu', 'kernel-lease.json');
  fs.mkdirSync(path.dirname(lease), { recursive: true });
  fs.writeFileSync(lease, `${JSON.stringify({
    nonce: '0123456789abcdef',
    projectId: 'app_abcdefghijkl',
    jobId: 'job_live',
    cellId: 'cell-1',
    phase: 'running',
    containerId: 'other-person-container',
  })}\n`);
  const other = fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'));
  try {
    assert.equal(recoverKernelLease(root), true);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'), 'utf8')) as {
      cells: Array<{ source?: string[]; outputs?: Array<{ ename?: string }> }>;
    };
    assert.equal(saved.cells[0]?.outputs?.[0]?.ename, 'interrupted');
    assert.deepEqual(saved.cells[0]?.source, ['print(1)\n']);
    assert.deepEqual(saved.cells[1]?.source, ['print(2)\n']);
    assert.deepEqual(saved.cells[1]?.outputs, []);
    const recorded = fs.readFileSync(lease, 'utf8');
    assert.equal(recorded.includes('other-person-container'), false);
    assert.equal(recorded.includes('"phase":"interrupted"'), true);
    assert.equal(recorded.includes('containerId'), false);
    assert.equal(other.equals(fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'))), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeBook(root: string): void {
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'notebook.ipynb'), `${JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    cells: [
      { id: 'cell-1', cell_type: 'code', source: ['print(1)\n'], outputs: [] },
      { id: 'cell-2', cell_type: 'code', source: ['print(2)\n'], outputs: [] },
    ],
  })}\n`);
}

function fakeRun(lease: string, jobId: string, onSpawn: () => void, controller?: AbortController): typeof spawn {
  return ((_executable: string, args: readonly string[]) => {
    onSpawn();
    assert.equal(args[0], 'run');
    assert.equal(args.includes('pull'), false);
    assert.equal(args.includes('print(1)\n'), false);
    const child = new EventEmitter() as ChildProcess;
    const stdout = Object.assign(new EventEmitter(), { setEncoding() { return undefined; } });
    child.stdout = stdout as unknown as ChildProcess['stdout'];
    child.stderr = { resume() { return undefined; } } as unknown as ChildProcess['stderr'];
    child.stdin = {
      write(data: string) {
        const payload = JSON.parse(String(data)) as { type?: string };
        if (payload.type !== 'execute') return true;
        const live = JSON.parse(fs.readFileSync(lease, 'utf8')) as { activeCellJobId?: string; phase?: string };
        assert.equal(live.phase, 'running');
        assert.equal(live.activeCellJobId, jobId);
        if (controller) {
          controller.abort();
          return true;
        }
        stdout.emit('data', `${JSON.stringify({ type: 'output', cellId: 'cell-1', messageType: 'stream', content: { text: '2\n' } })}\n`);
        stdout.emit('data', `${JSON.stringify({ type: 'complete', cellId: 'cell-1' })}\n`);
        return true;
      },
      end() { return undefined; },
    } as unknown as ChildProcess['stdin'];
    child.kill = () => true;
    return child;
  }) as typeof spawn;
}

function stopCollector(stops: string[][]): typeof spawn {
  return ((...args: Parameters<typeof spawn>) => {
    stops.push([...(args[1] ?? [])]);
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => child;
    return child;
  }) as typeof spawn;
}
