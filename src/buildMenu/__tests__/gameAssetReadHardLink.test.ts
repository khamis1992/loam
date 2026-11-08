/**
 * assertListedAssetBytes refuses an asset whose nlink is greater than 1
 * before readFileSync, and does not return the outside bytes. A regular
 * nlink 1 asset still hashes. Hard links use fs.linkSync. EPERM and EACCES
 * are rethrown. Goal positions stay 420 and 600.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/gameAssetReadHardLink.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gameScene } from '../games/scene.js';
import { writeListedGameAssets } from '../games/assets.js';

const LOCAL = Buffer.from('local-geometry');
const OUTSIDE = Buffer.from('outside-secret-bytes');

function isUnsafe(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function listed(bytes: Buffer) {
  return {
    path: 'assets/hero.png',
    source: 'local-geometry',
    license: 'local',
    evidenceSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function withGame(run: (game: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-asset-read-'));
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

function placeAsset(game: string, bytes: Buffer): string {
  const file = path.join(game, 'assets', 'hero.png');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

test('the asset read checks nlink before readFileSync and keeps goals 420 and 600', () => {
  assert.equal(gameScene('هدف قريب').goalX, 420);
  assert.equal(gameScene('هدف بعيد').goalX, 600);
  const source = fs.readFileSync(new URL('../games/assets.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function assertListedAssetBytes');
  const end = source.indexOf('function writeManifest');
  const body = source.slice(start, end);
  const guardAt = body.indexOf('stat.nlink > 1');
  const readAt = body.indexOf('bytes = fs.readFileSync(target)');
  const rethrowAt = body.indexOf("code === 'EPERM' || code === 'EACCES'", readAt);
  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.ok(guardAt >= 0);
  assert.ok(readAt > guardAt);
  assert.ok(rethrowAt > readAt);
  assert.equal(body.includes('symlinkSync'), false);
  assert.equal(body.includes('junction'), false);
});

test('a hard-linked asset throws unsafe_path before read and the outside bytes stay', () => {
  withGame((game, outside) => {
    const outsideFile = path.join(outside, 'hero.png');
    fs.writeFileSync(outsideFile, OUTSIDE);
    const file = path.join(game, 'assets', 'hero.png');
    fs.mkdirSync(path.dirname(file));
    fs.linkSync(outsideFile, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    const resolved = path.resolve(file);
    const realReadFileSync = fs.readFileSync;
    let readAsset = false;
    fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
      if (typeof target !== 'number' && path.resolve(String(target)) === resolved) readAsset = true;
      return realReadFileSync(target, options);
    }) as typeof fs.readFileSync;
    try {
      assert.throws(() => writeListedGameAssets(game, [listed(OUTSIDE)]), isUnsafe);
    } finally {
      fs.readFileSync = realReadFileSync;
    }
    assert.equal(readAsset, false);
    assert.equal(fs.existsSync(path.join(game, 'assets', 'manifest.json')), false);
    assert.deepEqual(fs.readFileSync(outsideFile), OUTSIDE);
    assert.deepEqual(fs.readFileSync(file), OUTSIDE);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(outsideFile).nlink > 1, true);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  });
});

test('a regular nlink 1 asset still hashes', () => {
  withGame((game) => {
    const file = placeAsset(game, LOCAL);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    const entry = listed(LOCAL);
    writeListedGameAssets(game, [entry]);
    const manifestPath = path.join(game, 'assets', 'manifest.json');
    const written = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { assets: { evidenceSha256: string }[] };
    assert.equal(written.assets[0]?.evidenceSha256, entry.evidenceSha256);
    assert.equal(written.assets[0]?.evidenceSha256, createHash('sha256').update(LOCAL).digest('hex'));
    assert.deepEqual(fs.readFileSync(file), LOCAL);
    assert.equal(fs.lstatSync(file).nlink, 1);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  });
});

test('listed asset reads let EPERM and EACCES escape', () => {
  for (const code of ['EPERM', 'EACCES'] as const) {
    withGame((game) => {
      const file = placeAsset(game, LOCAL);
      assert.equal(fs.lstatSync(file).nlink, 1);
      const resolved = path.resolve(file);
      const realLstatSync = fs.lstatSync;
      fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
        if (path.resolve(String(target)) !== resolved) return realLstatSync(target, options);
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }) as typeof fs.lstatSync;
      try {
        assert.throws(() => writeListedGameAssets(game, [listed(LOCAL)]), isCode(code));
      } finally {
        fs.lstatSync = realLstatSync;
      }
      assert.equal(realLstatSync(file).nlink, 1);
      assert.deepEqual(fs.readFileSync(file), LOCAL);
      assert.equal(fs.existsSync(path.join(game, 'assets', 'manifest.json')), false);
    });

    withGame((game) => {
      const file = placeAsset(game, LOCAL);
      assert.equal(fs.lstatSync(file).nlink, 1);
      const resolved = path.resolve(file);
      const realLstatSync = fs.lstatSync;
      let seen = 0;
      fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
        if (path.resolve(String(target)) !== resolved) return realLstatSync(target, options);
        seen += 1;
        if (seen === 1) return realLstatSync(target, options);
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }) as typeof fs.lstatSync;
      try {
        assert.throws(() => writeListedGameAssets(game, [listed(LOCAL)]), isCode(code));
        assert.equal(seen, 2);
      } finally {
        fs.lstatSync = realLstatSync;
      }
      assert.equal(realLstatSync(file).nlink, 1);
      assert.deepEqual(fs.readFileSync(file), LOCAL);
      assert.equal(fs.existsSync(path.join(game, 'assets', 'manifest.json')), false);
    });

    withGame((game) => {
      const file = placeAsset(game, LOCAL);
      assert.equal(fs.lstatSync(file).nlink, 1);
      const resolved = path.resolve(file);
      const realReadFileSync = fs.readFileSync;
      fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
        if (typeof target !== 'number' && path.resolve(String(target)) === resolved) {
          const error = new Error('operation not permitted') as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
        return realReadFileSync(target, options);
      }) as typeof fs.readFileSync;
      try {
        assert.throws(() => writeListedGameAssets(game, [listed(LOCAL)]), isCode(code));
      } finally {
        fs.readFileSync = realReadFileSync;
      }
      assert.equal(fs.lstatSync(file).nlink, 1);
      assert.deepEqual(fs.readFileSync(file), LOCAL);
      assert.equal(fs.existsSync(path.join(game, 'assets', 'manifest.json')), false);
    });
  }
});
