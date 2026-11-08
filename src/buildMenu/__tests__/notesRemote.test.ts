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

function withTemp(prefix: string, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function isUnsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isNotesTooLarge(error: unknown): boolean {
  return error instanceof Error && error.message === 'notes_too_large';
}

function encodeMarks(value: string): string {
  return value.replace(/[:/]/g, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function encodePercents(value: string): string {
  return value.replace(/%/g, '%25');
}

function encodeAll(value: string): string {
  return [...Buffer.from(value)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
}

function encodedForms(value: string): string[] {
  const marks = encodeMarks(value);
  const marksUpper = marks.toUpperCase();
  return [
    value,
    marks,
    encodePercents(marks),
    marksUpper,
    encodePercents(marksUpper),
    encodeAll(value),
    encodePercents(encodeAll(value)),
  ];
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
    samples.push(`${name}%253A'+'%252F%252Fexample.test/a`);
    samples.push(`${name.slice(0, 2)}+${name.slice(2)}://example.test/a`);
  }
  const colonNames = ['javascript', 'data', 'file', 'blob', 'mailto', 'tel', 'intent', 'market', 'JAVASCRIPT', 'DATA', 'FILE', 'BLOB', 'MAILTO', 'TEL', 'INTENT', 'MARKET'];
  for (const name of colonNames) {
    samples.push(`${name}'+':alert`);
    samples.push(`"${name}"+":alert"`);
    samples.push(`${name}%3A'+'alert`);
    samples.push(`${name}%253a'+'alert`);
    samples.push(`${name.slice(0, 2)}+${name.slice(2)}:alert`);
    samples.push(`${name.slice(0, 2)}"${name.slice(2)}:alert`);
  }
  samples.push("'/'+'/example.test/a'");
  samples.push('"/"+"/"+"example.test/a"');
  samples.push('/+/example.test/a');
  samples.push('%2f%2fexample.test/a');
  samples.push('%252f%252fexample.test/a');
  samples.push('%2F%2Fexample.test/a');
  samples.push('%252F%252Fexample.test/a');
  return samples;
}

function exactBytes(prefix: string, total: number): string {
  const prefixBytes = Buffer.byteLength(prefix, 'utf8');
  let remain = total - prefixBytes;
  let text = prefix;
  if (remain % 2 === 1) {
    text += 'x';
    remain -= 1;
  }
  text += 'ب'.repeat(remain / 2);
  if (Buffer.byteLength(text, 'utf8') !== total) throw new Error('size');
  return text;
}

test('saveNotes refuses a remote scheme and leaves the previous bytes', () => {
  withTemp('loam-notes-remote-', (root) => {
    const file = path.join(root, 'notes.txt');
    assert.equal(fs.existsSync(file), false);
    assert.throws(() => notes.saveNotes(root, 'https://example.test/a'), isUnsafePath);
    assert.equal(fs.existsSync(file), false);
    const previous = 'سابق';
    assert.equal(notes.saveNotes(root, previous), previous);
    const seeded = fs.readFileSync(file);
    const samples = remoteSamples();
    assert.ok(samples.length > 40);
    for (const sample of samples) {
      for (const text of [sample, `قبل ${sample} بعد`]) {
        assert.ok(Buffer.byteLength(text, 'utf8') <= 65536);
        assert.throws(() => notes.saveNotes(root, text), isUnsafePath, text);
        assert.deepEqual(fs.readFileSync(file), seeded);
        assert.equal(notes.loadNotes(root), previous);
      }
    }
    const safe = [
      'ملاحظة: نص/محلي',
      '1+1=2',
      'قل "مرحبا": اليوم',
      'جاهز%20تمام',
      'https: بدون شرطتين',
      'data file mailto tel market intent blob',
    ];
    for (const text of safe) {
      assert.equal(notes.saveNotes(root, text), text);
      assert.equal(notes.loadNotes(root), text);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
    }
  });
});

test('plain Arabic of 65536 bytes saves and 65537 bytes throws notes_too_large', () => {
  withTemp('loam-notes-remote-size-', (root) => {
    const file = path.join(root, 'notes.txt');
    const arabic = 'ا'.repeat(32768);
    assert.equal(Buffer.byteLength(arabic, 'utf8'), 65536);
    assert.equal(notes.saveNotes(root, arabic), arabic);
    const saved = fs.readFileSync(file);
    assert.equal(saved.length, 65536);
    assert.deepEqual(saved, Buffer.from(arabic));
    assert.equal(notes.loadNotes(root), arabic);
    const over = `${arabic}x`;
    assert.equal(Buffer.byteLength(over, 'utf8'), 65537);
    assert.throws(() => notes.saveNotes(root, over), isNotesTooLarge);
    assert.deepEqual(fs.readFileSync(file), saved);
    const remoteOver = exactBytes('https://example.test/', 65537);
    assert.equal(Buffer.byteLength(remoteOver, 'utf8'), 65537);
    assert.throws(() => notes.saveNotes(root, remoteOver), isNotesTooLarge);
    assert.deepEqual(fs.readFileSync(file), saved);
  });
});

test('an empty string still saves', () => {
  withTemp('loam-notes-remote-empty-', (root) => {
    const file = path.join(root, 'notes.txt');
    assert.equal(notes.saveNotes(root, ''), '');
    assert.equal(notes.loadNotes(root), '');
    assert.equal(fs.readFileSync(file).length, 0);
    assert.equal(notes.saveNotes(root, 'سابق'), 'سابق');
    assert.equal(notes.saveNotes(root, ''), '');
    assert.deepEqual(fs.readFileSync(file), Buffer.alloc(0));
    assert.equal(notes.loadNotes(root), '');
  });
});

test('a hard link with nlink greater than 1 stays rejected', () => {
  withTemp('loam-notes-remote-hard-', (root) => {
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
