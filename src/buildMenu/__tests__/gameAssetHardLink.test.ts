/**
 * writeListedGameAssets refuses an existing assets/manifest.json whose nlink
 * is greater than 1 before writeFileSync, and leaves the outside bytes unchanged.
 * A new manifest still writes. Hard links use fs.linkSync. EPERM is not swallowed.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/gameAssetHardLink.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeListedGameAssets } from '../games/assets.js';

function isUnsafe(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function withFixture(run: (game: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-46-asset-'));
  const game = path.join(root, 'game');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(game);
  fs.mkdirSync(outside);
  try {
    run(game, outside);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('the manifest writer checks nlink before writeFileSync', () => {
  const source = fs.readFileSync(new URL('../games/assets.ts', import.meta.url), 'utf8');
  const guardAt = source.indexOf('stat.nlink > 1');
  const writeAt = source.lastIndexOf('fs.writeFileSync(target, body)');
  assert.ok(guardAt >= 0);
  assert.ok(writeAt > guardAt);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(source.includes("code === 'EPERM'"), true);
});

test('an existing manifest with nlink greater than 1 throws unsafe_path before write', () => {
  withFixture((game, outside) => {
    const outsideFile = path.join(outside, 'manifest.json');
    const target = path.join(game, 'assets', 'manifest.json');
    const previous = Buffer.from('outside-secret-bytes');
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, target);
    const stat = fs.lstatSync(target);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    assert.throws(() => writeListedGameAssets(game, []), isUnsafe);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(target), previous);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(target).nlink > 1, true);
    assert.equal(fs.lstatSync(outsideFile).nlink > 1, true);
  });
});

test('a new manifest still writes', () => {
  withFixture((game) => {
    const target = path.join(game, 'assets', 'manifest.json');
    assert.equal(fs.existsSync(target), false);
    writeListedGameAssets(game, []);
    const stat = fs.lstatSync(target);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { assets: [] });

    const previous = Buffer.from('{"assets":["keep"]}\n');
    fs.writeFileSync(target, previous);
    assert.equal(fs.lstatSync(target).nlink, 1);
    writeListedGameAssets(game, []);
    const replaced = fs.lstatSync(target);
    assert.equal(replaced.isSymbolicLink(), false);
    assert.equal(replaced.isFile(), true);
    assert.equal(replaced.nlink, 1);
    assert.equal(fs.readFileSync(target).equals(previous), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { assets: [] });
  });
});

test('lstat EPERM is not swallowed before write', () => {
  withFixture((game) => {
    const target = path.join(game, 'assets', 'manifest.json');
    const previous = Buffer.from('regular-manifest');
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, previous);
    assert.equal(fs.lstatSync(target).nlink, 1);
    const realLstatSync = fs.lstatSync;
    const resolved = path.resolve(target);
    fs.lstatSync = ((file: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(file)) === resolved) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstatSync(file, options);
    }) as typeof fs.lstatSync;
    try {
      assert.throws(() => writeListedGameAssets(game, []), isEperm);
    } finally {
      fs.lstatSync = realLstatSync;
    }
    assert.equal(realLstatSync(target).nlink, 1);
    assert.equal(realLstatSync(target).isSymbolicLink(), false);
    assert.equal(realLstatSync(target).isFile(), true);
    assert.deepEqual(fs.readFileSync(target), previous);
  });
});
