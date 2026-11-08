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
  resetKernelSessions,
  resetNotebookPin,
  runKernelCell,
} from '../notebooks/kernel.js';

const pinPath = path.resolve('src/buildMenu/notebooks/python/image-pin.json');
const kernelPath = path.resolve('src/buildMenu/notebooks/kernel.ts');
const image = `loam-notebook@sha256:${'a'.repeat(64)}`;
const nonce = '0123456789abcdef';
const projectId = 'app_abcdefghijkl';
const encodedPulls = [
  'docker%20pull',
  'docker%2520pull',
  'DOCKER%20PULL',
  `docker%20pull@sha256:${'a'.repeat(64)}`,
  `docker%2520pull@sha256:${'b'.repeat(64)}`,
];
const encodedLatest = [
  'python:%6Catest',
  'python:%256Catest',
  'python:%6c%61%74%65%73%74',
  `loam-notebook:%6Catest@sha256:${'c'.repeat(64)}`,
  `loam-notebook:%256Catest@sha256:${'d'.repeat(64)}`,
  `loam-notebook:lat%65st@sha256:${'e'.repeat(64)}`,
];
const quoteSplitPulls = [
  '"docker"+" pull"',
  '"docker" + " pull"',
  "'docker'+' pull'",
  '"pul"+"l"',
  "'pul'+'l'",
  `"pul"+"l@sha256:${'f'.repeat(64)}"`,
  `"docker"+"%20pull"`,
  `"docker"+" pull"@sha256:${'a'.repeat(64)}`,
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

function exited(code: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  process.nextTick(() => child.emit('exit', code));
  return child;
}

function assertPinUntouched(before: Buffer): void {
  const pin = JSON.parse(before.toString('utf8')) as { status?: unknown; digest?: unknown };
  assert.equal(pin.status, 'unresolved');
  assert.equal(pin.digest, null);
  assert.equal(fs.readFileSync(pinPath).equals(before), true);
  const kernelSource = fs.readFileSync(kernelPath, 'utf8');
  assert.equal(/docker\s+pull/.test(kernelSource), false);
  assert.equal(/[a-f0-9]{64}/.test(kernelSource), false);
}

async function refuses(images: string[], extras?: { envImage?: string; executables?: string[] }): Promise<void> {
  resetKernelSessions();
  resetNotebookPin();
  const pinBefore = fs.readFileSync(pinPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-encoded-'));
  const dockerPath = path.join(root, 'podman.exe');
  fs.writeFileSync(dockerPath, '');
  const file = notebook(root);
  const before = fs.readFileSync(file);
  const seen: string[][] = [];
  const stops: string[][] = [];
  let ran = false;
  const inspectImpl = ((_executable: string, args: readonly string[]) => {
    seen.push([...args]);
    return exited(1);
  }) as typeof spawn;
  const spawnImpl = (() => {
    ran = true;
    return exited(0);
  }) as typeof spawn;
  const stopImpl = ((_executable: string, args: readonly string[]) => {
    stops.push([...args]);
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => child;
    return child;
  }) as typeof spawn;
  const previous = process.env.LOAM_NOTEBOOK_IMAGE;
  try {
    for (const executable of extras?.executables ?? []) {
      assert.throws(() => kernelCommand({
        executable,
        image,
        workspace: root,
        projectId,
        jobId: 'job_encoded',
        nonce,
      }), missing);
    }
    for (const pinned of images) {
      assert.throws(() => kernelCommand({
        executable: dockerPath,
        image: pinned,
        workspace: root,
        projectId,
        jobId: 'job_encoded',
        nonce,
      }), missing);
      assert.throws(() => configureNotebookPin(pinned), missing);
      await assert.rejects(runKernelCell({
        workspace: root,
        cellId: 'cell-1',
        projectId,
        jobId: 'job_encoded',
        image: pinned,
        dockerPath,
        nonce,
        inspectImpl,
        spawnImpl,
        stopImpl,
      }), missing);
    }
    if (extras?.envImage) {
      process.env.LOAM_NOTEBOOK_IMAGE = extras.envImage;
      await assert.rejects(runKernelCell({
        workspace: root,
        cellId: 'cell-1',
        projectId,
        jobId: 'job_env',
        dockerPath,
        nonce,
        inspectImpl,
        spawnImpl,
        stopImpl,
      }), missing);
    }
    assert.equal(ran, false);
    assert.equal(seen.length, 0);
    assert.equal(stops.length, 0);
    assert.equal(fs.existsSync(path.join(root, 'app', 'data')), false);
    assert.equal(fs.readFileSync(file).equals(before), true);
    assertPinUntouched(pinBefore);
  } finally {
    resetNotebookPin();
    resetKernelSessions();
    if (previous === undefined) delete process.env.LOAM_NOTEBOOK_IMAGE;
    else process.env.LOAM_NOTEBOOK_IMAGE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a percent-encoded docker pull is refused', async () => {
  await refuses(encodedPulls, { executables: ['docker%20pull', 'docker%2520pull', 'docker%20pull.exe'] });
});

test('a percent-encoded latest tag is refused', async () => {
  await refuses(encodedLatest, { envImage: 'python:%256Catest' });
});

test('a quote-split pull is refused', async () => {
  await refuses(quoteSplitPulls, { executables: ['"docker"+" pull"', '"pul"+"l"', "'pul'+'l'"] });
});

test('a missing image returns missing_requirement and spawns nothing', async () => {
  resetKernelSessions();
  resetNotebookPin();
  const pinBefore = fs.readFileSync(pinPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-encoded-missing-'));
  const dockerPath = path.join(root, 'podman.exe');
  fs.writeFileSync(dockerPath, '');
  const file = notebook(root);
  const before = fs.readFileSync(file);
  const seen: string[][] = [];
  const stops: string[][] = [];
  let ran = false;
  const inspectImpl = ((_executable: string, args: readonly string[]) => {
    seen.push([...args]);
    return exited(1);
  }) as typeof spawn;
  const spawnImpl = ((_executable: string, args: readonly string[]) => {
    ran = true;
    seen.push([...args]);
    return exited(0);
  }) as typeof spawn;
  const stopImpl = ((_executable: string, args: readonly string[]) => {
    stops.push([...args]);
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => child;
    return child;
  }) as typeof spawn;
  try {
    configureNotebookPin(null);
    assertPinUntouched(pinBefore);
    assert.throws(() => kernelCommand({
      executable: 'python.exe',
      image,
      workspace: root,
      projectId,
      jobId: 'job_encoded',
      nonce,
    }), missing);
    const command = kernelCommand({
      executable: dockerPath,
      image,
      workspace: root,
      projectId,
      jobId: 'job_encoded',
      nonce,
    });
    assert.equal(command.args[0], 'run');
    assert.equal(command.args.includes('pull'), false);
    assert.equal(command.args[command.args.indexOf('--pull') + 1], 'never');
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
    assert.equal(stops.length, 0);
    assert.equal(fs.readFileSync(file).equals(before), true);
    assertPinUntouched(pinBefore);
  } finally {
    resetNotebookPin();
    resetKernelSessions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
