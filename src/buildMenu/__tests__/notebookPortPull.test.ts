import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { resetKernelSessions, resetNotebookPin } from '../notebooks/kernel.js';
import { createNotebooksPorts } from '../notebooks/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';

const pinPath = fileURLToPath(new URL('../notebooks/python/image-pin.json', import.meta.url));
const unapprovedImage = `loam-notebook@sha256:${'a'.repeat(64)}`;

type SpawnOptions = { file?: string; args?: readonly string[] };
type SpawnMethod = (this: ChildProcess, options: SpawnOptions) => unknown;

function refused(code: string) {
  return (error: unknown) => error instanceof BuildMenuError && error.message === code && error.status === 400;
}

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'notebook' };
  return {
    workspace,
    jobId: 'job_notebook_port_pull',
    operation: { action: 'kernel-execute', cellId: 'cell-1' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'دفتر',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

function notebook(root: string, source: string): string {
  const file = path.join(root, 'app', 'notebook.ipynb');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    cells: [{ id: 'cell-1', cell_type: 'code', source: [source], outputs: [] }],
  })}\n`);
  return file;
}

function blockSpawns(): { calls: string[][]; restore: () => void } {
  const calls: string[][] = [];
  const proto = ChildProcess.prototype as unknown as { spawn: SpawnMethod };
  const original = proto.spawn;
  proto.spawn = function (this: ChildProcess, options: SpawnOptions): unknown {
    calls.push([options?.file ?? '', ...(options?.args ?? [])]);
    this.stdout = new EventEmitter() as ChildProcess['stdout'];
    this.stderr = Object.assign(new EventEmitter(), { resume() { return undefined; } }) as unknown as ChildProcess['stderr'];
    this.stdin = { write() { return true; }, end() { return this; } } as unknown as ChildProcess['stdin'];
    process.nextTick(() => this.emit('exit', 1, null));
    return undefined;
  };
  return {
    calls,
    restore() {
      proto.spawn = original;
    },
  };
}

test('executeCell does not pull, accept latest, or start a container while the image pin is unresolved', async () => {
  const portSource = fs.readFileSync(new URL('../notebooks/ports.ts', import.meta.url), 'utf8');
  assert.equal(/docker\s+pull/i.test(portSource), false);
  assert.equal(portSource.toLowerCase().includes('latest'), false);
  assert.equal(portSource.includes('spawn'), false);

  const pinBefore = fs.readFileSync(pinPath);
  const pin = JSON.parse(pinBefore.toString('utf8')) as { status?: unknown; digest?: unknown };
  assert.equal(pin.status, 'unresolved');
  assert.equal(pin.digest, null);
  assert.equal(pinBefore.toString('utf8').toLowerCase().includes('latest'), false);
  assert.equal(/[a-f0-9]{64}/i.test(pinBefore.toString('utf8')), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notebook-port-pull-'));
  const leases = new ProcessLeaseRegistry(200);
  const ports = createNotebooksPorts({ leases });
  const ctx = context(root);
  const watch = blockSpawns();
  const previous = process.env.LOAM_NOTEBOOK_IMAGE;
  const images = [
    undefined,
    'python:latest',
    'LATEST',
    'python:LATEST',
    'docker pull python:latest',
    'docker%20pull',
    'python:%6Catest',
    'python:3.12',
    unapprovedImage,
  ];
  try {
    resetNotebookPin();
    resetKernelSessions();
    for (const source of ['print(1)\n', 'docker pull python:latest\n']) {
      const file = notebook(root, source);
      const before = fs.readFileSync(file);
      for (const image of images) {
        if (image === undefined) delete process.env.LOAM_NOTEBOOK_IMAGE;
        else process.env.LOAM_NOTEBOOK_IMAGE = image;
        await assert.rejects(ports.executeCell(ctx, 'cell-1'), refused('missing_requirement'));
        assert.equal(fs.readFileSync(file).equals(before), true, image ?? 'unset');
      }
    }
    assert.equal(watch.calls.length, 0);
    assert.equal(fs.existsSync(path.join(root, 'app', 'data')), false);
    assert.equal(fs.existsSync(path.join(root, 'app', 'output')), false);
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'kernel-lease.json')), false);
    assert.equal(leases.liveCount(), 0);
    assert.equal(fs.readFileSync(pinPath).equals(pinBefore), true);
    const after = JSON.parse(fs.readFileSync(pinPath, 'utf8')) as { status?: unknown; digest?: unknown };
    assert.equal(after.status, 'unresolved');
    assert.equal(after.digest, null);
  } finally {
    resetKernelSessions();
    resetNotebookPin();
    watch.restore();
    if (previous === undefined) delete process.env.LOAM_NOTEBOOK_IMAGE;
    else process.env.LOAM_NOTEBOOK_IMAGE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
