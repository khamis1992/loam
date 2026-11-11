/**
 * readProjectBytes, sourceEntries, and resolveArtifact refuse a file whose
 * nlink is greater than 1 before readFileSync. Outside bytes are not hashed
 * or returned. A regular nlink 1 file still reads. Hard links use fs.linkSync.
 * EPERM and EACCES from lstat are rethrown. MAX_FILES, MAX_BYTES, downloadName,
 * and the write-side nlink checks stay.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/artifactReadHardLink.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BuildMenuError } from '../grants.js';
import { downloadName, readProjectBytes, resolveArtifact, sourceEntries, writeBytesArtifact } from '../artifacts.js';

const PROJECT = 'app_abcdefghijkl';
const ARTIFACT = 'art_01234567-89ab-cdef-0123-456789abcdef';
const LOCAL = Buffer.from('local-note');
const OUTSIDE = Buffer.from('outside-bytes');

function refused(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function refusedMenu(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

function isCode(code: 'EPERM' | 'EACCES'): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (process.platform === 'win32') return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  return resolvedLeft === resolvedRight;
}

function sliceBetween(source: string, startMark: string, endMark: string): string {
  const start = source.indexOf(startMark);
  const end = endMark.length === 0 ? source.length : source.indexOf(endMark, start + startMark.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

function withPair(prefix: string, run: (workspace: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  try {
    run(workspace, outside);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertPlain(file: string): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink, 1);
}

function assertShared(inside: string, outsideFile: string, bytes: Buffer): void {
  const stat = fs.lstatSync(inside);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
  assert.deepEqual(fs.readFileSync(inside), bytes);
  assert.deepEqual(fs.readFileSync(outsideFile), bytes);
}

function projectFile(workspace: string, bytes: Buffer): string {
  const file = path.join(workspace, 'app', 'note.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

function linkProjectFile(workspace: string, outside: string, bytes: Buffer): { inside: string; outsideFile: string } {
  const outsideFile = path.join(outside, 'note.txt');
  const inside = path.join(workspace, 'app', 'note.txt');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(outsideFile, bytes);
  fs.linkSync(outsideFile, inside);
  return { inside, outsideFile };
}

function metaBody(bytes: Buffer): string {
  return JSON.stringify({
    artifactId: ARTIFACT,
    projectId: PROJECT,
    revision: 1,
    format: 'source-zip',
    relativePath: `.loam/build-menu/artifacts/${ARTIFACT}.zip`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  });
}

function artifactPaths(workspace: string): { dir: string; meta: string; zip: string } {
  const dir = path.join(workspace, '.loam', 'build-menu', 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    meta: path.join(dir, `${ARTIFACT}.json`),
    zip: path.join(dir, `${ARTIFACT}.zip`),
  };
}

function withoutReading(file: string, run: () => void): void {
  const realReadFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (typeof target !== 'number' && samePath(String(target), file)) reads += 1;
    return realReadFileSync(target, options);
  }) as typeof fs.readFileSync;
  try {
    run();
    assert.equal(reads, 0);
  } finally {
    fs.readFileSync = realReadFileSync;
  }
}

function refuseLstat(file: string, code: 'EPERM' | 'EACCES', run: () => void): void {
  const realLstatSync = fs.lstatSync;
  const realReadFileSync = fs.readFileSync;
  let reads = 0;
  Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (!samePath(String(target), file)) return realLstatSync(target, options);
    const error = new Error('operation not permitted') as NodeJS.ErrnoException;
    error.code = code;
    throw error;
  }) as typeof fs.lstatSync });
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (typeof target !== 'number' && samePath(String(target), file)) reads += 1;
    return realReadFileSync(target, options);
  }) as typeof fs.readFileSync;
  try {
    assert.throws(run, isCode(code));
    assert.equal(reads, 0);
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    fs.readFileSync = realReadFileSync;
  }
}

test('each read refuses nlink before readFileSync and the write checks stay', () => {
  const source = fs.readFileSync(new URL('../artifacts.ts', import.meta.url), 'utf8');
  const project = sliceBetween(source, 'export function readProjectBytes', 'export function sourceEntries');
  const projectRead = project.indexOf('return fs.readFileSync(absolute)');
  assert.ok(project.indexOf('stat.nlink > 1') >= 0 && project.indexOf('stat.nlink > 1') < projectRead);
  assert.ok(project.indexOf("code === 'EPERM' || code === 'EACCES'") >= 0);
  assert.ok(project.indexOf("code === 'EPERM' || code === 'EACCES'") < projectRead);

  const entries = sliceBetween(source, 'export function sourceEntries', 'function exportedNotebook');
  const entryRead = entries.indexOf('fs.readFileSync(absolute)');
  assert.ok(entries.indexOf('stat.nlink > 1') >= 0 && entries.indexOf('stat.nlink > 1') < entryRead);
  assert.equal(entries.includes('catch'), false);

  const resolved = sliceBetween(source, 'export function resolveArtifact', '');
  const metaRead = resolved.indexOf('fs.readFileSync(metaPath');
  const fileRead = resolved.indexOf('fs.readFileSync(filePath)');
  const hashAt = resolved.indexOf("createHash('sha256')");
  const metaGuard = resolved.indexOf('metaStat.nlink > 1');
  const fileGuard = resolved.indexOf('fileStat.nlink > 1');
  assert.ok(metaGuard >= 0 && metaGuard < metaRead);
  assert.ok(fileGuard > metaRead && fileGuard < fileRead);
  assert.ok(hashAt > fileRead);
  assert.equal(resolved.includes('catch'), false);

  const writer = sliceBetween(source, 'export function writeAtomicFile', 'function persistArtifact');
  assert.equal((writer.match(/nlink > 1/g) ?? []).length, 2);
  assert.match(writer, /if \(\(error as NodeJS\.ErrnoException\)\.code !== 'ENOENT'\) throw error;/);
  assert.equal((source.match(/nlink > 1/g) ?? []).length, 6);
  assert.match(source, /const MAX_FILES = 5_000;/);
  assert.match(source, /const MAX_BYTES = 100_000_000;/);
  const names = sliceBetween(source, 'export function downloadName', 'export function artifactHeaders');
  assert.equal(names.includes('nlink'), false);
  assert.match(names, /invalid_request/);
  assert.equal(downloadName(`${ARTIFACT}.zip`), `${ARTIFACT}.zip`);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
});

test('a regular nlink 1 file still reads', () => {
  withPair('loam-48-artifact-read-nlink1-', (workspace) => {
    const file = projectFile(workspace, LOCAL);
    assertPlain(file);
    assert.deepEqual(readProjectBytes(workspace, 'note.txt'), LOCAL);
    const entries = sourceEntries(path.join(workspace, 'app'));
    assert.deepEqual(entries.map((entry) => entry.name), ['note.txt']);
    assert.deepEqual(entries[0]?.data, LOCAL);
    assertPlain(file);

    assert.throws(
      () => readProjectBytes(workspace, 'missing.txt'),
      refusedMenu,
    );
    assert.throws(
      () => resolveArtifact(workspace, PROJECT, ARTIFACT),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'not_found' && error.status === 404,
    );

    const artifact = writeBytesArtifact(workspace, PROJECT, 1, 'source-zip', LOCAL, 'zip');
    const stored = path.join(workspace, artifact.relativePath);
    const meta = path.join(workspace, '.loam', 'build-menu', 'artifacts', `${artifact.artifactId}.json`);
    assertPlain(stored);
    assertPlain(meta);
    const loaded = resolveArtifact(workspace, PROJECT, artifact.artifactId);
    assert.deepEqual(loaded.bytes, LOCAL);
    assert.equal(loaded.artifact.sha256, createHash('sha256').update(LOCAL).digest('hex'));
    assert.equal(loaded.artifact.sha256, artifact.sha256);
    assertPlain(stored);
    assertPlain(meta);
  });
});

test('readProjectBytes refuses nlink before read and the outside bytes stay', () => {
  withPair('loam-48-artifact-read-project-', (workspace, outside) => {
    const { inside, outsideFile } = linkProjectFile(workspace, outside, OUTSIDE);
    assertShared(inside, outsideFile, OUTSIDE);
    withoutReading(inside, () => {
      assert.throws(() => readProjectBytes(workspace, 'note.txt'), refusedMenu);
    });
    assertShared(inside, outsideFile, OUTSIDE);
  });
});

test('sourceEntries refuses nlink before read and the outside bytes stay', () => {
  withPair('loam-48-artifact-read-entries-', (workspace, outside) => {
    const { inside, outsideFile } = linkProjectFile(workspace, outside, OUTSIDE);
    assertShared(inside, outsideFile, OUTSIDE);
    withoutReading(inside, () => {
      assert.throws(() => sourceEntries(path.join(workspace, 'app')), refused);
    });
    assertShared(inside, outsideFile, OUTSIDE);
  });
});

test('resolveArtifact refuses a hard-linked metadata file before read', () => {
  withPair('loam-48-artifact-read-meta-', (workspace, outside) => {
    const { meta } = artifactPaths(workspace);
    const outsideFile = path.join(outside, `${ARTIFACT}.json`);
    fs.writeFileSync(outsideFile, OUTSIDE);
    fs.linkSync(outsideFile, meta);
    assertShared(meta, outsideFile, OUTSIDE);
    withoutReading(meta, () => {
      assert.throws(() => resolveArtifact(workspace, PROJECT, ARTIFACT), refusedMenu);
    });
    assertShared(meta, outsideFile, OUTSIDE);
  });
});

test('resolveArtifact refuses a hard-linked artifact before read and does not hash it', () => {
  withPair('loam-48-artifact-read-bytes-', (workspace, outside) => {
    const { meta, zip } = artifactPaths(workspace);
    const outsideFile = path.join(outside, `${ARTIFACT}.zip`);
    const body = metaBody(OUTSIDE);
    fs.writeFileSync(outsideFile, OUTSIDE);
    fs.linkSync(outsideFile, zip);
    fs.writeFileSync(meta, body);
    assertPlain(meta);
    assertShared(zip, outsideFile, OUTSIDE);
    withoutReading(zip, () => {
      assert.throws(() => resolveArtifact(workspace, PROJECT, ARTIFACT), refusedMenu);
    });
    assert.equal(fs.readFileSync(meta, 'utf8'), body);
    assertPlain(meta);
    assertShared(zip, outsideFile, OUTSIDE);
  });
});

test('lstat EPERM and EACCES escape before each read', () => {
  for (const code of ['EPERM', 'EACCES'] as const) {
    withPair(`loam-48-artifact-read-${code.toLowerCase()}-`, (workspace) => {
      const file = projectFile(workspace, LOCAL);
      assertPlain(file);
      refuseLstat(file, code, () => readProjectBytes(workspace, 'note.txt'));
      assertPlain(file);
      assert.deepEqual(fs.readFileSync(file), LOCAL);

      refuseLstat(file, code, () => sourceEntries(path.join(workspace, 'app')));
      assertPlain(file);
      assert.deepEqual(fs.readFileSync(file), LOCAL);

      const { meta, zip } = artifactPaths(workspace);
      const body = metaBody(LOCAL);
      fs.writeFileSync(meta, body);
      fs.writeFileSync(zip, LOCAL);
      assertPlain(meta);
      assertPlain(zip);
      refuseLstat(meta, code, () => resolveArtifact(workspace, PROJECT, ARTIFACT));
      assert.equal(fs.readFileSync(meta, 'utf8'), body);
      assertPlain(meta);
      refuseLstat(zip, code, () => resolveArtifact(workspace, PROJECT, ARTIFACT));
      assert.deepEqual(fs.readFileSync(zip), LOCAL);
      assert.equal(fs.readFileSync(meta, 'utf8'), body);
      assertPlain(zip);
      assertPlain(meta);
    });
  }
});
