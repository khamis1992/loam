import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkedTuning, loadTuningText, readLocalTuning, writeLocalTuning, type Tuning } from '../games/tuning.js';

const VALID = '{"speed":200,"gravity":700}';

const SCHEMES = [
  'mailto:user@example.test',
  'MAILTO:user@example.test',
  'mailto :user@example.test',
  'tel:97400000000',
  'sms:97400000000',
  'intent:scan',
  'intent :scan',
  'market:details?id=app',
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'javascript :alert(1)',
  'https://evil.example/a',
  'http://evil.example/a',
  'HTTPS://evil.example/a',
  'HTTP://evil.example/a',
  'data:text/html,hi',
  'DATA:text/html,hi',
  'file:///c:/secret',
  'FILE:///c:/secret',
  'blob:null/uuid',
  'BLOB:null/uuid',
  '//evil.example/a',
  '//EVIL.example/a',
  'mailto%3Auser@example.test',
  'tel%3A974',
  'sms%3A974',
  'intent%3Ascan',
  'market%3Adetails',
  'javascript%3Aalert(1)',
  'JavaScript%3Aalert(1)',
  'https%3A%2F%2Fevil.example/a',
  'http%3A%2F%2Fevil.example/a',
  'http:%2F%2Fevil.example/a',
  'http%3A//evil.example/a',
  'HTTPS%3A%2F%2Fevil.example/a',
  'data%3Atext/html,hi',
  'file%3A///c:/secret',
  'blob%3Anull/uuid',
  '%2F%2Fevil.example/a',
  'mailto%253Auser@example.test',
  'tel%253A974',
  'sms%253A974',
  'intent%253Ascan',
  'market%253Adetails',
  'javascript%253Aalert(1)',
  'https%253A%252F%252Fevil.example/a',
  'http%253A%252F%252Fevil.example/a',
  'http:%252F%252Fevil.example/a',
  'data%253Atext/html,hi',
  'file%253A///c:/secret',
  'blob%253Anull/uuid',
  '%252F%252Fevil.example/a',
  'java%73cript:alert(1)',
  'java%2573cript%253Aalert(1)',
  '"mailto"+":"',
  '"tel"+":"',
  '"sms"+":"',
  '"intent"+":"',
  '"market"+":"',
  '"javascript"+":"',
  '"java"+"script:"',
  "javascript'+':alert(1)",
  '"https"+"://evil.example/a"',
  '"http"+"://evil.example/a"',
  '"http"+"//evil.example/a"',
  "https'+'://evil.example/a",
  '"https" + "://evil.example/a"',
  '"data"+":"',
  '"file"+":///c:/secret"',
  '"blob"+":"',
  '"mail"+"to:"',
  '"/"+"/"',
  '%22javascript%22%2B%22%3A%22',
  '%2522javascript%2522%252B%2522%253A%2522',
  '%22http%22%2B%22%3A%2F%2Fevil.example%22',
  '%2522https%2522%252B%2522%253A%252F%252Fevil.example%2522',
];

function payload(scheme: string): string {
  return `{"speed":200,"gravity":700,"next":${JSON.stringify(scheme)}}`;
}

function invalidTuning(error: unknown): boolean {
  return error instanceof Error && error.message === 'invalid_tuning';
}

function unsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

test('tuning bounds still reject NaN and Infinity', () => {
  assert.deepEqual(checkedTuning({ speed: 50, gravity: 100 }), { speed: 50, gravity: 100 });
  assert.deepEqual(checkedTuning({ speed: 500, gravity: 1500 }), { speed: 500, gravity: 1500 });
  assert.deepEqual(loadTuningText(`${VALID}\n`), { speed: 200, gravity: 700 });
  assert.throws(() => checkedTuning({ speed: 49, gravity: 700 }), invalidTuning);
  assert.throws(() => checkedTuning({ speed: 501, gravity: 700 }), invalidTuning);
  assert.throws(() => checkedTuning({ speed: 200, gravity: 99 }), invalidTuning);
  assert.throws(() => checkedTuning({ speed: 200, gravity: 1501 }), invalidTuning);
  assert.throws(() => checkedTuning({ speed: NaN, gravity: 700 }), invalidTuning);
  assert.throws(() => checkedTuning({ speed: 200, gravity: NaN }), invalidTuning);
  assert.throws(() => checkedTuning({ speed: Infinity, gravity: 700 }), invalidTuning);
  assert.throws(() => checkedTuning({ speed: 200, gravity: Infinity }), invalidTuning);
  assert.throws(() => checkedTuning({ speed: -Infinity, gravity: 700 }), invalidTuning);
});

test('tuning text rejects remote schemes, encodings, and quote splits', () => {
  for (const scheme of SCHEMES) {
    const text = payload(scheme);
    const parsed = JSON.parse(text) as Tuning;
    assert.equal(parsed.speed, 200, scheme);
    assert.equal(parsed.gravity, 700, scheme);
    assert.throws(() => loadTuningText(text), invalidTuning, scheme);
    assert.throws(() => checkedTuning(parsed), invalidTuning, scheme);
  }
});

test('a rejected tuning write keeps the previous file and does not replace a directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-40-tuning-scheme-'));
  try {
    const target = path.join(root, 'tuning.json');
    const blocked = payload('javascript:alert(1)');
    assert.throws(() => writeLocalTuning(root, blocked), invalidTuning);
    assert.equal(fs.existsSync(target), false);

    writeLocalTuning(root, VALID);
    assert.equal(fs.readFileSync(target, 'utf8'), VALID);
    assert.deepEqual(readLocalTuning(root), { speed: 200, gravity: 700 });
    const saved = fs.lstatSync(target);
    assert.equal(saved.isFile(), true);
    assert.equal(saved.isSymbolicLink(), false);

    for (const scheme of SCHEMES) {
      assert.throws(() => writeLocalTuning(root, payload(scheme)), invalidTuning, scheme);
      assert.equal(fs.readFileSync(target, 'utf8'), VALID, scheme);
      assert.equal(fs.lstatSync(target).isSymbolicLink(), false, scheme);
      assert.equal(fs.lstatSync(target).isFile(), true, scheme);
    }

    writeLocalTuning(root, VALID);
    assert.equal(fs.readFileSync(target, 'utf8'), VALID);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);

    fs.rmSync(target);
    fs.mkdirSync(target);
    assert.throws(() => writeLocalTuning(root, VALID), unsafePath);
    assert.equal(fs.lstatSync(target).isDirectory(), true);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    assert.deepEqual(fs.readdirSync(target), []);
    assert.throws(() => readLocalTuning(root), unsafePath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
