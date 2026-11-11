import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, spawn } from 'node:child_process';
import { BuildMenuError } from '../grants.js';
import { resetKernelSessions, runKernelCell } from '../notebooks/kernel.js';
import { MAX_KERNEL_LINE } from '../notebooks/messages.js';

const image = `loam-notebook@sha256:${'b'.repeat(64)}`;

test('an unfinished kernel line is refused before it is parsed', { timeout: 5_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-line-'));
  const dockerPath = path.join(root, 'docker.exe');
  fs.writeFileSync(dockerPath, '');
  const source = 'print(1)\n';
  writeNotebook(root, source);
  let killed = 0;
  const stops: string[][] = [];
  const stdout = Object.assign(new EventEmitter(), { setEncoding() { return undefined; } });
  const child = childWith(stdout, () => { killed += 1; });
  child.stdin = {
    write() {
      stdout.emit('data', 'x'.repeat(MAX_KERNEL_LINE));
      stdout.emit('data', 'y');
      return true;
    },
    end() { return undefined; },
  } as unknown as ChildProcess['stdin'];
  try {
    await assert.rejects(runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_line',
      image,
      dockerPath,
      nonce: '0123456789abcdef',
      spawnImpl: (() => child) as typeof spawn,
      stopImpl: stopCollector(stops),
    }), (error: unknown) => error instanceof BuildMenuError && error.message === 'tool_failed');
    assert.equal(killed, 1);
    assert.deepEqual(stops, [['stop', 'loamk0123456789abcdef']]);
    const saved = readNotebook(root);
    assert.equal(saved.cells[0]?.outputs?.[0]?.ename, 'interrupted');
    assert.equal(JSON.stringify(saved).includes('x'.repeat(80)), false);
    assert.deepEqual(saved.cells[0]?.source, [source]);
  } finally {
    resetKernelSessions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('kernel stderr is capped before it can grow without a newline', { timeout: 5_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-err-'));
  const dockerPath = path.join(root, 'docker.exe');
  fs.writeFileSync(dockerPath, '');
  writeNotebook(root, 'print(1)\n');
  const stdout = Object.assign(new EventEmitter(), { setEncoding() { return undefined; } });
  const stderr = Object.assign(new EventEmitter(), { resume() { return undefined; } });
  const child = childWith(stdout, () => undefined);
  child.stderr = stderr as unknown as ChildProcess['stderr'];
  const marker = 'SECRET-STDERR';
  const piece = marker.padEnd(100, 'z');
  child.stdin = {
    write() {
      for (let index = 0; index < 90; index += 1) stderr.emit('data', piece);
      return true;
    },
    end() { return undefined; },
  } as unknown as ChildProcess['stdin'];
  try {
    await assert.rejects(runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_err',
      image,
      dockerPath,
      nonce: 'fedcba9876543210',
      spawnImpl: (() => child) as typeof spawn,
      stopImpl: (() => new EventEmitter() as ChildProcess) as typeof spawn,
    }), (error: unknown) => error instanceof BuildMenuError && error.message === 'tool_failed');
    const saved = JSON.stringify(readNotebook(root));
    assert.equal(saved.includes(marker), false);
    assert.equal(saved.includes('interrupted'), true);
  } finally {
    resetKernelSessions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function childWith(stdout: EventEmitter, kill: () => void): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = stdout as unknown as ChildProcess['stdout'];
  child.stderr = Object.assign(new EventEmitter(), { resume() { return undefined; } }) as unknown as ChildProcess['stderr'];
  child.stdin = { write() { return true; }, end() { return undefined; } } as unknown as ChildProcess['stdin'];
  child.kill = () => {
    kill();
    return true;
  };
  return child;
}

function stopCollector(stops: string[][]): typeof spawn {
  return ((...args: Parameters<typeof spawn>) => {
    stops.push([...(args[1] ?? [])]);
    return new EventEmitter() as ChildProcess;
  }) as typeof spawn;
}

function writeNotebook(root: string, source: string): void {
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'notebook.ipynb'), JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    cells: [{ id: 'cell-1', cell_type: 'code', source: [source], outputs: [] }],
  }));
}

function readNotebook(root: string): { cells: { source?: string[]; outputs?: { ename?: string }[] }[] } {
  return JSON.parse(fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'), 'utf8')) as {
    cells: { source?: string[]; outputs?: { ename?: string }[] }[];
  };
}
