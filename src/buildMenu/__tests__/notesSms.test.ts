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

function smsSamples(): string[] {
  const literals = [
    'sms:+97400000000',
    'SMS:+97400000000',
    'sms:+97400000000?body=hi',
  ];
  const samples = literals.flatMap((value) => encodedForms(value));
  const colonNames = ['sms', 'SMS'];
  for (const name of colonNames) {
    samples.push(`${name}'+':alert`);
    samples.push(`"${name}"+":alert"`);
    samples.push(`${name}%3A'+'alert`);
    samples.push(`${name}%253a'+'alert`);
    samples.push(`${name.slice(0, 2)}+${name.slice(2)}:alert`);
    samples.push(`${name.slice(0, 2)}"${name.slice(2)}:alert`);
  }
  return samples;
}

test('saveNotes refuses sms the same way as mailto and tel and leaves the previous bytes', () => {
  withTemp('loam-notes-sms-', (root) => {
    const file = path.join(root, 'notes.txt');
    assert.equal(fs.existsSync(file), false);
    assert.throws(() => notes.saveNotes(root, 'sms:+97400000000'), isUnsafePath);
    assert.equal(fs.existsSync(file), false);
    const previous = 'سابق';
    assert.equal(notes.saveNotes(root, previous), previous);
    const seeded = fs.readFileSync(file);
    const samples = smsSamples();
    assert.ok(samples.length > 10);
    for (const sample of samples) {
      for (const text of [sample, `قبل ${sample} بعد`]) {
        assert.ok(Buffer.byteLength(text, 'utf8') <= 65536);
        assert.throws(() => notes.saveNotes(root, text), isUnsafePath, text);
        assert.deepEqual(fs.readFileSync(file), seeded);
        assert.equal(notes.loadNotes(root), previous);
      }
    }
    const safe = 'رسالة sms محلية: بلا مخطط';
    assert.equal(notes.saveNotes(root, safe), safe);
    assert.equal(notes.loadNotes(root), safe);
    assert.equal(fs.readFileSync(file, 'utf8'), safe);
  });
});
