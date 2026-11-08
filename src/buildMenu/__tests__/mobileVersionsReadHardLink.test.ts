/**
 * readCode, listVersions, seedVersions, and versionSnapshot throw unsafe_path
 * when nlink is greater than 1, before readFileSync. Outside bytes are not
 * parsed. A missing code or versions file still returns the empty fallback.
 * A regular nlink 1 file still reads. Hard links use fs.linkSync. EPERM and
 * EACCES from lstat are rethrown. atomicJson's write-side nlink check stays.
 * This file does not create a symlink or junction, write an apk, or run Gradle.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/mobileVersionsReadHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listVersions, readCode, seedVersions, versionSnapshot } from '../../mobile/versions.js';

const SNAPSHOT = 'a'.repeat(64);
const VERSION_ID = 'ver-local';
const CODE = '{"files":{"web/app.js":"local-code"}}';
const VERSIONS = `[{"id":"${VERSION_ID}","revision":2,"label":"saved","createdAt":null,"bookmarked":false,"snapshot":"${SNAPSHOT}"}]`;
const MOBILE = '{"history":{"past":[{"title":"local-past-title","revision":1}]}}';
const HISTORY = '{"project":{"title":"local-snapshot-title"},"code":{"files":{"web/app.js":"local-code"}}}';
const OUTSIDE_CODE = '{"files":{"web/app.js":"outside-secret-code"}}';
const OUTSIDE_VERSIONS = `[{"id":"outside","snapshot":"${'b'.repeat(64)}","label":"outside-secret-version"}]`;
const OUTSIDE_MOBILE = '{"title":"outside-secret-project","history":{"past":[{"title":"outside-secret-past"}]}}';
const OUTSIDE_HISTORY = '{"project":{"title":"outside-secret-snapshot"},"code":{"files":{"x":"outside-secret-code"}}}';
const project = {
  version: 1 as const,
  revision: 2,
  title: 'local-current-title',
  accent: '#112233',
  direction: 'rtl' as const,
  screens: [{ id: 'home', title: 'Home', blocks: [] }],
};

function refused(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (process.platform === 'win32') return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  return resolvedLeft === resolvedRight;
}

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.equal(from >= 0 && to > from, true);
  return source.slice(from, to);
}

function withPair(prefix: string, run: (root: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}out-`));
  try {
    run(root, outside);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

function codeFile(root: string): string {
  return path.join(root, '.loam', 'mobile-code.json');
}

function versionsFile(root: string): string {
  return path.join(root, '.loam', 'mobile-versions.json');
}

function mobileFile(root: string): string {
  return path.join(root, '.loam', 'mobile.json');
}

function historyFile(root: string): string {
  return path.join(root, '.loam', 'mobile-history', `${SNAPSHOT}.json`);
}

function writeVersions(root: string): string {
  const file = versionsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, VERSIONS);
  return file;
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
  assert.equal(fs.lstatSync(outsideFile).nlink > 1, true);
}

function assertPlain(file: string): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink, 1);
}

function assertNoApk(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) assertNoApk(absolute);
    else assert.equal(item.name.toLowerCase().endsWith('.apk'), false);
  }
}

function guardReads(target: string, run: (reads: () => number) => void): void {
  const realReadFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (typeof file !== 'number' && samePath(String(file), target)) {
      reads += 1;
      throw new Error('read_outside_bytes');
    }
    return realReadFileSync(file, options);
  }) as typeof fs.readFileSync;
  try {
    run(() => reads);
  } finally {
    fs.readFileSync = realReadFileSync;
  }
}

function laterLstat(file: string, code: 'EPERM' | 'EACCES', run: () => void): void {
  const realLstatSync = fs.lstatSync;
  const realReadFileSync = fs.readFileSync;
  let seen = 0;
  let reads = 0;
  fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (samePath(String(target), file)) {
      seen += 1;
      if (seen > 1) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }
    }
    return realLstatSync(target, options);
  }) as typeof fs.lstatSync;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (typeof target !== 'number' && samePath(String(target), file)) reads += 1;
    return realReadFileSync(target, options);
  }) as typeof fs.readFileSync;
  try {
    assert.throws(run, isCode(code));
    assert.equal(seen > 1, true);
    assert.equal(reads, 0);
  } finally {
    fs.lstatSync = realLstatSync;
    fs.readFileSync = realReadFileSync;
  }
}

test('version reads check nlink before readFileSync and the write check stays', () => {
  const source = fs.readFileSync(new URL('../../mobile/versions.ts', import.meta.url), 'utf8');
  const atomic = between(source, 'export function atomicJson', 'function readOptional');
  const optional = between(source, 'function readOptional', 'function readLocal');
  const local = between(source, 'function readLocal', 'export function readCode');
  const code = between(source, 'export function readCode', 'export function codeTag');
  const versions = between(source, 'export function listVersions', 'export function recordVersion');
  const seed = between(source, 'export function seedVersions', 'export function versionSnapshot');
  const snapshot = between(source, 'export function versionSnapshot', 'export function bookmarkVersion');
  assert.equal(atomic.indexOf('stat.nlink > 1') < atomic.indexOf('renameSync'), true);
  assert.equal((atomic.match(/nlink > 1/g) ?? []).length, 1);
  assert.equal(atomic.includes('readFileSync'), false);
  assert.match(atomic, /\{flag:'wx'\}/);
  assert.equal(optional.indexOf('stat.nlink > 1') < optional.indexOf('fs.readFileSync'), true);
  assert.match(optional, /nodeCode\(error\)!=='ENOENT'/);
  assert.equal(local.includes('catch'), false);
  assert.equal(local.indexOf('fs.lstatSync') < local.indexOf('stat.nlink > 1'), true);
  assert.equal(local.indexOf('stat.nlink > 1') < local.indexOf('fs.readFileSync'), true);
  assert.match(code, /readOptional\(taskPath\(root,'\.loam\/mobile-code\.json'\)\)/);
  assert.match(code, /\{files:\{\}\}/);
  assert.equal(code.includes('readFileSync'), false);
  assert.equal(code.includes('existsSync'), false);
  assert.match(versions, /readOptional\(taskPath\(root,'\.loam\/mobile-versions\.json'\)\)/);
  assert.match(versions, /text===undefined\?\[\]:JSON\.parse\(text\)/);
  assert.equal(versions.includes('readFileSync'), false);
  assert.equal(versions.includes('existsSync'), false);
  assert.match(seed, /JSON\.parse\(readLocal\(taskPath\(root,'\.loam\/mobile\.json'\)\)\)/);
  assert.equal(seed.includes('readFileSync'), false);
  assert.match(snapshot, /JSON\.parse\(readLocal\(taskPath\(root,'\.loam\/mobile-history\/'\+version\.snapshot\+'\.json'\)\)\)/);
  assert.equal(snapshot.includes('readFileSync'), false);
  assert.equal((source.match(/nlink > 1/g) ?? []).length, 3);
  assert.equal(source.includes('EPERM'), false);
  assert.equal(source.includes('EACCES'), false);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(source.includes('gradle'), false);
  assert.equal(source.includes('.apk'), false);
  assert.equal(source.includes('child_process'), false);
});

test('a missing code or versions file still returns the empty fallback', () => {
  withPair('loam-49-mobile-versions-read-missing-', (root) => {
    assert.equal(fs.existsSync(codeFile(root)), false);
    assert.equal(fs.existsSync(versionsFile(root)), false);
    assert.deepEqual(readCode(root), { files: {} });
    assert.deepEqual(listVersions(root), []);
    assert.equal(fs.existsSync(codeFile(root)), false);
    assert.equal(fs.existsSync(versionsFile(root)), false);
    assertNoApk(root);
  });
});

test('a missing mobile.json or history snapshot still throws ENOENT', () => {
  withPair('loam-49-mobile-versions-read-enoent-', (root) => {
    assert.equal(fs.existsSync(mobileFile(root)), false);
    assert.throws(() => seedVersions(root, project), isCode('ENOENT'));
    assert.equal(fs.existsSync(mobileFile(root)), false);
    writeVersions(root);
    assert.equal(fs.existsSync(historyFile(root)), false);
    assert.throws(() => versionSnapshot(root, VERSION_ID), isCode('ENOENT'));
    assert.equal(fs.existsSync(historyFile(root)), false);
    assertNoApk(root);
  });
});

test('a regular nlink 1 file still reads', () => {
  withPair('loam-49-mobile-versions-read-nlink1-', (root) => {
    const code = codeFile(root);
    fs.mkdirSync(path.dirname(code), { recursive: true });
    fs.writeFileSync(code, CODE);
    assertPlain(code);
    assert.deepEqual(readCode(root), { files: { 'web/app.js': 'local-code' } });
    assertPlain(code);

    const versions = versionsFile(root);
    fs.writeFileSync(versions, VERSIONS);
    assertPlain(versions);
    assert.equal(listVersions(root)[0]?.id, VERSION_ID);
    assert.equal(listVersions(root)[0]?.snapshot, SNAPSHOT);
    assertPlain(versions);

    const history = historyFile(root);
    fs.mkdirSync(path.dirname(history), { recursive: true });
    fs.writeFileSync(history, HISTORY);
    assertPlain(history);
    const loaded = versionSnapshot(root, VERSION_ID);
    assert.equal(loaded.project.title, 'local-snapshot-title');
    assert.equal(loaded.code.files['web/app.js'], 'local-code');
    assertPlain(history);
    assertPlain(versions);

    fs.rmSync(versions);
    const mobile = mobileFile(root);
    fs.writeFileSync(mobile, MOBILE);
    assertPlain(mobile);
    seedVersions(root, project);
    const saved = listVersions(root);
    assert.equal(saved[0]?.label, 'إصدار سابق · local-past-title');
    assert.equal(saved[1]?.label, 'النسخة الحالية · local-current-title');
    assert.equal(fs.readFileSync(mobile, 'utf8'), MOBILE);
    assertPlain(mobile);
    assertNoApk(root);
  });
});

test('a hard-linked code file throws unsafe_path before read and the outside bytes stay', () => {
  withPair('loam-49-mobile-versions-read-code-', (root, outside) => {
    const file = codeFile(root);
    const previous = Buffer.from(OUTSIDE_CODE);
    const outsideFile = plant(outside, file, previous);
    assertLinked(file, outsideFile);
    const names = fs.readdirSync(path.dirname(file)).sort();
    guardReads(file, (reads) => {
      assert.throws(() => readCode(root), refused);
      assert.equal(reads(), 0);
    });
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assertLinked(file, outsideFile);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), names);
    assertNoApk(root);
  });
});

test('a hard-linked versions file throws unsafe_path before read and the outside bytes stay', () => {
  withPair('loam-49-mobile-versions-read-vers-', (root, outside) => {
    const file = versionsFile(root);
    const previous = Buffer.from(OUTSIDE_VERSIONS);
    const outsideFile = plant(outside, file, previous);
    assertLinked(file, outsideFile);
    const names = fs.readdirSync(path.dirname(file)).sort();
    guardReads(file, (reads) => {
      assert.throws(() => listVersions(root), refused);
      assert.equal(reads(), 0);
    });
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assertLinked(file, outsideFile);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), names);
    assertNoApk(root);
  });
});

test('a hard-linked mobile.json throws unsafe_path before seedVersions parses it', () => {
  withPair('loam-49-mobile-versions-read-mobile-', (root, outside) => {
    const file = mobileFile(root);
    const previous = Buffer.from(OUTSIDE_MOBILE);
    const outsideFile = plant(outside, file, previous);
    assertLinked(file, outsideFile);
    const names = fs.readdirSync(path.dirname(file)).sort();
    guardReads(file, (reads) => {
      assert.throws(() => seedVersions(root, project), refused);
      assert.equal(reads(), 0);
    });
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assertLinked(file, outsideFile);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), names);
    assert.equal(fs.existsSync(versionsFile(root)), false);
    assertNoApk(root);
  });
});

test('a hard-linked history snapshot throws unsafe_path before versionSnapshot parses it', () => {
  withPair('loam-49-mobile-versions-read-hist-', (root, outside) => {
    writeVersions(root);
    const file = historyFile(root);
    const previous = Buffer.from(OUTSIDE_HISTORY);
    const outsideFile = plant(outside, file, previous);
    assertLinked(file, outsideFile);
    assertPlain(versionsFile(root));
    const names = fs.readdirSync(path.dirname(file)).sort();
    guardReads(file, (reads) => {
      assert.throws(() => versionSnapshot(root, VERSION_ID), refused);
      assert.equal(reads(), 0);
    });
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assertLinked(file, outsideFile);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), names);
    assert.equal(fs.readFileSync(versionsFile(root), 'utf8'), VERSIONS);
    assertNoApk(root);
  });
});

test('lstat EPERM and EACCES are rethrown before each version read', () => {
  for (const code of ['EPERM', 'EACCES'] as const) {
    withPair(`loam-49-mobile-versions-read-${code.toLowerCase()}-code-`, (root) => {
      const file = codeFile(root);
      const previous = Buffer.from(CODE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, previous);
      assertPlain(file);
      laterLstat(file, code, () => readCode(root));
      assertPlain(file);
      assert.deepEqual(fs.readFileSync(file), previous);
    });
    withPair(`loam-49-mobile-versions-read-${code.toLowerCase()}-vers-`, (root) => {
      const file = versionsFile(root);
      const previous = Buffer.from(VERSIONS);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, previous);
      assertPlain(file);
      laterLstat(file, code, () => listVersions(root));
      assertPlain(file);
      assert.deepEqual(fs.readFileSync(file), previous);
    });
    withPair(`loam-49-mobile-versions-read-${code.toLowerCase()}-mobile-`, (root) => {
      const file = mobileFile(root);
      const previous = Buffer.from(MOBILE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, previous);
      assertPlain(file);
      laterLstat(file, code, () => seedVersions(root, project));
      assertPlain(file);
      assert.deepEqual(fs.readFileSync(file), previous);
      assert.equal(fs.existsSync(versionsFile(root)), false);
    });
    withPair(`loam-49-mobile-versions-read-${code.toLowerCase()}-hist-`, (root) => {
      writeVersions(root);
      const file = historyFile(root);
      const previous = Buffer.from(HISTORY);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, previous);
      assertPlain(file);
      laterLstat(file, code, () => versionSnapshot(root, VERSION_ID));
      assertPlain(file);
      assert.deepEqual(fs.readFileSync(file), previous);
      assert.equal(fs.readFileSync(versionsFile(root), 'utf8'), VERSIONS);
    });
  }
});
