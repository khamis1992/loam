import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildMenuError } from '../grants.js';
import { configureKernelRecovery, recoverKernelLease, recoverRememberedKernels } from '../notebooks/kernelLease.js';

test('a restarted kernel is marked interrupted and a saved container id is not stopped', () => {
  const source = fs.readFileSync(path.resolve('src/buildMenu/notebooks/kernelLease.ts'), 'utf8');
  assert.equal(source.includes('child_process'), false);
  assert.equal(source.includes('docker'), false);
  assert.equal(source.includes('spawn'), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-ok-'));
  const skipped = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-skip-'));
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-reg-'));
  configureKernelRecovery(null);
  try {
    writeBook(root);
    writeBook(skipped);
    writeManifest(root, 'app_abcdefghijkl', 'notebook');
    const lease = path.join(root, '.loam', 'build-menu', 'kernel-lease.json');
    fs.mkdirSync(path.dirname(lease), { recursive: true });
    fs.writeFileSync(lease, `${JSON.stringify({ nonce: '0123456789abcdef', projectId: 'app_abcdefghijkl', jobId: 'job_1', cellId: 'cell-1', phase: 'running', containerId: 'other-person-container' })}\n`);
    const skippedLease = path.join(skipped, '.loam', 'build-menu', 'kernel-lease.json');
    fs.mkdirSync(path.dirname(skippedLease), { recursive: true });
    const skippedBody = `${JSON.stringify({ nonce: 'not-a-nonce', cellId: 'cell-1', phase: 'running', containerId: 'other-person-container' })}\n`;
    fs.writeFileSync(skippedLease, skippedBody);
    const skippedBook = fs.readFileSync(path.join(skipped, 'app', 'notebook.ipynb'));
    fs.writeFileSync(path.join(registry, 'app_abcdefghijkl.json'), `${JSON.stringify({ workspace: root, containerId: 'other-person-container' })}\n`);
    fs.writeFileSync(path.join(registry, 'app_bbcdefghijkl.json'), `${JSON.stringify({ workspace: skipped, containerId: 'other-person-container' })}\n`);
    assert.equal(recoverRememberedKernels(registry), 1);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'), 'utf8')) as { cells: Array<{ id: string; source: string[]; outputs: Array<{ ename?: string }> }> };
    assert.equal(saved.cells[0]?.outputs[0]?.ename, 'interrupted');
    assert.deepEqual(saved.cells[0]?.source, ['print(1)\n']);
    assert.deepEqual(saved.cells[1]?.source, ['print(2)\n']);
    assert.equal(saved.cells[1]?.outputs.length, 0);
    const recorded = fs.readFileSync(lease, 'utf8');
    assert.equal(recorded.includes('other-person-container'), false);
    assert.equal(recorded.includes('"phase":"interrupted"'), true);
    assert.equal(fs.readFileSync(skippedLease, 'utf8'), skippedBody);
    assert.equal(fs.readFileSync(path.join(skipped, 'app', 'notebook.ipynb')).equals(skippedBook), true);
    assert.equal(recoverKernelLease(root), false);
    fs.rmSync(lease);
    fs.mkdirSync(lease);
    assert.throws(() => recoverKernelLease(root), (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path');
  } finally {
    configureKernelRecovery(null);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(skipped, { recursive: true, force: true });
    fs.rmSync(registry, { recursive: true, force: true });
  }
});

test('kernel recovery ignores a pointer aimed at another folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lease-foreign-'));
  const foreign = path.join(root, 'foreign');
  const registry = path.join(root, 'registry');
  try {
    writeBook(foreign);
    writeManifest(foreign, 'app_abcdefghijkl', 'website');
    const lease = path.join(foreign, '.loam', 'build-menu', 'kernel-lease.json');
    const body = `${JSON.stringify({ nonce: '0123456789abcdef', projectId: 'app_abcdefghijkl', jobId: 'job_1', cellId: 'cell-1', phase: 'running' })}\n`;
    fs.writeFileSync(lease, body);
    const book = fs.readFileSync(path.join(foreign, 'app', 'notebook.ipynb'));
    fs.mkdirSync(registry, { recursive: true });
    fs.writeFileSync(path.join(registry, 'app_abcdefghijkl.json'), `${JSON.stringify({ workspace: foreign })}\n`);
    assert.equal(recoverRememberedKernels(registry), 0);
    assert.equal(fs.readFileSync(lease, 'utf8'), body);
    assert.equal(fs.readFileSync(path.join(foreign, 'app', 'notebook.ipynb')).equals(book), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeManifest(workspace: string, projectId: string, kind: 'notebook' | 'website'): void {
  const dir = path.join(workspace, '.loam', 'build-menu');
  fs.mkdirSync(dir, { recursive: true });
  const selection = kind === 'website' ? { kind, subtype: 'landing' as const } : { kind: 'notebook' as const };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectId,
    revision: 1,
    selection,
    title: 'دفتر',
    sourceDir: 'app',
    template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
    consent: { autostart: false, publish: false },
  })}\n`);
}

function writeBook(root: string): void {
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'notebook.ipynb'), `${JSON.stringify({
    nbformat: 4,
    cells: [
      { id: 'cell-1', cell_type: 'code', source: ['print(1)\n'], outputs: [] },
      { id: 'cell-2', cell_type: 'code', source: ['print(2)\n'], outputs: [] },
    ],
  }, null, 2)}\n`);
}
