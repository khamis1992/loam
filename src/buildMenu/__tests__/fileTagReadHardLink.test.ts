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

test('an existing tags file with nlink greater than 1 is refused before read and the outside bytes stay', () => {
  withTemp('loam-file-tag-read-hard-', (parent) => {
    const root = path.join(parent, 'store');
    const outside = path.join(parent, 'outside.json');
    const previous = Buffer.from('not-json-outside-bytes\n');
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
    assert.throws(() => store.listFiles(), isUnsafePath);
    assert.deepEqual(fs.readFileSync(tagsPath), previous);
    assert.deepEqual(fs.readFileSync(outside), previous);
    assert.equal(fs.lstatSync(tagsPath).nlink > 1, true);
    assert.equal(fs.lstatSync(outside).ino, fs.lstatSync(tagsPath).ino);
  });
});

test('a regular nlink 1 tags file still reads', () => {
  withTemp('loam-file-tag-read-nlink1-', (root) => {
    const file = path.join(root, 'notes.txt');
    fs.writeFileSync(file, 'local notes');
    const tagsPath = path.join(root, '.loam-tags.json');
    fs.writeFileSync(tagsPath, `${JSON.stringify({ 'notes.txt': ['work'] }, null, 2)}\n`);
    const saved = fs.lstatSync(tagsPath);
    assert.equal(saved.isSymbolicLink(), false);
    assert.equal(saved.isFile(), true);
    assert.equal(saved.nlink, 1);

    const store = createFileStore(root);
    assert.deepEqual(store.listFiles().map((entry) => ({ name: entry.name, tags: entry.tags })), [
      { name: 'notes.txt', tags: ['work'] },
    ]);
    assert.equal(fs.lstatSync(tagsPath).nlink, 1);
    assert.equal(fs.lstatSync(file).nlink, 1);
    assert.equal(fs.readFileSync(tagsPath, 'utf8').includes('"work"'), true);
  });
});
