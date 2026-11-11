import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const notes = require('../../templates/electron-app/electron/notes.cjs') as {
  loadNotes: (root: string) => string;
  saveNotes: (root: string, text: string) => string;
};

const EXACT_BYTES = 65536;
const OVER_BYTES = 65537;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function withTemp(prefix: string, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function isNotesTooLarge(error: unknown): boolean {
  return errorMessage(error) === 'notes_too_large';
}

function isUnsafePath(error: unknown): boolean {
  return errorMessage(error) === 'unsafe_path';
}

test('a regular-file save of exactly 65536 bytes is accepted and 65537 leaves the previous bytes', () => {
  withTemp('loam-notes-size-', (root) => {
    const file = path.join(root, 'notes.txt');
    assert.equal(notes.saveNotes(root, 'previous'), 'previous');
    const seeded = fs.readFileSync(file);
    const tooBig = 'b'.repeat(OVER_BYTES);
    assert.equal(Buffer.byteLength(tooBig), OVER_BYTES);
    assert.throws(() => notes.saveNotes(root, tooBig), isNotesTooLarge);
    assert.deepEqual(fs.readFileSync(file), seeded);

    const exact = 'a'.repeat(EXACT_BYTES);
    assert.equal(Buffer.byteLength(exact), EXACT_BYTES);
    assert.equal(notes.saveNotes(root, exact), exact);
    const saved = fs.readFileSync(file);
    assert.equal(saved.length, EXACT_BYTES);
    assert.deepEqual(saved, Buffer.from(exact));
    assert.equal(notes.loadNotes(root), exact);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.equal(stat.size, EXACT_BYTES);

    assert.throws(() => notes.saveNotes(root, tooBig), isNotesTooLarge);
    assert.deepEqual(fs.readFileSync(file), saved);

    const replaced = 'c'.repeat(EXACT_BYTES);
    assert.equal(notes.saveNotes(root, replaced), replaced);
    const replacedBytes = fs.readFileSync(file);
    assert.equal(replacedBytes.length, EXACT_BYTES);
    assert.deepEqual(replacedBytes, Buffer.from(replaced));

    const planted = Buffer.alloc(OVER_BYTES, 0x62);
    fs.writeFileSync(file, planted);
    assert.equal(fs.lstatSync(file).size, OVER_BYTES);
    assert.throws(() => notes.saveNotes(root, 'tiny'), isNotesTooLarge);
    assert.throws(() => notes.loadNotes(root), isNotesTooLarge);
    assert.deepEqual(fs.readFileSync(file), planted);
  });
});

test('a non-file notes path is rejected', () => {
  withTemp('loam-notes-size-dir-', (root) => {
    const file = path.join(root, 'notes.txt');
    fs.mkdirSync(file);
    assert.equal(fs.lstatSync(file).isFile(), false);
    assert.throws(() => notes.saveNotes(root, 'text'), isUnsafePath);
    assert.equal(fs.lstatSync(file).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(file), []);
  });
});

test('a regular file with nlink greater than 1 is rejected and its bytes stay', () => {
  withTemp('loam-notes-size-nlink-', (root) => {
    const file = path.join(root, 'notes.txt');
    const extra = path.join(root, 'extra.txt');
    const previous = Buffer.from('previous');
    fs.writeFileSync(extra, previous);
    fs.linkSync(extra, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.throws(() => notes.saveNotes(root, 'changed'), isUnsafePath);
    assert.throws(() => notes.loadNotes(root), isUnsafePath);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(extra), previous);
  });
});

test('a symlink is rejected without creating one and the file bytes stay', () => {
  withTemp('loam-notes-size-stat-', (root) => {
    const file = path.join(root, 'notes.txt');
    const previous = Buffer.from('previous');
    fs.writeFileSync(file, previous);
    const realLstatSync = fs.lstatSync;
    const patched = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      const stat = realLstatSync(target, options);
      assert.ok(stat);
      if (path.resolve(String(target)) !== path.resolve(file)) return stat;
      return {
        isSymbolicLink: () => true,
        isFile: () => true,
        isDirectory: () => false,
        nlink: 1,
        size: stat.size,
      } as fs.Stats;
    }) as typeof fs.lstatSync;
    Object.defineProperty(fs, 'lstatSync', { value: patched });
    try {
      assert.throws(() => notes.saveNotes(root, 'changed'), isUnsafePath);
      assert.equal(realLstatSync(file).isSymbolicLink(), false);
      assert.equal(realLstatSync(file).isFile(), true);
      assert.deepEqual(fs.readFileSync(file), previous);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    }
  });
});
