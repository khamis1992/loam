/**
 * atomicJson refuses an existing destination whose nlink is greater than 1
 * before renameSync. Outside bytes stay. A new file still saves. Hard links
 * use fs.linkSync. This file does not create a symlink or junction, write an
 * apk, or run Gradle. EPERM is not swallowed.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/mobileVersionsHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { atomicJson } from '../../mobile/versions.js';

const versionsName = '.loam/mobile-versions.json';

function versionsFile(root: string): string {
  return path.join(root, '.loam', 'mobile-versions.json');
}

function refused(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
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

test('versions writes check nlink before rename and do not catch EPERM', () => {
  const source = fs.readFileSync(new URL('../../mobile/versions.ts', import.meta.url), 'utf8');
  const checkAt = source.indexOf('stat.nlink > 1');
  const renameAt = source.indexOf('renameSync');
  assert.equal(checkAt >= 0, true);
  assert.equal(renameAt > checkAt, true);
  assert.equal(source.includes('EPERM'), false);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(source.includes('gradle'), false);
  assert.equal(source.includes('.apk'), false);
  assert.equal(source.includes('child_process'), false);
  assert.equal(source.includes("'ENOENT'"), true);
});

test('a new file and a regular nlink 1 file still save', () => {
  withPair('loam-47-mobile-versions-new-', (root) => {
    const file = versionsFile(root);
    assert.equal(fs.existsSync(file), false);
    atomicJson(root, versionsName, { saved: 1 });
    const created = fs.lstatSync(file);
    assert.equal(created.isSymbolicLink(), false);
    assert.equal(created.isFile(), true);
    assert.equal(created.nlink, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ saved: 1 }));

    atomicJson(root, versionsName, { saved: 2 });
    const replaced = fs.lstatSync(file);
    assert.equal(replaced.isSymbolicLink(), false);
    assert.equal(replaced.isFile(), true);
    assert.equal(replaced.nlink, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ saved: 2 }));
  });
});

test('an existing file with nlink greater than 1 is refused before rename', () => {
  withPair('loam-47-mobile-versions-hard-', (root, outside) => {
    const file = versionsFile(root);
    const outsideFile = path.join(outside, 'outside-bytes.json');
    const previous = Buffer.from('outside-mobile-version-bytes\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    const names = fs.readdirSync(path.dirname(file)).sort();
    assert.deepEqual(names, ['mobile-versions.json']);

    assert.throws(() => atomicJson(root, versionsName, { saved: 2 }), refused);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    const after = fs.lstatSync(file);
    assert.equal(after.isSymbolicLink(), false);
    assert.equal(after.isFile(), true);
    assert.equal(after.nlink > 1, true);
    assert.equal(after.ino, fs.lstatSync(outsideFile).ino);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), names);
  });
});

test('lstat EPERM is not swallowed and the outside bytes stay', () => {
  withPair('loam-47-mobile-versions-eperm-', (root) => {
    const file = versionsFile(root);
    const previous = Buffer.from('regular-mobile-version-bytes\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, previous);
    assert.equal(fs.lstatSync(file).nlink, 1);
    const realLstatSync = fs.lstatSync;
    const resolved = path.resolve(file);
    let seen = 0;
    Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) === resolved) {
        seen += 1;
        if (seen > 1) {
          const error = new Error('operation not permitted') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync });
    try {
      assert.throws(() => atomicJson(root, versionsName, { saved: 2 }), isEperm);
      assert.equal(seen > 1, true);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    }
    assert.equal(realLstatSync(file).nlink, 1);
    assert.equal(realLstatSync(file).isSymbolicLink(), false);
    assert.equal(realLstatSync(file).isFile(), true);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['mobile-versions.json']);
  });
});
