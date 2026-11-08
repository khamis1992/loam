/**
 * saveMobile writes .loam/mobile.json through a temp file and renameSync.
 * An existing file whose nlink is greater than 1 throws unsafe_path before
 * that rename. Outside bytes stay. A new file still saves. This file does not
 * write an apk or run Gradle. Hard links come from fs.linkSync. It does not
 * create a symlink or junction, and it does not swallow EPERM.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/mobileStoreHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readMobile, saveMobile } from '../../mobile/store.js';

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

function storeSource(): string {
  return fs.readFileSync(new URL('../../mobile/store.ts', import.meta.url), 'utf8');
}

function isUnsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
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

function tempNames(root: string): string[] {
  const dir = path.join(root, '.loam');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.startsWith('mobile-') && name.endsWith('.tmp'));
}

test('the project writer checks nlink before rename and does not build an apk', () => {
  const source = storeSource();
  const writeAt = source.indexOf('function write(');
  const writeBody = source.slice(writeAt, source.indexOf('export function saveMobile'));
  const guard = source.slice(source.indexOf('function refuseSharedLink'), writeAt);
  assert.match(guard, /stat\.nlink > 1/);
  assert.match(guard, /!== 'ENOENT'/);
  assert.match(writeBody, /refuseSharedLink\(file\)/);
  assert.ok(writeBody.indexOf('refuseSharedLink(file)') < writeBody.indexOf('fs.renameSync(temp, file)'));
  assert.equal(source.includes('EPERM'), false);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.toLowerCase().includes('junction'), false);
  assert.equal(/gradle|\.apk|assembleRelease|child_process/i.test(source), false);
});

test('a new project still saves and a regular nlink 1 file still updates', () => {
  withPair('loam-47-mobile-new-', (root) => {
    const file = projectFile(root);
    assert.equal(fs.existsSync(file), false);
    const created = saveMobile(root, project, 0);
    assert.equal(created.revision, 1);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.match(fs.readFileSync(file, 'utf8'), /دفتر محلي/);
    assert.deepEqual(tempNames(root), []);

    const updated = saveMobile(root, { ...project, title: 'دفتر محدّث' }, created.revision);
    assert.equal(updated.revision, 2);
    const replaced = fs.lstatSync(file);
    assert.equal(replaced.isSymbolicLink(), false);
    assert.equal(replaced.isFile(), true);
    assert.equal(replaced.nlink, 1);
    assert.match(fs.readFileSync(file, 'utf8'), /دفتر محدّث/);
    assert.equal(readMobile(root)?.title, 'دفتر محدّث');
    assert.deepEqual(tempNames(root), []);
  });
});

test('an existing project with nlink greater than 1 is refused before rename and the outside bytes stay', () => {
  withPair('loam-47-mobile-nlink-', (root, outside) => {
    const saved = saveMobile(root, project, 0);
    const file = projectFile(root);
    const previous = fs.readFileSync(file);
    const outsideFile = path.join(outside, 'mobile.json');
    fs.writeFileSync(outsideFile, previous);
    fs.unlinkSync(file);
    fs.linkSync(outsideFile, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);

    const realRename = fs.renameSync;
    let renamedProject = false;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (samePath(String(to), file)) renamedProject = true;
      return realRename(from, to);
    }) as typeof fs.renameSync;
    try {
      assert.throws(() => saveMobile(root, { ...project, title: 'عنوان آخر' }, saved.revision), isUnsafePath);
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(renamedProject, false);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);
    assert.deepEqual(tempNames(root), []);
  });
});

test('lstat EPERM is not swallowed and the project bytes stay', () => {
  withPair('loam-47-mobile-eperm-', (root) => {
    const saved = saveMobile(root, project, 0);
    const file = projectFile(root);
    const previous = fs.readFileSync(file);
    assert.equal(fs.lstatSync(file).nlink, 1);
    const realLstatSync = fs.lstatSync;
    fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (samePath(String(target), file) && new Error().stack?.includes('refuseSharedLink')) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync;
    try {
      assert.throws(() => saveMobile(root, { ...project, title: 'عنوان آخر' }, saved.revision), isEperm);
    } finally {
      fs.lstatSync = realLstatSync;
    }
    assert.equal(realLstatSync(file).nlink, 1);
    assert.equal(realLstatSync(file).isSymbolicLink(), false);
    assert.equal(realLstatSync(file).isFile(), true);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(tempNames(root), []);
  });
});
