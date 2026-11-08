/**
 * Generated mobile worktree writes throw unsafe_path when the destination
 * already exists and nlink is greater than 1. Outside bytes stay. A missing
 * file still writes. Hard links use fs.linkSync. Remote-scheme and
 * secret-filename refusals stay. This file does not create a symlink or
 * junction, write an apk, run Gradle, or claim a device test.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/mobileSourceHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { materialize } from '../materialize.js';
import { codeTag, readCode } from '../../mobile/versions.js';
import { readMobile } from '../../mobile/store.js';
import { materializeSource, saveSource, sourceExport, writeWorktreeFile } from '../../mobile/source.js';

const FRESH = 'const marker="fresh-worktree";\n';
const REPLACED = 'const marker="replaced-worktree";\n';

function refused(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function pair(prefix: string): { root: string; outside: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}out-`));
  return { root, outside };
}

function removePair(root: string, outside: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

function worktreeFile(root: string, name: string): string {
  return path.join(root, '.loam', 'mobile-worktree', ...name.split('/'));
}

function plant(outside: string, destination: string, bytes: Buffer): string {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const outsideFile = path.join(outside, path.basename(destination));
  fs.writeFileSync(outsideFile, bytes);
  fs.linkSync(outsideFile, destination);
  return outsideFile;
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

function apkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...apkFiles(absolute));
    else if (item.isFile() && item.name.toLowerCase().endsWith('.apk')) found.push(absolute);
  }
  return found;
}

function sliceBetween(source: string, startMark: string, endMark: string): string {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

function project(root: string): void {
  materialize({ selection: { kind: 'mobile' }, workspace: root, title: 'جوال' });
}

test('source writes check nlink once and keep the remote and secret refusals', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../../mobile/source.ts', import.meta.url)), 'utf8');
  const materializeBody = sliceBetween(source, 'export async function materializeSource', 'export function writeWorktreeFile');
  const writeBody = sliceBetween(source, 'export function writeWorktreeFile', 'export async function sourceExport');
  const exportBody = source.slice(source.indexOf('export async function sourceExport'));
  assert.equal((source.match(/stat\.nlink > 1/g) ?? []).length, 1);
  assert.equal(materializeBody.indexOf('refuseSharedDestination(') < materializeBody.indexOf('fs.writeFileSync('), true);
  assert.equal(writeBody.indexOf('refuseSharedDestination(') < writeBody.indexOf('fs.writeFileSync('), true);
  assert.match(exportBody, /remoteWebFile\(/);
  assert.match(exportBody, /secretFile\(/);
  assert.match(exportBody, /packedSecret\(/);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(source.includes('EPERM'), false);
  assert.equal(/gradle/i.test(source), false);
  assert.equal(source.includes('.apk'), false);
});

test('a hard-linked worktree file throws unsafe_path before write and the outside bytes stay', () => {
  const { root, outside } = pair('loam-47-mobile-write-');
  const file = worktreeFile(root, 'web/app.js');
  const previous = Buffer.from('outside-worktree-app');
  try {
    const outsideFile = plant(outside, file, previous);
    assertLinked(file, outsideFile);
    assert.throws(() => writeWorktreeFile(root, 'web/app.js', REPLACED), refused);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assertLinked(file, outsideFile);
    assert.equal(fs.existsSync(path.join(root, '.loam', 'mobile-worktree-manifest.json')), false);
    assert.deepEqual(apkFiles(root), []);
  } finally {
    removePair(root, outside);
  }
});

test('a missing worktree file still writes and a regular nlink 1 file still updates', () => {
  const { root, outside } = pair('loam-47-mobile-fresh-');
  const file = worktreeFile(root, 'web/app.js');
  try {
    assert.equal(fs.existsSync(file), false);
    writeWorktreeFile(root, 'web/app.js', FRESH);
    assertPlain(file);
    assert.equal(fs.readFileSync(file, 'utf8'), FRESH);
    writeWorktreeFile(root, 'web/app.js', REPLACED);
    assertPlain(file);
    assert.equal(fs.readFileSync(file, 'utf8'), REPLACED);
    assert.deepEqual(apkFiles(root), []);
  } finally {
    removePair(root, outside);
  }
});

test('a missing generated file still writes and a regular nlink 1 file still refreshes', async () => {
  const { root, outside } = pair('loam-47-mobile-gen-');
  const file = worktreeFile(root, 'web/app.js');
  try {
    project(root);
    assert.equal(fs.existsSync(file), false);
    const created = await materializeSource(root, 'task-source');
    assertPlain(file);
    assert.equal(fs.readFileSync(file, 'utf8'), created.files['web/app.js']);
    assert.match(fs.readFileSync(file, 'utf8'), /mountMobile/);
    const snapshot = fs.readFileSync(file);
    await materializeSource(root, 'task-source');
    assertPlain(file);
    assert.deepEqual(fs.readFileSync(file), snapshot);
    assert.deepEqual(apkFiles(root), []);
  } finally {
    removePair(root, outside);
  }
});

test('an existing generated file with nlink greater than 1 is refused before write', async () => {
  const { root, outside } = pair('loam-47-mobile-gen-link-');
  const file = worktreeFile(root, 'web/app.js');
  const previous = Buffer.from('outside-generated-app');
  try {
    project(root);
    const outsideFile = plant(outside, file, previous);
    assertLinked(file, outsideFile);
    await assert.rejects(materializeSource(root, 'task-source', true), refused);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assertLinked(file, outsideFile);
    assert.equal(fs.existsSync(path.join(root, '.loam', 'mobile-worktree-manifest.json')), false);
    assert.deepEqual(apkFiles(root), []);
  } finally {
    removePair(root, outside);
  }
});

test('lstat EPERM is not swallowed before a worktree write', () => {
  const { root, outside } = pair('loam-47-mobile-eperm-');
  const file = worktreeFile(root, 'web/app.js');
  const previous = Buffer.from('outside-eperm-app');
  const outsideFile = plant(outside, file, previous);
  const resolved = path.resolve(file);
  const realLstatSync = fs.lstatSync;
  let hits = 0;
  fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (path.resolve(String(target)) === resolved) {
      hits += 1;
      if (hits > 1) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
    }
    return realLstatSync(target, options);
  }) as typeof fs.lstatSync;
  try {
    assert.throws(() => writeWorktreeFile(root, 'web/app.js', REPLACED), isEperm);
    assert.equal(hits > 1, true);
    assert.equal(realLstatSync(file).nlink > 1, true);
    assert.equal(realLstatSync(file).isSymbolicLink(), false);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(apkFiles(root), []);
  } finally {
    fs.lstatSync = realLstatSync;
    removePair(root, outside);
  }
});

test('lstat EPERM is not swallowed before a generated write', async () => {
  const { root, outside } = pair('loam-47-mobile-gen-eperm-');
  const file = worktreeFile(root, 'web/app.js');
  const previous = Buffer.from('outside-generated-eperm');
  const realLstatSync = fs.lstatSync;
  try {
    project(root);
    await materializeSource(root, 'task-source');
    fs.writeFileSync(file, previous);
    assertPlain(file);
    const resolved = path.resolve(file);
    let hits = 0;
    fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) === resolved) {
        hits += 1;
        if (hits > 1) {
          const error = new Error('operation not permitted') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync;
    await assert.rejects(materializeSource(root, 'task-source', true), isEperm);
    assert.equal(hits > 1, true);
    assert.equal(realLstatSync(file).nlink, 1);
    assert.equal(realLstatSync(file).isSymbolicLink(), false);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(apkFiles(root), []);
  } finally {
    fs.lstatSync = realLstatSync;
    removePair(root, outside);
  }
});

test('source export still drops secret filenames and refuses a remote scheme', async () => {
  const { root, outside } = pair('loam-47-mobile-refuse-');
  try {
    project(root);
    let saved = readMobile(root);
    assert.ok(saved);
    saved = saveSource(root, 'expo/google-services.json', '{"project_id":"loam-secret-services"}\n', saved.revision, codeTag(readCode(root)));
    saved = saveSource(root, 'android/local.properties', 'sdk.dir=C:\\\\Users\\\\loam-secret-sdk\\\\Android\\\\Sdk\n', saved.revision, codeTag(readCode(root)));
    saved = saveSource(root, 'android/app/secret.properties', 'api_key=sk-loamsecretvalue\n', saved.revision, codeTag(readCode(root)));
    const bytes = await sourceExport(root, 'task-source');
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir);
    const parts: string[] = [];
    for (const name of names) {
      parts.push(name);
      const entry = zip.file(name);
      if (entry) parts.push(await entry.async('string'));
    }
    const packed = parts.join('\n');
    assert.equal(names.some((name) => name.endsWith('.apk')), false);
    assert.equal(names.includes('expo/google-services.json'), false);
    assert.equal(names.includes('android/local.properties'), false);
    assert.equal(names.includes('android/app/secret.properties'), false);
    assert.equal(packed.includes('loam-secret-services'), false);
    assert.equal(packed.includes('loam-secret-sdk'), false);
    assert.equal(packed.includes('sk-loamsecretvalue'), false);
    assert.match(packed, /not an APK/);
    const stored = JSON.stringify(readCode(root).files);
    assert.match(stored, /loam-secret-services/);
    assert.match(stored, /loam-secret-sdk/);
    assert.match(stored, /sk-loamsecretvalue/);

    const current = readMobile(root);
    assert.ok(current);
    saveSource(root, 'web/index.html', '<!doctype html><script src="https://evil.example/web.js"></script>', current.revision, codeTag(readCode(root)));
    await assert.rejects(sourceExport(root, 'task-source'), refused);
    assert.match(JSON.stringify(readCode(root).files), /evil\.example\/web\.js/);
    assert.deepEqual(apkFiles(root), []);
  } finally {
    removePair(root, outside);
  }
});
