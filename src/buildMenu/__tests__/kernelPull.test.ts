import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, spawn } from 'node:child_process';
import { BuildMenuError } from '../grants.js';
import {
  configureNotebookPin,
  kernelCommand,
  kernelStopCommand,
  resetKernelSessions,
  resetNotebookPin,
  runKernelCell,
} from '../notebooks/kernel.js';
import { configureKernelRecovery, recoverKernelLease } from '../notebooks/kernelLease.js';

const pinPath = path.resolve('src/buildMenu/notebooks/python/image-pin.json');
const kernelPath = path.resolve('src/buildMenu/notebooks/kernel.ts');
const image = `loam-notebook@sha256:${'a'.repeat(64)}`;
const nonce = '0123456789abcdef';
const projectId = 'app_abcdefghijkl';
const rejectedImages = [
  'python:latest',
  `loam-notebook@sha256:${'a'.repeat(63)}`,
  `loam-notebook@sha256:${'A'.repeat(64)}`,
  `loam-notebook@sha256:${`${'a'.repeat(63)}A`}`,
  `loam-notebook@sha256:${'a'.repeat(65)}`,
];

function missing(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'missing_requirement' && error.status === 400;
}

function notebook(root: string): string {
  const file = path.join(root, 'app', 'notebook.ipynb');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    cells: [{ id: 'cell-1', cell_type: 'code', source: ['print(1)\n'], outputs: [] }],
  }));
  return file;
}

function assertPinnedRun(args: string[]): void {
  const networkAt = args.indexOf('--network');
  const pullAt = args.indexOf('--pull');
  assert.equal(networkAt >= 0, true);
  assert.equal(args[networkAt + 1], 'none');
  assert.equal(args.filter((arg) => arg === '--network').length, 1);
  assert.equal(args.includes('--read-only'), true);
  assert.equal(pullAt >= 0, true);
  assert.equal(args[pullAt + 1], 'never');
  assert.equal(args.filter((arg) => arg === '--pull').length, 1);
  assert.equal(args.includes('pull'), false);
  assert.equal(args.includes('python:latest'), false);
  assert.equal(args[0], 'run');
  assert.equal(args[args.indexOf('-i') + 1], image);
  assert.equal(args.at(-2), '/usr/local/bin/python');
  assert.equal(args.at(-1), '/opt/loam/worker.py');
}

function exited(code: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  process.nextTick(() => child.emit('exit', code));
  return child;
}

function runningChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = Object.assign(new EventEmitter(), { setEncoding() { return undefined; } });
  child.stdout = stdout as unknown as ChildProcess['stdout'];
  child.stderr = { resume() { return undefined; } } as unknown as ChildProcess['stderr'];
  child.stdin = {
    write(data: string) {
      const payload = JSON.parse(data) as { type?: string };
      if (payload.type === 'execute') {
        stdout.emit('data', `${JSON.stringify({ type: 'complete', cellId: 'cell-1' })}\n`);
      }
      return true;
    },
    end() { return undefined; },
  } as unknown as ChildProcess['stdin'];
  child.kill = () => true;
  return child;
}

test('host python is refused and only docker or podman can run a pinned image', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-engine-'));
  try {
    const refused = ['python', 'python.exe', 'python3', 'python3.exe', 'py.exe', 'node.exe', 'cmd.exe'];
    for (const executable of refused) {
      assert.throws(() => kernelCommand({
        executable,
        image,
        workspace: root,
        projectId,
        jobId: 'job_pull',
        nonce,
      }), missing);
    }
    for (const executable of ['docker', 'docker.exe', 'podman', 'podman.exe']) {
      const command = kernelCommand({
        executable: path.join(root, executable),
        image,
        workspace: root,
        projectId,
        jobId: 'job_pull',
        nonce,
      });
      assert.equal(path.basename(command.executable).toLowerCase(), executable);
      assertPinnedRun(command.args);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unpinned images are refused and a missing image is never pulled', async () => {
  resetKernelSessions();
  resetNotebookPin();
  configureKernelRecovery(null);
  const kernelSource = fs.readFileSync(kernelPath, 'utf8');
  const pinBefore = fs.readFileSync(pinPath);
  assert.equal(/[a-f0-9]{64}/.test(kernelSource), false);
  assert.equal(/docker\s+pull/.test(kernelSource), false);
  assert.equal(kernelSource.includes('containerId'), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-pull-'));
  const dockerPath = path.join(root, 'podman.exe');
  fs.writeFileSync(dockerPath, '');
  const file = notebook(root);
  const before = fs.readFileSync(file);
  const previous = process.env.LOAM_NOTEBOOK_IMAGE;
  const seen: string[][] = [];
  const stops: string[][] = [];
  let ran = false;
  const inspectImpl = ((_executable: string, args: readonly string[]) => {
    seen.push([...args]);
    return exited(seen.length === 1 ? 1 : 0);
  }) as typeof spawn;
  const spawnImpl = ((_executable: string, args: readonly string[]) => {
    ran = true;
    seen.push([...args]);
    assertPinnedRun([...args]);
    return runningChild();
  }) as typeof spawn;
  const stopImpl = ((_executable: string, args: readonly string[]) => {
    stops.push([...args]);
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => child;
    return child;
  }) as typeof spawn;
  try {
    for (const pinned of rejectedImages) {
      assert.throws(() => kernelCommand({
        executable: dockerPath,
        image: pinned,
        workspace: root,
        projectId,
        jobId: 'job_pull',
        nonce,
      }), missing);
      assert.throws(() => configureNotebookPin(pinned), missing);
      await assert.rejects(runKernelCell({
        workspace: root,
        cellId: 'cell-1',
        projectId,
        jobId: 'job_bad',
        image: pinned,
        dockerPath,
        nonce,
        inspectImpl,
        spawnImpl,
        stopImpl,
      }), missing);
    }
    assert.equal(ran, false);
    assert.equal(seen.length, 0);
    assert.equal(fs.existsSync(path.join(root, 'app', 'data')), false);
    assert.equal(fs.readFileSync(file).equals(before), true);
    process.env.LOAM_NOTEBOOK_IMAGE = 'python:latest';
    await assert.rejects(runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId,
      jobId: 'job_env_latest',
      dockerPath,
      nonce,
      inspectImpl,
      spawnImpl,
      stopImpl,
    }), missing);
    process.env.LOAM_NOTEBOOK_IMAGE = image;
    await assert.rejects(runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId,
      jobId: 'job_env_digest',
      dockerPath,
      nonce,
      inspectImpl,
      spawnImpl,
      stopImpl,
    }), missing);
    assert.equal(ran, false);
    assert.equal(seen.length, 0);
    await assert.rejects(runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId,
      jobId: 'job_missing',
      image,
      dockerPath,
      nonce,
      inspectImpl,
      spawnImpl,
      stopImpl,
    }), missing);
    assert.equal(ran, false);
    assert.deepEqual(seen, [['image', 'inspect', '--format', '{{.Id}}', image]]);
    assert.equal(seen.some((args) => args.includes('pull') || args[0] === 'pull'), false);
    const result = await runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId,
      jobId: 'job_present',
      image,
      dockerPath,
      nonce,
      inspectImpl,
      spawnImpl,
      stopImpl,
    });
    assert.equal(result.text, '');
    assert.equal(ran, true);
    assert.equal(seen.some((args) => args.includes('pull') || args[0] === 'pull'), false);
    const runArgs = seen.find((args) => args[0] === 'run');
    assertPinnedRun(runArgs ?? []);
    resetKernelSessions();
    assert.deepEqual(stops, [['stop', `loamk${nonce}`]]);
    assert.equal(stops.some((args) => args.includes('pull')), false);
    const pin = JSON.parse(pinBefore.toString('utf8')) as { status?: unknown; digest?: unknown };
    assert.equal(pin.status, 'unresolved');
    assert.equal(pin.digest, null);
    assert.equal(/[a-f0-9]{64}/i.test(pinBefore.toString('utf8')), false);
    assert.equal(fs.readFileSync(pinPath).equals(pinBefore), true);
  } finally {
    resetNotebookPin();
    resetKernelSessions();
    configureKernelRecovery(null);
    if (previous === undefined) delete process.env.LOAM_NOTEBOOK_IMAGE;
    else process.env.LOAM_NOTEBOOK_IMAGE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery does not stop a container saved from an earlier id', () => {
  resetKernelSessions();
  resetNotebookPin();
  configureKernelRecovery(null);
  const kernelSource = fs.readFileSync(kernelPath, 'utf8');
  const recoverySource = fs.readFileSync(path.resolve('src/buildMenu/notebooks/kernelLease.ts'), 'utf8');
  const pinBefore = fs.readFileSync(pinPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-saved-'));
  const savedId = 'other-person-container';
  try {
    notebook(root);
    const lease = path.join(root, '.loam', 'build-menu', 'kernel-lease.json');
    fs.mkdirSync(path.dirname(lease), { recursive: true });
    fs.writeFileSync(lease, `${JSON.stringify({
      nonce,
      projectId,
      jobId: 'job_pull',
      cellId: 'cell-1',
      phase: 'running',
      containerId: savedId,
    })}\n`);
    const book = fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'));
    const stop = kernelStopCommand(path.join(root, 'podman.exe'), nonce);
    assert.deepEqual(stop.args, ['stop', `loamk${nonce}`]);
    assert.equal(stop.args.includes(savedId), false);
    assert.equal(stop.args.includes('pull'), false);
    assert.throws(() => kernelStopCommand(path.join(root, 'python.exe'), nonce), missing);
    assert.equal(kernelSource.includes('containerId'), false);
    assert.equal(/docker\s+pull/.test(kernelSource), false);
    assert.equal(recoverySource.includes('child_process'), false);
    assert.equal(recoverySource.includes('spawn'), false);
    assert.equal(recoverySource.includes('docker'), false);
    assert.equal(recoverKernelLease(root), true);
    const recorded = fs.readFileSync(lease, 'utf8');
    assert.equal(recorded.includes(savedId), false);
    assert.equal(recorded.includes('containerId'), false);
    assert.equal(recorded.includes('"phase":"interrupted"'), true);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'), 'utf8')) as {
      cells: Array<{ source?: string[]; outputs?: Array<{ ename?: string }> }>;
    };
    assert.equal(saved.cells[0]?.outputs?.[0]?.ename, 'interrupted');
    assert.deepEqual(saved.cells[0]?.source, ['print(1)\n']);
    assert.equal(book.equals(fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'))), false);
    const pin = JSON.parse(pinBefore.toString('utf8')) as { status?: unknown; digest?: unknown };
    assert.equal(pin.status, 'unresolved');
    assert.equal(pin.digest, null);
    assert.equal(fs.readFileSync(pinPath).equals(pinBefore), true);
  } finally {
    configureKernelRecovery(null);
    resetNotebookPin();
    resetKernelSessions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
