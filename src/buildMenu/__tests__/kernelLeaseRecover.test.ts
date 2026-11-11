import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverRememberedKernels } from '../notebooks/kernelLease.js';

const pinPath = path.resolve('src/buildMenu/notebooks/python/image-pin.json');
const leaseSource = path.resolve('src/buildMenu/notebooks/kernelLease.ts');

test('remembered kernel recovery skips an outside, escaped, or symlink pointer and does not spawn docker', () => {
  const source = fs.readFileSync(leaseSource, 'utf8');
  assert.equal(source.includes('child_process'), false);
  assert.equal(source.includes('docker'), false);
  assert.equal(source.includes('spawn'), false);
  const pinBefore = fs.readFileSync(pinPath);
  const pin = JSON.parse(pinBefore.toString('utf8')) as { status?: unknown; digest?: unknown };
  assert.equal(pin.status, 'unresolved');
  assert.equal(pin.digest, null);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-44-kernel-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-44-outside-'));
  const traversal = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-44-traversal-'));
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-44-decoy-'));
  const nested = path.join(root, 'nested');
  const registry = path.join(root, '.loam', 'build-menu', 'kernel-leases');
  const anchor = path.join(root, 'anchor');
  const escaped = `${anchor}${path.sep}..${path.sep}..${path.sep}${path.basename(traversal)}`;
  const originalLstat = fs.lstatSync.bind(fs);
  const originalRealpath = fs.realpathSync.bind(fs);
  try {
    const owned = plant(root, 'app_abcdefghijkl');
    const foreign = plant(outside, 'app_bbcdefghijkl');
    const walked = plant(traversal, 'app_cccdefghijkl');
    const linked = plant(decoy, 'app_ddddefghijkl');
    const escapedReal = plant(nested, 'app_eeedefghijkl');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'keep-outside');
    fs.writeFileSync(path.join(traversal, 'secret.txt'), 'keep-traversal');
    fs.writeFileSync(path.join(decoy, 'secret.txt'), 'keep-decoy');
    fs.writeFileSync(path.join(nested, 'secret.txt'), 'keep-nested');
    fs.mkdirSync(anchor, { recursive: true });
    fs.mkdirSync(registry, { recursive: true });
    assert.equal(path.isAbsolute(outside), true);
    assert.equal(path.resolve(escaped), path.resolve(traversal));
    assert.equal(escaped.includes('..'), true);
    assert.equal(path.relative(root, path.resolve(outside)).startsWith('..'), true);
    assert.equal(path.relative(root, path.resolve(traversal)).startsWith('..'), true);
    writePointer(registry, 'app_abcdefghijkl', path.resolve(root));
    writePointer(registry, 'app_bbcdefghijkl', path.resolve(outside));
    writePointer(registry, 'app_cccdefghijkl', escaped);
    const symlinkPointer = writePointer(registry, 'app_ddddefghijkl', path.resolve(decoy));
    writePointer(registry, 'app_eeedefghijkl', path.resolve(nested));
    assert.equal(originalLstat(symlinkPointer).isSymbolicLink(), false);
    assert.equal(originalLstat(nested).isSymbolicLink(), false);

    Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: fs.StatOptions) => {
      if (samePath(path.resolve(String(target)), path.resolve(symlinkPointer))) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => true } as fs.Stats;
      }
      return options === undefined ? originalLstat(target) : originalLstat(target, options);
    }) as typeof fs.lstatSync });
    fs.realpathSync = ((target: fs.PathLike) => {
      const resolved = path.resolve(String(target));
      if (samePath(resolved, path.resolve(nested))) return path.resolve(outside);
      return originalRealpath(target);
    }) as typeof fs.realpathSync;

    const seen = fs.lstatSync(symlinkPointer);
    assert.equal(seen.isFile(), true);
    assert.equal(seen.isSymbolicLink(), true);
    assert.equal(samePath(fs.realpathSync(nested), path.resolve(outside)), true);
    assert.equal(recoverRememberedKernels(registry), 1);
    assertUnchanged(foreign);
    assertUnchanged(walked);
    assertUnchanged(linked);
    assertUnchanged(escapedReal);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'keep-outside');
    assert.equal(fs.readFileSync(path.join(traversal, 'secret.txt'), 'utf8'), 'keep-traversal');
    assert.equal(fs.readFileSync(path.join(decoy, 'secret.txt'), 'utf8'), 'keep-decoy');
    assert.equal(fs.readFileSync(path.join(nested, 'secret.txt'), 'utf8'), 'keep-nested');
    const recorded = fs.readFileSync(owned.lease, 'utf8');
    assert.equal(recorded.includes('"phase":"interrupted"'), true);
    assert.equal(recorded.includes('container'), false);
    const saved = JSON.parse(fs.readFileSync(owned.book, 'utf8')) as { cells: Array<{ outputs?: Array<{ ename?: string }> }> };
    assert.equal(saved.cells[0]?.outputs?.[0]?.ename, 'interrupted');
    const after = JSON.parse(fs.readFileSync(pinPath, 'utf8')) as { status?: unknown; digest?: unknown };
    assert.equal(after.status, 'unresolved');
    assert.equal(after.digest, null);
    assert.equal(fs.readFileSync(pinPath).equals(pinBefore), true);
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: originalLstat });
    fs.realpathSync = originalRealpath;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(traversal, { recursive: true, force: true });
    fs.rmSync(decoy, { recursive: true, force: true });
  }
});

function samePath(left: string, right: string): boolean {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function writePointer(registry: string, projectId: string, workspace: string): string {
  const pointer = path.join(registry, `${projectId}.json`);
  fs.writeFileSync(pointer, `${JSON.stringify({ workspace })}\n`);
  return pointer;
}

function plant(workspace: string, projectId: string): { lease: string; book: string; leaseBody: string; bookBody: Buffer } {
  writeBook(workspace);
  writeManifest(workspace, projectId);
  const lease = path.join(workspace, '.loam', 'build-menu', 'kernel-lease.json');
  const book = path.join(workspace, 'app', 'notebook.ipynb');
  const leaseBody = `${JSON.stringify({ nonce: '0123456789abcdef', projectId, jobId: 'job_1', cellId: 'cell-1', phase: 'running' })}\n`;
  fs.mkdirSync(path.dirname(lease), { recursive: true });
  fs.writeFileSync(lease, leaseBody);
  return { lease, book, leaseBody, bookBody: fs.readFileSync(book) };
}

function assertUnchanged(planted: { lease: string; book: string; leaseBody: string; bookBody: Buffer }): void {
  assert.equal(fs.readFileSync(planted.lease, 'utf8'), planted.leaseBody);
  assert.equal(fs.readFileSync(planted.book).equals(planted.bookBody), true);
}

function writeManifest(workspace: string, projectId: string): void {
  const dir = path.join(workspace, '.loam', 'build-menu');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectId,
    revision: 1,
    selection: { kind: 'notebook' },
    title: 'دفتر',
    sourceDir: 'app',
    template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
    consent: { autostart: false, publish: false },
  })}\n`);
}

function writeBook(workspace: string): void {
  fs.mkdirSync(path.join(workspace, 'app'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'app', 'notebook.ipynb'), `${JSON.stringify({
    nbformat: 4,
    cells: [
      { id: 'cell-1', cell_type: 'code', source: ['print(1)\n'], outputs: [] },
      { id: 'cell-2', cell_type: 'code', source: ['print(2)\n'], outputs: [] },
    ],
  }, null, 2)}\n`);
}
