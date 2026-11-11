/**
 * readManifest does not parse a manifest whose nlink is greater than 1.
 * saveManifest does not copy onto a backup destination whose nlink is greater
 * than 1. Outside bytes stay. A regular nlink 1 manifest still reads and
 * still saves. Hard links use fs.linkSync. EPERM is not caught. The busy
 * check, including phase stopping, and the case-insensitive latest rejection
 * stay. This file does not create a symlink or junction, and it does not
 * edit config.json.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/manifestReadHardLink.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { readManifest, saveManifest } from '../manifest.js';

const lock = 'a'.repeat(64);

function stored(revision: number): BuildManifest {
  return {
    schemaVersion: 1,
    projectId: 'app_abcdefghijkl',
    revision,
    selection: { kind: 'website', subtype: 'landing' },
    title: 'موقع',
    sourceDir: 'app',
    template: { id: 'loam-build', revision: '1', lockSha256: lock },
    consent: { autostart: false, publish: false },
  };
}

function isUnsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function manifestFile(workspace: string): string {
  return path.join(workspace, '.loam', 'build-menu', 'manifest.json');
}

function pair(prefix: string): { workspace: string; outside: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, 'ws');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}out-`));
  fs.mkdirSync(workspace);
  return { workspace, outside, root };
}

function removePair(root: string, outside: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

function assertLinked(file: string, outsideFile: string): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
}

function assertPlain(file: string): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink, 1);
}

test('read and backup check nlink, and busy, latest, and the off menu flag stay', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../manifest.ts', import.meta.url)), 'utf8');
  const configSource = fs.readFileSync(fileURLToPath(new URL('../../config.ts', import.meta.url)), 'utf8');
  const helper = source.slice(source.indexOf('function assertManifestNotHardLinked'), source.indexOf('function workspaceIsStopping'));
  const readBody = source.slice(source.indexOf('export function readManifest'), source.indexOf('export async function saveManifest'));
  const saveBody = source.slice(source.indexOf('export async function saveManifest'));
  assert.match(helper, /stat\.nlink > 1/);
  assert.match(helper, /code === 'ENOENT'/);
  assert.equal(helper.includes('EPERM'), false);
  assert.equal((source.match(/stat\.nlink > 1/g) ?? []).length, 1);
  assert.ok(readBody.indexOf('assertManifestNotHardLinked(target)') < readBody.indexOf('fs.readFileSync'));
  assert.ok(readBody.indexOf('assertManifestNotHardLinked(target)') < readBody.indexOf('JSON.parse'));
  assert.ok(saveBody.indexOf('manifestSchema.safeParse(next)') < saveBody.indexOf('readManifest(workspace)'));
  assert.ok(saveBody.indexOf('workspaceIsStopping(workspace)') < saveBody.indexOf('fs.copyFileSync'));
  assert.ok(saveBody.indexOf('revisionGuard?.(workspace)') < saveBody.indexOf('fs.copyFileSync'));
  assert.ok(saveBody.indexOf('assertManifestNotHardLinked(backup)') < saveBody.indexOf('fs.copyFileSync'));
  assert.match(saveBody, /manifest\.\$\{current\.revision\}\.bak\.json/);
  assert.match(source, /phase === 'stopping'/);
  assert.match(source, /toLowerCase\(\) !== 'latest'/);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('config.json'), false);
  assert.equal(configSource.includes('buildMenu: { enabled: false }'), true);
});

test('a hard-linked manifest is not parsed and the outside bytes stay', async () => {
  const { workspace, outside, root } = pair('loam-48-manifest-read-');
  const file = manifestFile(workspace);
  const outsideFile = path.join(outside, 'outside-bytes.json');
  const previous = Buffer.from(`${JSON.stringify(stored(1), null, 2)}\n`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(outsideFile, previous);
  fs.linkSync(outsideFile, file);
  const realReadFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: { encoding?: BufferEncoding | null; flag?: string }) => {
    if (typeof target !== 'number' && path.resolve(String(target)) === path.resolve(file)) reads += 1;
    return realReadFileSync(target, options as { encoding?: BufferEncoding | null; flag?: string });
  }) as typeof fs.readFileSync;
  try {
    assertLinked(file, outsideFile);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['manifest.json']);
    const latest = { ...stored(2), template: { ...stored(1).template, revision: 'LaTeSt' } };
    await assert.rejects(saveManifest(workspace, latest, 1), /invalid_request/);
    assert.equal(reads, 0);
    assert.throws(() => readManifest(workspace), isUnsafePath);
    assert.equal(reads, 0);
    await assert.rejects(saveManifest(workspace, stored(2), 1), isUnsafePath);
    assert.equal(reads, 0);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(file), previous);
    assertLinked(file, outsideFile);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['manifest.json']);
  } finally {
    fs.readFileSync = realReadFileSync;
    removePair(root, outside);
  }
});

test('a hard-linked backup destination is not overwritten and the outside bytes stay', async () => {
  const { workspace, outside, root } = pair('loam-48-manifest-bak-');
  const file = manifestFile(workspace);
  const outsideFile = path.join(outside, 'outside-bytes.json');
  const outsideBytes = Buffer.from('outside-backup-bytes');
  fs.writeFileSync(outsideFile, outsideBytes);
  const realCopy = fs.copyFileSync;
  let copies = 0;
  fs.copyFileSync = ((source: fs.PathLike, destination: fs.PathLike, mode?: number) => {
    copies += 1;
    return realCopy(source, destination, mode);
  }) as typeof fs.copyFileSync;
  try {
    await saveManifest(workspace, stored(1), 0);
    const before = fs.readFileSync(file);
    const backup = path.join(path.dirname(file), 'manifest.1.bak.json');
    fs.linkSync(outsideFile, backup);
    assertLinked(backup, outsideFile);
    const names = fs.readdirSync(path.dirname(file)).sort();
    await assert.rejects(saveManifest(workspace, stored(2), 1), isUnsafePath);
    assert.equal(copies, 0);
    assert.deepEqual(fs.readFileSync(outsideFile), outsideBytes);
    assert.deepEqual(fs.readFileSync(backup), outsideBytes);
    assert.deepEqual(fs.readFileSync(file), before);
    assertLinked(backup, outsideFile);
    assertPlain(file);
    assert.equal(readManifest(workspace)?.revision, 1);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), names);
  } finally {
    fs.copyFileSync = realCopy;
    removePair(root, outside);
  }
});

test('a regular nlink 1 manifest still reads and still saves', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-manifest-plain-'));
  const file = manifestFile(workspace);
  try {
    assert.equal(readManifest(workspace), null);
    const created = await saveManifest(workspace, stored(1), 0);
    assert.equal(created.revision, 1);
    assert.equal(readManifest(workspace)?.revision, 1);
    assertPlain(file);
    const backup = path.join(path.dirname(file), 'manifest.1.bak.json');
    fs.writeFileSync(backup, Buffer.from('plain-backup'));
    assertPlain(backup);
    const replaced = await saveManifest(workspace, stored(2), 1);
    assert.equal(replaced.revision, 2);
    assert.equal(readManifest(workspace)?.revision, 2);
    assertPlain(file);
    assertPlain(backup);
    assert.equal(fs.readFileSync(file, 'utf8').includes('"revision": 2'), true);
    assert.equal(fs.readFileSync(backup, 'utf8').includes('"revision": 1'), true);
    assert.equal(fs.readFileSync(backup, 'utf8').includes('plain-backup'), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a stopping phase still rejects the save with busy and the manifest bytes stay', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-manifest-busy-'));
  const file = manifestFile(workspace);
  try {
    await saveManifest(workspace, stored(1), 0);
    const before = fs.readFileSync(file);
    fs.writeFileSync(path.join(path.dirname(file), 'active-job.json'), `${JSON.stringify({ phase: 'stopping' })}\n`);
    await assert.rejects(
      saveManifest(workspace, stored(2), 1),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'busy' && error.status === 409,
    );
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(readManifest(workspace)?.revision, 1);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['active-job.json', 'manifest.json']);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('lstat EPERM is not swallowed before a manifest is parsed', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-manifest-eperm-'));
  const file = manifestFile(workspace);
  const previous = Buffer.from(`${JSON.stringify(stored(1), null, 2)}\n`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, previous);
  assertPlain(file);
  const realLstatSync = fs.lstatSync;
  let hits = 0;
  Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (path.resolve(String(target)) === path.resolve(file)) {
      hits += 1;
      if (hits > 1) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
    }
    return realLstatSync(target, options);
  }) as typeof fs.lstatSync });
  try {
    assert.throws(() => readManifest(workspace), isEperm);
    assert.equal(hits > 1, true);
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
  }
  assert.deepEqual(realLstatSync(file).nlink, 1);
  assert.deepEqual(fs.readFileSync(file), previous);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('lstat EPERM is not swallowed before a backup copy and the outside bytes stay', async () => {
  const { workspace, outside, root } = pair('loam-48-manifest-bak-eperm-');
  const file = manifestFile(workspace);
  const outsideFile = path.join(outside, 'outside-bytes.json');
  const outsideBytes = Buffer.from('outside-backup-bytes');
  fs.writeFileSync(outsideFile, outsideBytes);
  const realLstatSync = fs.lstatSync;
  const realCopy = fs.copyFileSync;
  let copies = 0;
  try {
    await saveManifest(workspace, stored(1), 0);
    const before = fs.readFileSync(file);
    const backup = path.join(path.dirname(file), 'manifest.1.bak.json');
    fs.linkSync(outsideFile, backup);
    assertLinked(backup, outsideFile);
    fs.copyFileSync = ((source: fs.PathLike, destination: fs.PathLike, mode?: number) => {
      copies += 1;
      return realCopy(source, destination, mode);
    }) as typeof fs.copyFileSync;
    Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) === path.resolve(backup)) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync });
    await assert.rejects(saveManifest(workspace, stored(2), 1), isEperm);
    assert.equal(copies, 0);
    assert.deepEqual(realLstatSync(outsideFile).nlink > 1, true);
    assert.deepEqual(fs.readFileSync(outsideFile), outsideBytes);
    assert.deepEqual(fs.readFileSync(backup), outsideBytes);
    assert.deepEqual(fs.readFileSync(file), before);
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    fs.copyFileSync = realCopy;
    removePair(root, outside);
  }
});
