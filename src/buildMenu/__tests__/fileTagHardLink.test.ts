import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createFileStore } = require('../../templates/electron-app/electron/fileStore.cjs') as {
  createFileStore: (root: string) => {
    listFiles: (filters?: { query?: string; tag?: string }) => Array<{ name: string; tags: string[] }>;
    addTag: (name: string, value: string) => Array<{ name: string; tags: string[] }>;
  };
};

function isUnsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function withTemp(prefix: string, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('an existing tags file with nlink greater than 1 is refused before write and the outside bytes stay', () => {
  withTemp('loam-file-tag-hard-', (parent) => {
    const root = path.join(parent, 'store');
    const outside = path.join(parent, 'outside.json');
    const previous = Buffer.from('{"notes.txt":["kept"]}\n');
    fs.mkdirSync(root);
    fs.writeFileSync(outside, previous);
    const tagsPath = path.join(root, '.loam-tags.json');
    fs.linkSync(outside, tagsPath);
    fs.writeFileSync(path.join(root, 'notes.txt'), 'local notes');

    const linked = fs.lstatSync(tagsPath);
    assert.equal(linked.isSymbolicLink(), false);
    assert.equal(linked.isFile(), true);
    assert.equal(linked.nlink > 1, true);
    assert.equal(fs.lstatSync(outside).ino, linked.ino);

    const store = createFileStore(root);
    assert.throws(() => store.addTag('notes.txt', 'work'), isUnsafePath);
    assert.deepEqual(fs.readFileSync(tagsPath), previous);
    assert.deepEqual(fs.readFileSync(outside), previous);
    assert.equal(fs.lstatSync(tagsPath).nlink > 1, true);
    assert.equal(fs.lstatSync(outside).ino, fs.lstatSync(tagsPath).ino);
  });
});

test('a normal short tag on a regular nlink 1 file still saves', () => {
  withTemp('loam-file-tag-nlink1-', (root) => {
    const file = path.join(root, 'notes.txt');
    fs.writeFileSync(file, 'local notes');
    const before = fs.lstatSync(file);
    assert.equal(before.isSymbolicLink(), false);
    assert.equal(before.isFile(), true);
    assert.equal(before.nlink, 1);

    const store = createFileStore(root);
    assert.deepEqual(store.addTag('notes.txt', 'work').map((entry) => entry.tags), [['work']]);

    const tagsPath = path.join(root, '.loam-tags.json');
    const saved = fs.lstatSync(tagsPath);
    assert.equal(saved.isSymbolicLink(), false);
    assert.equal(saved.isFile(), true);
    assert.equal(saved.nlink, 1);
    assert.equal(fs.readFileSync(tagsPath, 'utf8').includes('"work"'), true);
    assert.equal(fs.lstatSync(file).nlink, 1);
  });
});
