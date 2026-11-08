/**
 * Notebook writes refuse an existing file whose nlink is greater than 1
 * before either write. Outside bytes stay. A regular nlink 1 notebook still saves.
 * This file creates hard links only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, spawn } from 'node:child_process';
import { BuildMenuError } from '../grants.js';
import { configureKernelRecovery } from '../notebooks/kernelLease.js';
import { resetKernelSessions, resetNotebookPin, runKernelCell } from '../notebooks/kernel.js';
import { KERNEL_TIMEOUT_MS } from '../notebooks/messages.js';

const PROJECT = 'app_abcdefghijkl';
const NONCE = '0123456789abcdef';
const CELL = 'cell-1';
const IMAGE = `loam-notebook@sha256:${'a'.repeat(64)}`;
const kernelSource = path.resolve('src/buildMenu/notebooks/kernel.ts');
const messagesSource = path.resolve('src/buildMenu/notebooks/messages.ts');
const pinPath = path.resolve('src/buildMenu/notebooks/python/image-pin.json');
const workerPath = path.resolve('src/buildMenu/notebooks/python/worker.py');

function isUnsafe(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function isToolFailed(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'tool_failed' && error.status === 500;
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

function bookPath(workspace: string): string {
  return path.join(workspace, 'app', 'notebook.ipynb');
}

interface SavedNotebook {
  cells: Array<{
    id?: string;
    source?: string[];
    outputs?: Array<{ ename?: string; text?: string[] }>;
    execution_count?: number | null;
  }>;
}

async function withRoot(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  configureKernelRecovery(null);
  resetNotebookPin();
  resetKernelSessions();
  try {
    await run(root);
  } finally {
    resetKernelSessions();
    resetNotebookPin();
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

function dockerPath(root: string): string {
  const file = path.join(root, 'docker.exe');
  fs.writeFileSync(file, '');
  return file;
}

function fakeSpawn(mode: 'save' | 'interrupt', seen: string[][]): typeof spawn {
  return ((_executable: string, args: readonly string[]) => {
    seen.push([...args]);
    const child = new EventEmitter() as ChildProcess;
    const stdout = Object.assign(new EventEmitter(), { setEncoding() { return undefined; } });
    child.stdout = stdout as unknown as ChildProcess['stdout'];
    child.stderr = { resume() { return undefined; } } as unknown as ChildProcess['stderr'];
    child.stdin = {
      write() {
        if (mode === 'save') {
          const output = JSON.stringify({ type: 'output', cellId: CELL, messageType: 'stream', content: { text: '2\n' } });
          const complete = JSON.stringify({ type: 'complete', cellId: CELL });
          stdout.emit('data', `${output}\n${complete}\n`);
          process.nextTick(() => child.emit('exit', 0));
        } else {
          process.nextTick(() => child.emit('exit', 1));
        }
        return true;
      },
      end() { return undefined; },
    } as unknown as ChildProcess['stdin'];
    child.kill = () => true;
    child.unref = () => child;
    return child;
  }) as typeof spawn;
}

function stopSpawn(): typeof spawn {
  return (() => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => child;
    return child;
  }) as typeof spawn;
}

function cellInput(workspace: string, executable: string, spawnImpl: typeof spawn): {
  workspace: string;
  cellId: string;
  projectId: string;
  jobId: string;
  image: string;
  dockerPath: string;
  nonce: string;
  spawnImpl: typeof spawn;
  stopImpl: typeof spawn;
} {
  return {
    workspace,
    cellId: CELL,
    projectId: PROJECT,
    jobId: 'job_1',
    image: IMAGE,
    dockerPath: executable,
    nonce: NONCE,
    spawnImpl,
    stopImpl: stopSpawn(),
  };
}

function assertNoPull(args: string[]): void {
  assert.equal(args[args.indexOf('--pull') + 1], 'never');
  assert.equal(args.filter((arg) => arg === 'pull').length, 0);
  assert.equal(args.includes('docker pull'), false);
  assert.equal(args.some((arg) => arg.includes(workerPath)), false);
  assert.equal(args.at(-1), '/opt/loam/worker.py');
}

test('a regular nlink 1 notebook still saves', async () => {
  const source = fs.readFileSync(kernelSource, 'utf8');
  const messages = fs.readFileSync(messagesSource, 'utf8');
  assert.equal(KERNEL_TIMEOUT_MS, 30_000);
  assert.equal(messages.includes('KERNEL_TIMEOUT_MS = 30_000'), true);
  assert.equal(source.includes('KERNEL_TIMEOUT_MS'), true);
  assert.equal(source.includes('nlink > 1'), true);
  assert.equal(source.split('nlink > 1').length - 1, 1);
  assert.equal(source.split('fs.writeFileSync(notebookPath(workspace)').length - 1, 2);
  assert.equal(source.includes('EPERM'), false);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  const pinBefore = fs.readFileSync(pinPath);
  await withRoot('loam-46-kernel-plain-', async (root) => {
    const workspace = path.join(root, 'workspace');
    const book = bookPath(workspace);
    writeRegularFile(book, bookBytes());
    assert.equal(fs.lstatSync(book).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(book).isFile(), true);
    assert.equal(fs.lstatSync(book).nlink, 1);
    const executable = dockerPath(root);
    const savedArgs: string[][] = [];
    const saved = await runKernelCell(cellInput(workspace, executable, fakeSpawn('save', savedArgs)));
    assert.equal(saved.text, '2\n');
    assert.equal(savedArgs.length, 1);
    assertNoPull(savedArgs[0] ?? []);
    const afterSave = JSON.parse(fs.readFileSync(book, 'utf8')) as SavedNotebook;
    assert.deepEqual(afterSave.cells[0]?.outputs?.[0]?.text, ['2\n']);
    assert.equal(afterSave.cells[0]?.execution_count, 1);
    assert.deepEqual(afterSave.cells[1]?.source, ['print(2)\n']);
    assert.equal(afterSave.cells[1]?.outputs?.length ?? 0, 0);
    const savedStat = fs.lstatSync(book);
    assert.equal(savedStat.isSymbolicLink(), false);
    assert.equal(savedStat.isFile(), true);
    assert.equal(savedStat.nlink, 1);
    resetKernelSessions();

    const interruptedArgs: string[][] = [];
    await assert.rejects(
      runKernelCell({ ...cellInput(workspace, executable, fakeSpawn('interrupt', interruptedArgs)), jobId: 'job_2' }),
      isToolFailed,
    );
    assert.equal(interruptedArgs.length, 1);
    assertNoPull(interruptedArgs[0] ?? []);
    const afterInterrupt = JSON.parse(fs.readFileSync(book, 'utf8')) as SavedNotebook;
    assert.equal(afterInterrupt.cells[0]?.outputs?.[0]?.ename, 'interrupted');
    assert.deepEqual(afterInterrupt.cells[0]?.source, ['print(1)\n']);
    assert.deepEqual(afterInterrupt.cells[1]?.source, ['print(2)\n']);
    assert.equal(afterInterrupt.cells[1]?.outputs?.length ?? 0, 0);
    const interruptedStat = fs.lstatSync(book);
    assert.equal(interruptedStat.isSymbolicLink(), false);
    assert.equal(interruptedStat.isFile(), true);
    assert.equal(interruptedStat.nlink, 1);
    assertPinUntouched(pinBefore);
  });
});

test('a hard-linked notebook is refused before write', async () => {
  const pinBefore = fs.readFileSync(pinPath);
  await withRoot('loam-46-kernel-book-', async (root) => {
    const workspace = path.join(root, 'workspace');
    const previous = bookBytes();
    const book = bookPath(workspace);
    const outside = linkOutside(root, 'notebook.ipynb', book, previous);
    const executable = dockerPath(root);
    const seen: string[][] = [];
    const spawnImpl = fakeSpawn('save', seen);
    await assert.rejects(runKernelCell(cellInput(workspace, executable, spawnImpl)), isUnsafe);
    assert.equal(seen.length, 0);
    assertStillLinked(book, outside, previous);
    await assert.rejects(
      runKernelCell({ ...cellInput(workspace, executable, fakeSpawn('interrupt', seen)), jobId: 'job_2' }),
      isUnsafe,
    );
    assert.equal(seen.length, 0);
    assertStillLinked(book, outside, previous);
    assertPinUntouched(pinBefore);
  });
});

test('lstat EPERM is not swallowed before write', async () => {
  const pinBefore = fs.readFileSync(pinPath);
  await withRoot('loam-46-kernel-eperm-', async (root) => {
    const workspace = path.join(root, 'workspace');
    const book = bookPath(workspace);
    const previous = bookBytes();
    writeRegularFile(book, previous);
    const executable = dockerPath(root);
    const seen: string[][] = [];
    await refuseEperm(book, () => runKernelCell(cellInput(workspace, executable, fakeSpawn('save', seen))));
    assert.equal(seen.length, 0);
    assert.equal(fs.lstatSync(book).nlink, 1);
    assert.equal(fs.lstatSync(book).isSymbolicLink(), false);
    assert.deepEqual(fs.readFileSync(book), previous);
    await refuseEperm(book, () => runKernelCell({
      ...cellInput(workspace, executable, fakeSpawn('interrupt', seen)),
      jobId: 'job_2',
    }));
    assert.equal(seen.length, 0);
    assert.equal(fs.lstatSync(book).nlink, 1);
    assert.deepEqual(fs.readFileSync(book), previous);
    assertPinUntouched(pinBefore);
  });
});

async function refuseEperm(file: string, run: () => Promise<unknown>): Promise<void> {
  const real = fs.lstatSync;
  const resolved = path.resolve(file);
  fs.lstatSync = ((target: fs.PathLike, options?: fs.StatOptions) => {
    if (samePath(path.resolve(String(target)), resolved)) {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    return options === undefined ? real(target) : real(target, options);
  }) as typeof fs.lstatSync;
  try {
    await assert.rejects(run, isEperm);
  } finally {
    fs.lstatSync = real;
  }
}
