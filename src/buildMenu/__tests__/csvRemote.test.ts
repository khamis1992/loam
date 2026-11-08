import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyApprovedCsv } from '../notebooks/csv.js';

const LOCAL_CSV = 'name,amount,contact\nAda,-12,ada@example.test\n';

const DIRECT = [
  'mailto:user@example.test',
  'tel:+97400000000',
  'sms:+97400000000',
  'intent:#Intent;end',
  'market://details?id=app',
  'https://example.test/a',
  'javascript:alert(1)',
  'mailto :user@example.test',
  'HTTPS://example.test/a',
  'JAVASCRIPT:alert(1)',
  '=HYPERLINK("local","open")',
  '=HYPERLINK("https://example.test/a","open")',
  '=HYPERLINK("local";"open")',
  '= HYPERLINK("local","open")',
  '=hyperlink("local","open")',
  '+HYPERLINK("local","open")',
  '-HYPERLINK("local","open")',
  '@HYPERLINK("local","open")',
];

const ONCE_ENCODED = [
  'mailto%3Auser@example.test',
  'mailto%20:user@example.test',
  'mail%74o:user@example.test',
  'https%3A%2F%2Fexample.test/a',
  'javascript%3Aalert(1)',
  'tel%3A%2B97400000000',
  'sms%3A%2B97400000000',
  'intent%3A%23Intent;end',
  'market%3A%2F%2Fdetails',
  '=%20HYPERLINK("local","open")',
  '%3DHYPERLINK("local","open")',
  '=HYPER%4cINK("local","open")',
];

function unsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function percentEncode(value: string): string {
  return Array.from(value, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
}

function withWorkspace(run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-44-csv-'));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeInbox(root: string, name: string, text: string): string {
  const inbox = path.join(root, 'app', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const file = path.join(inbox, name);
  fs.writeFileSync(file, text);
  return file;
}

test('a normal local csv still copies', () => {
  withWorkspace((root) => {
    writeInbox(root, 'sales.csv', LOCAL_CSV);
    assert.equal(copyApprovedCsv(root, 'app/inbox/sales.csv'), 'app/data/sales.csv');
    const stored = path.join(root, 'app', 'data', 'sales.csv');
    assert.equal(fs.readFileSync(stored, 'utf8'), LOCAL_CSV);
    assert.equal(path.resolve(stored).startsWith(path.resolve(root, 'app', 'data')), true);
    const stat = fs.lstatSync(stored);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
  });
});

test('remote schemes and hyperlink formulas are refused, including one percent-decode, and the previous destination stays', () => {
  withWorkspace((root) => {
    const inbox = writeInbox(root, 'sales.csv', LOCAL_CSV);
    assert.equal(copyApprovedCsv(root, 'app/inbox/sales.csv'), 'app/data/sales.csv');
    const destination = path.join(root, 'app', 'data', 'sales.csv');
    const previous = fs.readFileSync(destination);
    assert.equal(previous.toString('utf8'), LOCAL_CSV);

    const payloads = [
      ...DIRECT,
      ...DIRECT.map((payload) => percentEncode(payload)),
      ...ONCE_ENCODED,
    ];
    for (const payload of payloads) {
      fs.writeFileSync(inbox, `name,note\nAda,${payload}\n`);
      assert.throws(() => copyApprovedCsv(root, 'app/inbox/sales.csv'), unsafePath, payload);
      assert.deepEqual(fs.readFileSync(destination), previous, payload);
    }

    const freshDest = path.join(root, 'app', 'data', 'notes.csv');
    writeInbox(root, 'notes.csv', 'name,note\nAda,mailto:user@example.test\n');
    assert.equal(fs.existsSync(freshDest), false);
    assert.throws(() => copyApprovedCsv(root, 'app/inbox/notes.csv'), unsafePath);
    assert.equal(fs.existsSync(freshDest), false);
    assert.deepEqual(fs.readFileSync(destination), previous);

    const absentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-44-csv-'));
    try {
      writeInbox(absentRoot, 'sales.csv', 'mailto:user@example.test\n');
      assert.equal(fs.existsSync(path.join(absentRoot, 'app', 'data')), false);
      assert.throws(() => copyApprovedCsv(absentRoot, 'app/inbox/sales.csv'), unsafePath);
      assert.equal(fs.existsSync(path.join(absentRoot, 'app', 'data')), false);
    } finally {
      fs.rmSync(absentRoot, { recursive: true, force: true });
    }
  });
});

test('a path outside app/inbox throws unsafe_path and leaves the previous destination', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-44-csv-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-44-csv-out-'));
  try {
    const inbox = writeInbox(root, 'sales.csv', LOCAL_CSV);
    assert.equal(copyApprovedCsv(root, 'app/inbox/sales.csv'), 'app/data/sales.csv');
    const destination = path.join(root, 'app', 'data', 'sales.csv');
    const previous = fs.readFileSync(destination);
    const outsideFile = path.join(outside, 'secret.csv');
    const hidden = Buffer.from('hidden\n');
    fs.writeFileSync(outsideFile, hidden);
    fs.writeFileSync(path.join(root, 'secret.csv'), hidden);

    const escapes = [
      '../secret.csv',
      'app/inbox/../secret.csv',
      'secret.csv',
      'app/secret.csv',
      'app/outbox/sales.csv',
      outsideFile,
    ];
    for (const source of escapes) {
      assert.throws(() => copyApprovedCsv(root, source), unsafePath, source);
      assert.deepEqual(fs.readFileSync(destination), previous, source);
      assert.deepEqual(fs.readFileSync(outsideFile), hidden, source);
      assert.deepEqual(fs.readFileSync(path.join(root, 'secret.csv')), hidden, source);
      assert.equal(fs.existsSync(path.join(root, 'app', 'data', 'secret.csv')), false, source);
    }
    assert.equal(fs.readFileSync(inbox, 'utf8'), LOCAL_CSV);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
