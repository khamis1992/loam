import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMarkdownStore } = require('../../templates/electron-app/electron/apps/markdownStore.cjs') as {
  createMarkdownStore: (root: string) => {
    list: () => string[];
    read: (name: string) => { name: string; content: string };
    write: (name: string, content: string) => { name: string; content: string };
  };
};

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

function isHardLink(error: unknown): boolean {
  return error instanceof Error && error.message === 'Hard links are not allowed';
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPERM';
}

test('write refuses an existing markdown file whose nlink is greater than 1', () => {
  withPair('loam-markdown-hard-', (root, outside) => {
    const store = createMarkdownStore(root);
    const file = path.join(root, 'notes.md');
    const linked = path.join(outside, 'secret.md');
    const previous = Buffer.from('ملاحظة سابقة');
    fs.writeFileSync(linked, previous);
    fs.linkSync(linked, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(fs.lstatSync(linked).nlink > 1, true);
    assert.throws(() => store.write('notes.md', 'تغيير'), isHardLink);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(linked).nlink > 1, true);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(linked), previous);
    assert.deepEqual(store.list(), ['notes.md']);
    assert.deepEqual(fs.readdirSync(root), ['notes.md']);
  });
});

test('a normal new local note still saves', () => {
  withPair('loam-markdown-hard-new-', (root) => {
    const store = createMarkdownStore(root);
    const file = path.join(root, 'note.md');
    assert.equal(fs.existsSync(file), false);
    const created = 'ملاحظة جديدة';
    assert.equal(store.write('note.md', created).content, created);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).isFile(), true);
    assert.equal(fs.lstatSync(file).nlink, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), created);
    assert.equal(store.read('note.md').content, created);
    const replaced = 'ملاحظة محدّثة';
    assert.equal(store.write('note.md', replaced).content, replaced);
    assert.equal(fs.lstatSync(file).nlink, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), replaced);
    assert.deepEqual(store.list(), ['note.md']);
  });
});

test('lstat EPERM is not swallowed before write', () => {
  withPair('loam-markdown-hard-eperm-', (root) => {
    const store = createMarkdownStore(root);
    const file = path.join(root, 'notes.md');
    const previous = Buffer.from('ملاحظة سابقة');
    fs.writeFileSync(file, previous);
    const realLstatSync = fs.lstatSync;
    let calls = 0;
    const patched = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) === path.resolve(file)) {
        calls += 1;
        if (calls > 1) {
          const error = new Error('operation not permitted') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync;
    Object.defineProperty(fs, 'lstatSync', { value: patched });
    try {
      assert.throws(() => store.write('notes.md', 'تغيير'), isEperm);
      assert.equal(calls > 1, true);
      assert.deepEqual(realLstatSync(file).nlink, 1);
      assert.deepEqual(fs.readFileSync(file), previous);
      assert.deepEqual(fs.readdirSync(root), ['notes.md']);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    }
  });
});
