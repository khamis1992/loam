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

function withTemp(prefix: string, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function isRemote(error: unknown): boolean {
  return error instanceof Error && error.message === 'Remote content is not allowed';
}

function encodeMarks(value: string): string {
  return value.replace(/[:/]/g, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function encodeAll(value: string): string {
  return [...Buffer.from(value)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
}

function encodedForms(value: string): string[] {
  const marks = encodeMarks(value);
  return [value, marks, marks.toUpperCase(), encodeAll(value)];
}

function remoteSamples(): string[] {
  const literals = [
    'https://example.test/a',
    'http://example.test/a',
    'HTTPS://example.test/a',
    'HTTP://example.test/a',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,hi',
    'DATA:text/html,hi',
    'file:///C:/secret.txt',
    'FILE:///C:/secret.txt',
    'blob:00000000-0000-0000-0000-000000000000',
    'BLOB:00000000-0000-0000-0000-000000000000',
    '//example.test/a',
    '//HOST/a',
    'mailto:user@example.test',
    'MAILTO:user@example.test',
    'tel:+97400000000',
    'TEL:+97400000000',
    'sms:+97400000000',
    'SMS:+97400000000',
    'intent:scan',
    'INTENT:scan',
    'market://details?id=app',
    'MARKET:details',
  ];
  const samples = literals.flatMap((value) => encodedForms(value));
  const slashNames = ['https', 'http', 'HTTPS', 'HTTP'];
  for (const name of slashNames) {
    samples.push(`${name}'+'://example.test/a`);
    samples.push(`"${name}"+"//example.test/a"`);
    samples.push(`"${name}"+"://example.test/a"`);
    samples.push(`${name}%3a'+'%2f%2fexample.test/a`);
    samples.push(`${name}'%2B'://example.test/a`);
    samples.push(`${name.slice(0, 2)}+${name.slice(2)}://example.test/a`);
    samples.push(`ht%'+'${name.slice(2) === 'tps' || name.slice(2) === 'TPS' ? '74ps' : '74p'}://example.test/a`);
  }
  const colonNames = ['javascript', 'data', 'file', 'blob', 'mailto', 'tel', 'sms', 'intent', 'market', 'JAVASCRIPT', 'DATA', 'FILE', 'BLOB', 'MAILTO', 'TEL', 'SMS', 'INTENT', 'MARKET'];
  for (const name of colonNames) {
    samples.push(`${name}'+':alert`);
    samples.push(`"${name}"+":alert"`);
    samples.push(`${name}%3A'+'alert`);
    samples.push(`${name}'%2B':alert`);
    samples.push(`${name.slice(0, 2)}+${name.slice(2)}:alert`);
    samples.push(`${name.slice(0, 2)}"${name.slice(2)}:alert`);
  }
  samples.push("'/'+'/example.test/a'");
  samples.push('"/"+"/"+"example.test/a"');
  samples.push('/+/example.test/a');
  samples.push('%2f%2fexample.test/a');
  samples.push('%2F%2Fexample.test/a');
  samples.push("mail%'+'74o:user@example.test");
  samples.push('%22mailto%22%2B%22%3Auser%22');
  return samples;
}

test('write refuses mailto, tel, sms, intent, market, https, javascript, data, file, blob, and protocol-relative content', () => {
  withTemp('loam-markdown-remote-', (root) => {
    const store = createMarkdownStore(root);
    const file = path.join(root, 'notes.md');
    assert.equal(fs.existsSync(file), false);
    assert.throws(() => store.write('notes.md', 'https://example.test/a'), isRemote);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(fs.readdirSync(root), []);
    const previous = 'ملاحظة سابقة';
    assert.equal(store.write('notes.md', previous).content, previous);
    const seeded = fs.readFileSync(file);
    const samples = remoteSamples();
    assert.ok(samples.length > 40);
    for (const sample of samples) {
      for (const text of [sample, `قبل ${sample} بعد`]) {
        assert.throws(() => store.write('notes.md', text), isRemote, text);
        assert.deepEqual(fs.readFileSync(file), seeded);
        assert.equal(store.read('notes.md').content, previous);
        assert.deepEqual(store.list(), ['notes.md']);
      }
    }
    assert.deepEqual(fs.readdirSync(root), ['notes.md']);
    const safe = [
      '# ملاحظة\n\nهذا نص محلي.',
      'ملاحظة: نص/محلي',
      '1+1=2',
      'قل "مرحبا": اليوم',
      'جاهز%20تمام',
      'https: بدون شرطتين',
      'data file mailto tel sms market intent blob',
      '[صفحة](./صفحة.md)',
    ];
    for (const text of safe) {
      assert.equal(store.write('notes.md', text).content, text);
      assert.equal(store.read('notes.md').content, text);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
    }
  });
});

test('a name that escapes the directory still throws', () => {
  withTemp('loam-markdown-escape-', (root) => {
    const store = createMarkdownStore(root);
    const file = path.join(root, 'notes.md');
    const outside = path.join(path.dirname(root), 'outside.md');
    const previous = 'ملاحظة';
    store.write('notes.md', previous);
    const seeded = fs.readFileSync(file);
    assert.equal(fs.existsSync(outside), false);
    assert.throws(() => store.write('../outside.md', 'نص محلي'), /Invalid file name/);
    assert.throws(() => store.write('..\\outside.md', 'نص محلي'), /Invalid file name/);
    assert.deepEqual(fs.readFileSync(file), seeded);
    assert.equal(store.read('notes.md').content, previous);
    assert.equal(fs.existsSync(outside), false);
  });
});
