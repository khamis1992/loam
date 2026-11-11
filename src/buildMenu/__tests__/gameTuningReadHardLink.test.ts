/**
 * readLocalTuning refuses an existing tuning.json whose nlink is greater than 1
 * before readFileSync, and does not return the outside text. A regular nlink 1
 * file still loads. Hard links use fs.linkSync. EPERM and EACCES are rethrown.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/gameTuningReadHardLink.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalTuning } from '../games/tuning.js';
import { STEP_SOURCE } from '../games/page.js';

const LOCAL = '{"speed":200,"gravity":700}';
const OUTSIDE = '{"speed":180,"gravity":400}';

function isUnsafe(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function withGame(run: (gameDir: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-tuning-read-'));
  const gameDir = path.join(root, 'game');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(gameDir);
  fs.mkdirSync(outside);
  try {
    run(gameDir, outside);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('the read checks nlink before readFileSync and keeps the tuning bounds', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../games/tuning.ts', import.meta.url)), 'utf8');
  const start = source.indexOf('export function readLocalTuning');
  const end = source.indexOf('export function writeLocalTuning');
  const body = source.slice(start, end);
  const guardAt = body.indexOf('stat.nlink > 1');
  const readAt = body.indexOf('fs.readFileSync');
  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.ok(guardAt >= 0);
  assert.ok(readAt > guardAt);
  assert.match(body, /code === 'EPERM' \|\| code === 'EACCES'/);
  assert.equal(body.includes('symlinkSync'), false);
  assert.equal(body.includes('junction'), false);
  assert.match(source, /boundedNumber\(record\.speed, 50, 500\)/);
  assert.match(source, /boundedNumber\(record\.gravity, 100, 1500\)/);
  assert.match(STEP_SOURCE, /const speed = Math\.min\(500, Math\.max\(50, Number\(tuning\.speed\)\)\);/);
  assert.match(STEP_SOURCE, /const gravity = Math\.min\(1500, Math\.max\(100, Number\(tuning\.gravity\)\)\);/);
  assert.match(STEP_SOURCE, /vy = input\.jump \? -8 : 0;/);
  assert.match(STEP_SOURCE, /function restart\(\) \{ return \{ x: 70, y: 500, vy: 0, status: 'play' \}; \}/);
});

test('readLocalTuning refuses a hard link and does not return the outside text', () => {
  withGame((gameDir, outside) => {
    const outsideFile = path.join(outside, 'tuning.json');
    const file = path.join(gameDir, 'tuning.json');
    fs.writeFileSync(outsideFile, OUTSIDE);
    fs.linkSync(outsideFile, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    assert.throws(() => readLocalTuning(gameDir), isUnsafe);
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), OUTSIDE);
    assert.equal(fs.readFileSync(file, 'utf8'), OUTSIDE);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(outsideFile).nlink > 1, true);
  });
});

test('a regular nlink 1 tuning file still loads', () => {
  withGame((gameDir) => {
    const file = path.join(gameDir, 'tuning.json');
    fs.writeFileSync(file, LOCAL);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.deepEqual(readLocalTuning(gameDir), { speed: 200, gravity: 700 });
    assert.equal(fs.readFileSync(file, 'utf8'), LOCAL);
    assert.equal(fs.lstatSync(file).nlink, 1);
  });
});

test('readLocalTuning lets EPERM and EACCES from lstat escape', () => {
  for (const code of ['EPERM', 'EACCES'] as const) {
    withGame((gameDir) => {
      const file = path.join(gameDir, 'tuning.json');
      fs.writeFileSync(file, LOCAL);
      assert.equal(fs.lstatSync(file).nlink, 1);
      const realLstatSync = fs.lstatSync;
      const patched = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
        if (path.resolve(String(target)) !== path.resolve(file)) return realLstatSync(target, options);
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }) as typeof fs.lstatSync;
      Object.defineProperty(fs, 'lstatSync', { value: patched });
      try {
        assert.throws(() => readLocalTuning(gameDir), isCode(code));
        assert.equal(realLstatSync(file).nlink, 1);
        assert.equal(fs.readFileSync(file, 'utf8'), LOCAL);
      } finally {
        Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
      }
    });
  }
});
