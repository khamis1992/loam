import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedTuning, readLocalTuning, writeLocalTuning } from '../games/tuning.js';
import { STEP_SOURCE } from '../games/page.js';

const VALID = '{"speed":200,"gravity":700}';
const NEXT = '{"speed":240,"gravity":900}';
const OUTSIDE = 'outside-secret-bytes';

function isUnsafe(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function withGame(run: (gameDir: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-46-tuning-'));
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

test('speed stays 50..500, gravity stays 100..1500, and restart stays x 70 y 500', () => {
  assert.deepEqual(checkedTuning({ speed: 50, gravity: 100 }), { speed: 50, gravity: 100 });
  assert.deepEqual(checkedTuning({ speed: 500, gravity: 1500 }), { speed: 500, gravity: 1500 });
  const source = fs.readFileSync(fileURLToPath(new URL('../games/tuning.ts', import.meta.url)), 'utf8');
  assert.match(source, /boundedNumber\(record\.speed, 50, 500\)/);
  assert.match(source, /boundedNumber\(record\.gravity, 100, 1500\)/);
  assert.match(source, /stat\.nlink > 1/);
  assert.match(STEP_SOURCE, /const speed = Math\.min\(500, Math\.max\(50, Number\(tuning\.speed\)\)\);/);
  assert.match(STEP_SOURCE, /const gravity = Math\.min\(1500, Math\.max\(100, Number\(tuning\.gravity\)\)\);/);
  assert.match(STEP_SOURCE, /vy = input\.jump \? -8 : 0;/);
  assert.match(STEP_SOURCE, /function restart\(\) \{ return \{ x: 70, y: 500, vy: 0, status: 'play' \}; \}/);
});

test('writeLocalTuning refuses a hard link and leaves the outside bytes', () => {
  withGame((gameDir, outside) => {
    const outsideFile = path.join(outside, 'tuning.json');
    const file = path.join(gameDir, 'tuning.json');
    const previous = Buffer.from(OUTSIDE);
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.throws(() => writeLocalTuning(gameDir, NEXT), isUnsafe);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(outsideFile).nlink > 1, true);
  });
});

test('a new tuning file still writes', () => {
  withGame((gameDir) => {
    const file = path.join(gameDir, 'tuning.json');
    assert.equal(fs.existsSync(file), false);
    writeLocalTuning(gameDir, VALID);
    const created = fs.lstatSync(file);
    assert.equal(created.isSymbolicLink(), false);
    assert.equal(created.isFile(), true);
    assert.equal(created.nlink, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), VALID);
    assert.deepEqual(readLocalTuning(gameDir), { speed: 200, gravity: 700 });
    writeLocalTuning(gameDir, NEXT);
    const replaced = fs.lstatSync(file);
    assert.equal(replaced.isSymbolicLink(), false);
    assert.equal(replaced.isFile(), true);
    assert.equal(replaced.nlink, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), NEXT);
    assert.deepEqual(readLocalTuning(gameDir), { speed: 240, gravity: 900 });
  });
});

test('writeLocalTuning lets EPERM from lstat escape', () => {
  withGame((gameDir) => {
    const file = path.join(gameDir, 'tuning.json');
    fs.writeFileSync(file, VALID);
    const realLstatSync = fs.lstatSync;
    const patched = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) !== path.resolve(file)) return realLstatSync(target, options);
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }) as typeof fs.lstatSync;
    fs.lstatSync = patched;
    try {
      assert.throws(() => writeLocalTuning(gameDir, NEXT), isEperm);
      assert.equal(realLstatSync(file).nlink, 1);
      assert.equal(fs.readFileSync(file, 'utf8'), VALID);
    } finally {
      fs.lstatSync = realLstatSync;
    }
  });
});
