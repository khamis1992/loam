import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gameScene, readGameBrief } from '../games/scene.js';

const BRIEF = 'هدف محلي mailto:user@example.test';
const OUTSIDE = 'outside-secret-bytes';

function isUnsafe(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function withWorkspace(run: (workspace: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-read-'));
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

test('goal positions stay 420 and 600 and a regular brief keeps mailto', () => {
  assert.equal(gameScene('هدف قريب').goalX, 420);
  assert.equal(gameScene('هدف بعيد').goalX, 600);
  assert.equal(gameScene(BRIEF).goalX, 600);
  withWorkspace((workspace) => {
    const file = path.join(workspace, 'app', 'brief.txt');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, BRIEF);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.equal(readGameBrief(workspace), BRIEF);
  });
});

test('readGameBrief refuses a hard link and does not return outside bytes', () => {
  withWorkspace((workspace, outside) => {
    const outsideFile = path.join(outside, 'brief.txt');
    const file = path.join(workspace, 'app', 'brief.txt');
    fs.writeFileSync(outsideFile, OUTSIDE);
    fs.mkdirSync(path.dirname(file));
    fs.linkSync(outsideFile, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.throws(() => readGameBrief(workspace), isUnsafe);
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), OUTSIDE);
    assert.equal(fs.readFileSync(file, 'utf8'), OUTSIDE);
  });
});

test('readGameBrief lets EPERM from lstat escape', () => {
  withWorkspace((workspace) => {
    const file = path.join(workspace, 'app', 'brief.txt');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, BRIEF);
    const realLstatSync = fs.lstatSync;
    const patched = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) !== path.resolve(file)) return realLstatSync(target, options);
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }) as typeof fs.lstatSync;
    Object.defineProperty(fs, 'lstatSync', { value: patched });
    try {
      assert.throws(() => readGameBrief(workspace), isEperm);
      assert.equal(realLstatSync(file).nlink, 1);
      assert.equal(fs.readFileSync(file, 'utf8'), BRIEF);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    }
  });
});
