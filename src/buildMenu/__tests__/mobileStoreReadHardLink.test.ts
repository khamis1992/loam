/**
 * readMobile and mobile history read .loam/mobile.json. An existing file whose
 * nlink is greater than 1 throws unsafe_path before readFileSync. Outside
 * bytes stay unparsed. A missing file still returns null or empty history. A
 * regular nlink 1 file still reads. EPERM and EACCES from the link check and
 * from the read are rethrown. refuseSharedLink on the write stays. Hard links
 * come from fs.linkSync. This file does not create a symlink or junction,
 * write an apk, or run Gradle.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/mobileStoreReadHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mobileHistory, readMobile, saveMobile } from '../../mobile/store.js';

const project = {
  version: 1 as const,
  title: 'دفتر محلي',
  accent: '#177E89',
  direction: 'rtl' as const,
  screens: [{
    id: 'home',
    title: 'دفتر',
    kind: 'primary' as const,
    blocks: [{ id: 'note', type: 'input' as const, text: 'ملاحظتي', placeholder: 'اكتب ملاحظة' }],
  }],
};

const OUTSIDE = Buffer.from('outside-mobile-bytes');

function storeSource(): string {
  return fs.readFileSync(new URL('../../mobile/store.ts', import.meta.url), 'utf8');
}

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

function isUnsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isInvalid(error: unknown): boolean {
  return error instanceof Error && error.message === 'Saved project is invalid';
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

function withPair(prefix: string, run: (root: string, outside: string) => void): void {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.join(parent, 'project');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  try {
    run(root, outside);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function projectFile(root: string): string {
  return path.join(root, '.loam', 'mobile.json');
}

function linkedStore(root: string, outside: string): { file: string; outsideFile: string } {
  fs.mkdirSync(path.join(root, '.loam'));
  const file = projectFile(root);
  const outsideFile = path.join(outside, 'mobile.json');
  fs.writeFileSync(outsideFile, OUTSIDE);
  fs.linkSync(outsideFile, file);
  return { file, outsideFile };
}

function assertShared(file: string, outsideFile: string): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
  assert.deepEqual(fs.readFileSync(file), OUTSIDE);
  assert.deepEqual(fs.readFileSync(outsideFile), OUTSIDE);
}

function expectUnread(file: string, run: () => void): void {
  const realReadFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (typeof target !== 'number' && samePath(String(target), file)) reads += 1;
    return realReadFileSync(target, options);
  }) as typeof fs.readFileSync;
  try {
    assert.throws(run, isUnsafePath);
    assert.equal(reads, 0);
  } finally {
    fs.readFileSync = realReadFileSync;
  }
}

function expectLstatCode(file: string, code: 'EPERM' | 'EACCES', run: () => void): void {
  const realLstatSync = fs.lstatSync;
  const realReadFileSync = fs.readFileSync;
  let reads = 0;
  Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (samePath(String(target), file) && new Error().stack?.includes('refuseSharedLink')) {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = code;
      throw error;
    }
    return realLstatSync(target, options);
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

function expectReadCode(file: string, code: 'EPERM' | 'EACCES', run: () => void): void {
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (typeof target !== 'number' && samePath(String(target), file)) {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = code;
      throw error;
    }
    return realReadFileSync(target, options);
  }) as typeof fs.readFileSync;
  try {
    assert.throws(run, isCode(code));
  } finally {
    fs.readFileSync = realReadFileSync;
  }
}

test('both reads refuse nlink before readFileSync and the write check stays', () => {
  const source = storeSource();
  const reader = sliceBetween(source, 'export function readMobile', 'type History');
  const history = sliceBetween(source, 'function history(', 'export function mobileHistory');
  const guard = sliceBetween(source, 'function refuseSharedLink', 'function write(');
  const writer = sliceBetween(source, 'function write(', 'export function saveMobile');
  assert.ok(reader.indexOf('refuseSharedLink(file)') < reader.indexOf('fs.readFileSync'));
  assert.ok(reader.indexOf("code !== 'ENOENT'") < reader.indexOf("fail('Saved project is invalid')"));
  assert.equal(history.includes('catch'), false);
  assert.ok(history.indexOf('refuseSharedLink(file)') < history.indexOf('fs.readFileSync'));
  assert.match(guard, /stat\.nlink > 1/);
  assert.match(guard, /!== 'ENOENT'/);
  assert.match(guard, /throw new MobileError\('unsafe_path'\)/);
  assert.ok(writer.indexOf('refuseSharedLink(file)') < writer.indexOf('fs.renameSync(temp, file)'));
  assert.equal((source.match(/refuseSharedLink\(file\)/g) ?? []).length, 3);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.toLowerCase().includes('junction'), false);
  assert.equal(/gradle|\.apk|assembleRelease|child_process/i.test(source), false);
});

test('a missing file returns null and empty history, and invalid text is still rejected', () => {
  withPair('loam-49-mobile-read-missing-', (root) => {
    const file = projectFile(root);
    assert.equal(fs.existsSync(file), false);
    assert.equal(readMobile(root), null);
    assert.deepEqual(mobileHistory(root), { canUndo: false, canRedo: false });
    fs.mkdirSync(path.join(root, '.loam'));
    fs.writeFileSync(file, '{');
    assert.equal(fs.lstatSync(file).nlink, 1);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.throws(() => readMobile(root), isInvalid);
    assert.equal(fs.readFileSync(file, 'utf8'), '{');
  });
});

test('a regular nlink 1 file still reads the project and its history', () => {
  withPair('loam-49-mobile-read-nlink1-', (root) => {
    const file = projectFile(root);
    const created = saveMobile(root, project, 0);
    assert.equal(created.revision, 1);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).isFile(), true);
    assert.equal(fs.lstatSync(file).nlink, 1);
    assert.equal(readMobile(root)?.title, 'دفتر محلي');
    assert.equal(readMobile(root)?.revision, 1);
    assert.deepEqual(mobileHistory(root), { canUndo: false, canRedo: false });

    const updated = saveMobile(root, { ...project, title: 'دفتر محدّث' }, created.revision);
    assert.equal(updated.revision, 2);
    assert.equal(fs.lstatSync(file).nlink, 1);
    assert.equal(readMobile(root)?.title, 'دفتر محدّث');
    assert.equal(readMobile(root)?.revision, 2);
    assert.deepEqual(mobileHistory(root), { canUndo: true, canRedo: false });
    assert.equal(fs.lstatSync(file).nlink, 1);
  });
});

test('readMobile refuses nlink before read and the outside bytes stay', () => {
  withPair('loam-49-mobile-read-project-', (root, outside) => {
    const { file, outsideFile } = linkedStore(root, outside);
    assertShared(file, outsideFile);
    expectUnread(file, () => { readMobile(root); });
    assertShared(file, outsideFile);
  });
});

test('mobile history refuses nlink before read and the outside bytes stay', () => {
  withPair('loam-49-mobile-read-history-', (root, outside) => {
    const { file, outsideFile } = linkedStore(root, outside);
    assertShared(file, outsideFile);
    expectUnread(file, () => { mobileHistory(root); });
    assertShared(file, outsideFile);
  });
});

test('lstat EPERM and EACCES escape before both reads', () => {
  for (const code of ['EPERM', 'EACCES'] as const) {
    withPair(`loam-49-mobile-read-lstat-${code.toLowerCase()}-`, (root) => {
      const saved = saveMobile(root, project, 0);
      const file = projectFile(root);
      const previous = fs.readFileSync(file);
      assert.equal(fs.lstatSync(file).nlink, 1);
      expectLstatCode(file, code, () => { readMobile(root); });
      expectLstatCode(file, code, () => { mobileHistory(root); });
      assert.equal(fs.lstatSync(file).nlink, 1);
      assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
      assert.deepEqual(fs.readFileSync(file), previous);
      assert.equal(readMobile(root)?.revision, saved.revision);
    });
  }
});

test('read EPERM and EACCES escape from both reads', () => {
  for (const code of ['EPERM', 'EACCES'] as const) {
    withPair(`loam-49-mobile-read-bytes-${code.toLowerCase()}-`, (root) => {
      const saved = saveMobile(root, project, 0);
      const file = projectFile(root);
      const previous = fs.readFileSync(file);
      assert.equal(fs.lstatSync(file).nlink, 1);
      expectReadCode(file, code, () => { readMobile(root); });
      expectReadCode(file, code, () => { mobileHistory(root); });
      assert.equal(fs.lstatSync(file).nlink, 1);
      assert.deepEqual(fs.readFileSync(file), previous);
      assert.equal(readMobile(root)?.revision, saved.revision);
      assert.deepEqual(mobileHistory(root), { canUndo: false, canRedo: false });
    });
  }
});
