/**
 * An existing notebook, lease, or pointer with nlink greater than 1 is refused
 * before write. Outside bytes stay. A regular file with nlink 1 still saves.
 * This file creates hard links only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildMenuError } from '../grants.js';
import { configureKernelRecovery, recoverKernelLease, rememberRunningLease } from '../notebooks/kernelLease.js';

const PROJECT = 'app_abcdefghijkl';
const NONCE = '0123456789abcdef';
const CELL = 'cell-1';
const leaseSource = path.resolve('src/buildMenu/notebooks/kernelLease.ts');
const pinPath = path.resolve('src/buildMenu/notebooks/python/image-pin.json');

function isUnsafe(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function samePath(left: string, right: string): boolean {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function bookBytes(): Buffer {
  return Buffer.from(`${JSON.stringify({
    nbformat: 4,
    cells: [
      { id: CELL, cell_type: 'code', source: ['print(1)\n'], outputs: [] },
      { id: 'cell-2', cell_type: 'code', source: ['print(2)\n'], outputs: [] },
    ],
  }, null, 2)}\n`);
}

function leaseBytes(): Buffer {
  return Buffer.from(`${JSON.stringify({
    nonce: NONCE,
    projectId: PROJECT,
    jobId: 'job_1',
    cellId: CELL,
    phase: 'running',
  })}\n`);
}

function bookPath(workspace: string): string {
  return path.join(workspace, 'app', 'notebook.ipynb');
}

function leaseFile(workspace: string): string {
  return path.join(workspace, '.loam', 'build-menu', 'kernel-lease.json');
}

function withRoot(prefix: string, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  configureKernelRecovery(null);
  try {
    run(root);
  } finally {
    configureKernelRecovery(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeRegularFile(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function linkOutside(root: string, name: string, destination: string, bytes: Buffer): string {
  const outside = path.join(root, 'outside', name);
  writeRegularFile(outside, bytes);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.linkSync(outside, destination);
  const stat = fs.lstatSync(destination);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(fs.lstatSync(outside).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(outside).nlink > 1, true);
  return outside;
}

function assertStillLinked(destination: string, outside: string, previous: Buffer): void {
  const stat = fs.lstatSync(destination);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(fs.lstatSync(outside).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(destination), previous);
  assert.deepEqual(fs.readFileSync(outside), previous);
}

function assertPinUntouched(before: Buffer): void {
  const pin = JSON.parse(before.toString('utf8')) as { status?: unknown; digest?: unknown };
  assert.equal(pin.status, 'unresolved');
  assert.equal(pin.digest, null);
  assert.equal(fs.readFileSync(pinPath).equals(before), true);
}

function runningRecord(): { nonce: string; projectId: string; jobId: string; cellId: string } {
  return { nonce: NONCE, projectId: PROJECT, jobId: 'job_1', cellId: CELL };
}

test('a regular notebook, lease, and pointer still save', () => {
  const source = fs.readFileSync(leaseSource, 'utf8');
  assert.equal(source.includes('child_process'), false);
  assert.equal(source.includes('docker'), false);
  assert.equal(source.includes('spawn'), false);
  assert.equal(source.includes('nlink > 1'), true);
  const pinBefore = fs.readFileSync(pinPath);
  withRoot('loam-45-lease-plain-', (root) => {
    const workspace = path.join(root, 'workspace');
    const registry = path.join(root, 'registry');
    const book = bookPath(workspace);
    const lease = leaseFile(workspace);
    writeRegularFile(book, bookBytes());
    writeRegularFile(lease, leaseBytes());
    assert.equal(fs.lstatSync(book).nlink, 1);
    assert.equal(fs.lstatSync(lease).nlink, 1);
    assert.equal(recoverKernelLease(workspace), true);
    const saved = JSON.parse(fs.readFileSync(book, 'utf8')) as { cells: Array<{ outputs?: Array<{ ename?: string }> }> };
    assert.equal(saved.cells[0]?.outputs?.[0]?.ename, 'interrupted');
    assert.equal(saved.cells[1]?.outputs?.length ?? 0, 0);
    assert.equal(fs.readFileSync(lease, 'utf8').includes('"phase":"interrupted"'), true);
    assert.equal(fs.lstatSync(book).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(book).isFile(), true);
    assert.equal(fs.lstatSync(book).nlink, 1);
    assert.equal(fs.lstatSync(lease).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(lease).nlink, 1);
    configureKernelRecovery(registry);
    rememberRunningLease(workspace, runningRecord());
    const pointer = path.join(registry, `${PROJECT}.json`);
    const pointerStat = fs.lstatSync(pointer);
    assert.equal(pointerStat.isSymbolicLink(), false);
    assert.equal(pointerStat.isFile(), true);
    assert.equal(pointerStat.nlink, 1);
    assert.equal(JSON.parse(fs.readFileSync(pointer, 'utf8')).workspace, path.resolve(workspace));
    assert.equal(fs.readFileSync(lease, 'utf8').includes('"phase":"running"'), true);
    assert.equal(fs.lstatSync(lease).nlink, 1);
    rememberRunningLease(workspace, runningRecord());
    assert.equal(fs.lstatSync(pointer).nlink, 1);
    assert.equal(fs.lstatSync(lease).nlink, 1);
    assertPinUntouched(pinBefore);
  });
});

test('a hard-linked notebook is refused before write', () => {
  const pinBefore = fs.readFileSync(pinPath);
  withRoot('loam-45-lease-book-', (root) => {
    const workspace = path.join(root, 'workspace');
    const previous = bookBytes();
    const book = bookPath(workspace);
    const outside = linkOutside(root, 'notebook.ipynb', book, previous);
    writeRegularFile(leaseFile(workspace), leaseBytes());
    const leaseBefore = fs.readFileSync(leaseFile(workspace));
    assert.throws(() => recoverKernelLease(workspace), isUnsafe);
    assertStillLinked(book, outside, previous);
    assert.deepEqual(fs.readFileSync(leaseFile(workspace)), leaseBefore);
    assertPinUntouched(pinBefore);
  });
});

test('a hard-linked lease is refused before write', () => {
  const pinBefore = fs.readFileSync(pinPath);
  withRoot('loam-45-lease-file-', (root) => {
    const workspace = path.join(root, 'workspace');
    const previous = leaseBytes();
    const lease = leaseFile(workspace);
    const outside = linkOutside(root, 'kernel-lease.json', lease, previous);
    writeRegularFile(bookPath(workspace), bookBytes());
    assert.throws(() => recoverKernelLease(workspace), isUnsafe);
    assertStillLinked(lease, outside, previous);
    assert.throws(() => rememberRunningLease(workspace, runningRecord()), isUnsafe);
    assertStillLinked(lease, outside, previous);
    assertPinUntouched(pinBefore);
  });
});

test('a hard-linked pointer is refused before write', () => {
  const pinBefore = fs.readFileSync(pinPath);
  withRoot('loam-45-lease-pointer-', (root) => {
    const workspace = path.join(root, 'workspace');
    const registry = path.join(root, 'registry');
    const pointer = path.join(registry, `${PROJECT}.json`);
    const previous = Buffer.from('keep-outside-pointer\n');
    const outside = linkOutside(root, 'pointer.json', pointer, previous);
    fs.mkdirSync(workspace);
    configureKernelRecovery(registry);
    assert.throws(() => rememberRunningLease(workspace, runningRecord()), isUnsafe);
    assertStillLinked(pointer, outside, previous);
    assert.equal(fs.lstatSync(pointer).isSymbolicLink(), false);
    assertPinUntouched(pinBefore);
  });
});

test('lstat EPERM is not swallowed before write', () => {
  const pinBefore = fs.readFileSync(pinPath);
  withRoot('loam-45-lease-eperm-', (root) => {
    const workspace = path.join(root, 'workspace');
    const book = bookPath(workspace);
    const lease = leaseFile(workspace);
    const bookPrevious = bookBytes();
    const leasePrevious = leaseBytes();
    writeRegularFile(book, bookPrevious);
    writeRegularFile(lease, leasePrevious);
    refuseEperm(book, () => recoverKernelLease(workspace));
    assert.equal(fs.lstatSync(book).nlink, 1);
    assert.deepEqual(fs.readFileSync(book), bookPrevious);
    assert.deepEqual(fs.readFileSync(lease), leasePrevious);

    refuseEperm(lease, () => recoverKernelLease(workspace));
    assert.equal(fs.lstatSync(lease).nlink, 1);
    assert.deepEqual(fs.readFileSync(lease), leasePrevious);
    assert.deepEqual(fs.readFileSync(book), bookPrevious);

    refuseEperm(lease, () => rememberRunningLease(workspace, runningRecord()));
    assert.deepEqual(fs.readFileSync(lease), leasePrevious);
    assert.equal(fs.lstatSync(lease).isSymbolicLink(), false);

    const registry = path.join(root, 'registry');
    const pointer = path.join(registry, `${PROJECT}.json`);
    const pointerPrevious = Buffer.from('keep-outside-pointer\n');
    writeRegularFile(pointer, pointerPrevious);
    configureKernelRecovery(registry);
    refuseEperm(pointer, () => rememberRunningLease(workspace, runningRecord()));
    assert.equal(fs.lstatSync(pointer).nlink, 1);
    assert.equal(fs.lstatSync(pointer).isSymbolicLink(), false);
    assert.deepEqual(fs.readFileSync(pointer), pointerPrevious);
    assertPinUntouched(pinBefore);
  });
});

function refuseEperm(file: string, run: () => void): void {
  const real = fs.lstatSync;
  const resolved = path.resolve(file);
  Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: fs.StatOptions) => {
    if (samePath(path.resolve(String(target)), resolved)) {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    return options === undefined ? real(target) : real(target, options);
  }) as typeof fs.lstatSync });
  try {
    assert.throws(run, isEperm);
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: real });
  }
}
