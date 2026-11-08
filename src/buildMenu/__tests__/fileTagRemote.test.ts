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

const MARKS = ['mailto', 'tel', 'sms', 'intent', 'market', 'https', 'javascript', '//'] as const;

const RAW_REMOTE = [
  'mailto',
  'mailto:a@b.c',
  'MAILTO:A@B.C',
  'tel',
  'TEL:+1',
  'sms',
  'SMS:+1',
  'intent',
  'INTENT:x',
  'market',
  'MARKET:x',
  'https',
  'HTTPS://a.co',
  'javascript',
  'JavaScript:a',
  '//',
  '//evil.co',
  'x//y',
];

const ENCODED_REMOTE = [
  '%6d%61%69%6c%74%6f',
  '%6D%61%69%6C%74%6F',
  'mail%74o',
  '%74%65%6c',
  'te%6c',
  '%73%6d%73',
  '%73ms',
  '%69%6e%74%65%6e%74',
  'int%65nt',
  '%6d%61%72%6b%65%74',
  'mar%6bet',
  '%68%74%74%70%73',
  'ht%74ps',
  'java%73cript',
  '%2f%2f',
  '%2F%2F',
  'a%2f%2fb',
  '%2f/x',
];

function decodeOnce(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function hasMark(value: string): boolean {
  const lower = value.toLowerCase();
  return MARKS.some((mark) => lower.includes(mark));
}

function isInvalidTag(error: unknown): boolean {
  return error instanceof Error && error.message === 'Invalid tag';
}

function isInvalidName(error: unknown): boolean {
  return error instanceof Error && error.message === 'Invalid file name';
}

function withTemp(prefix: string, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function tagsOf(files: Array<{ name: string; tags: string[] }>): string[][] {
  return files.map((file) => file.tags);
}

test('addTag refuses mailto, tel, sms, intent, market, https, javascript, and a protocol-relative mark, including one percent-decode, and leaves the previous tag file unchanged', () => {
  const remote = [...RAW_REMOTE, ...ENCODED_REMOTE];
  for (const tag of RAW_REMOTE) {
    assert.equal(tag.length <= 24, true, tag);
    assert.equal(hasMark(tag), true, tag);
  }
  for (const tag of ENCODED_REMOTE) {
    assert.equal(tag.length <= 24, true, tag);
    assert.equal(hasMark(tag), false, tag);
    assert.equal(hasMark(decodeOnce(tag)), true, tag);
  }

  withTemp('loam-file-tag-', (root) => {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'local notes');
    const store = createFileStore(root);
    const tagsPath = path.join(root, '.loam-tags.json');
    assert.equal(fs.existsSync(tagsPath), false);

    for (const tag of remote) {
      assert.throws(() => store.addTag('notes.txt', tag), isInvalidTag, tag);
      assert.equal(fs.existsSync(tagsPath), false, tag);
    }

    assert.deepEqual(tagsOf(store.addTag('notes.txt', 'مهم')), [['مهم']]);
    const seeded = fs.readFileSync(tagsPath);
    assert.equal(seeded.includes(Buffer.from('"مهم"')), true);

    for (const tag of remote) {
      assert.throws(() => store.addTag('notes.txt', `  ${tag}  `), isInvalidTag, tag);
      assert.deepEqual(fs.readFileSync(tagsPath), seeded, tag);
      assert.deepEqual(store.listFiles({ tag: 'مهم' }).map((file) => file.name), ['notes.txt']);
      assert.deepEqual(store.listFiles({ tag: tag.trim() }), []);
    }
  });
});

test('a normal short tag still saves and a name that escapes the directory still throws', () => {
  withTemp('loam-file-tag-save-', (root) => {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'local notes');
    const store = createFileStore(root);
    const tagsPath = path.join(root, '.loam-tags.json');

    assert.deepEqual(tagsOf(store.addTag('notes.txt', 'work')), [['work']]);
    assert.deepEqual(tagsOf(store.addTag('notes.txt', 'ok%20go')), [['work', 'ok%20go']]);
    assert.deepEqual(tagsOf(store.addTag('notes.txt', '100%')), [['work', 'ok%20go', '100%']]);
    const seeded = fs.readFileSync(tagsPath);
    assert.equal(seeded.toString('utf8').includes('"ok%20go"'), true);
    assert.equal(seeded.toString('utf8').includes('"100%"'), true);
    assert.deepEqual(store.listFiles({ tag: 'work' }).map((file) => file.name), ['notes.txt']);

    for (const name of ['../outside.txt', '..\\outside.txt', 'nested/notes.txt', '..']) {
      assert.throws(() => store.addTag(name, 'work'), isInvalidName, name);
      assert.deepEqual(fs.readFileSync(tagsPath), seeded, name);
    }

    assert.deepEqual(tagsOf(store.listFiles()), [['work', 'ok%20go', '100%']]);
  });
});
