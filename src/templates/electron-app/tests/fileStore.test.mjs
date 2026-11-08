import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const { createFileStore } = createRequire(import.meta.url)('../electron/fileStore.cjs');

test('searches and tags only files inside the fixture', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-files-'));
  fs.writeFileSync(path.join(root, 'notes.txt'), 'local notes');
  fs.writeFileSync(path.join(root, 'budget.csv'), 'category,amount');
  const store = createFileStore(root);
  assert.deepEqual(store.listFiles({ query: 'notes' }).map((file) => file.name), ['notes.txt']);
  store.addTag('notes.txt', 'important');
  assert.deepEqual(store.listFiles({ tag: 'important' }).map((file) => file.name), ['notes.txt']);
  assert.deepEqual(store.listFiles({ tag: 'other' }), []);
  assert.throws(() => store.addTag('../outside.txt', 'important'), /Invalid file name/);
  assert.throws(() => store.addTag('missing.txt', 'important'), /File not found/);
  fs.rmSync(root, { recursive: true, force: true });
});
