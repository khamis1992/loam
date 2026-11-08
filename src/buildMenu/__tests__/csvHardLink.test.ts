import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyApprovedCsv, localCsvText } from '../notebooks/csv.js';

const LOCAL_CSV = 'name,amount\nAda,12\n';
const OUTSIDE = 'outside-secret\n';

function unsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function makeRoot(): { root: string; outside: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-csv-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-csv-out-'));
  return { root, outside };
}

function cleanup(root: string, outside: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

function writeInbox(root: string, name: string, text: string): string {
  const inbox = path.join(root, 'app', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const file = path.join(inbox, name);
  fs.writeFileSync(file, text);
  return file;
}

test('a normal local csv with nlink 1 still copies', () => {
  const { root, outside } = makeRoot();
  try {
    const inbox = writeInbox(root, 'sales.csv', LOCAL_CSV);
    const inboxStat = fs.lstatSync(inbox);
    assert.equal(inboxStat.isFile(), true);
    assert.equal(inboxStat.isSymbolicLink(), false);
    assert.equal(inboxStat.nlink, 1);
    assert.equal(copyApprovedCsv(root, 'app/inbox/sales.csv'), 'app/data/sales.csv');
    const stored = path.join(root, 'app', 'data', 'sales.csv');
    const storedStat = fs.lstatSync(stored);
    assert.equal(storedStat.isFile(), true);
    assert.equal(storedStat.isSymbolicLink(), false);
    assert.equal(storedStat.nlink, 1);
    assert.equal(fs.readFileSync(stored, 'utf8'), LOCAL_CSV);
    assert.deepEqual(localCsvText(root), { name: 'sales.csv', text: LOCAL_CSV });
    assert.equal(fs.readFileSync(inbox, 'utf8'), LOCAL_CSV);
  } finally {
    cleanup(root, outside);
  }
});

test('copyApprovedCsv refuses an inbox hard link before copy and leaves the outside bytes', () => {
  const { root, outside } = makeRoot();
  try {
    const outsideFile = path.join(outside, 'secret.csv');
    const hidden = Buffer.from(OUTSIDE);
    fs.writeFileSync(outsideFile, hidden);
    const inboxDir = path.join(root, 'app', 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    const inbox = path.join(inboxDir, 'sales.csv');
    fs.linkSync(outsideFile, inbox);
    const stat = fs.lstatSync(inbox);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    const destination = path.join(root, 'app', 'data', 'sales.csv');
    assert.throws(() => copyApprovedCsv(root, 'app/inbox/sales.csv'), unsafePath);
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.readFileSync(outsideFile), hidden);
    assert.deepEqual(fs.readFileSync(inbox), hidden);
    assert.equal(localCsvText(root), null);
  } finally {
    cleanup(root, outside);
  }
});

test('copyApprovedCsv refuses a destination hard link before copy and leaves the outside bytes', () => {
  const { root, outside } = makeRoot();
  try {
    const inbox = writeInbox(root, 'sales.csv', LOCAL_CSV);
    assert.equal(fs.lstatSync(inbox).nlink, 1);
    const outsideFile = path.join(outside, 'secret.csv');
    const hidden = Buffer.from(OUTSIDE);
    fs.writeFileSync(outsideFile, hidden);
    const dataDir = path.join(root, 'app', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const destination = path.join(dataDir, 'sales.csv');
    fs.linkSync(outsideFile, destination);
    const stat = fs.lstatSync(destination);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.throws(() => copyApprovedCsv(root, 'app/inbox/sales.csv'), unsafePath);
    assert.throws(() => localCsvText(root), unsafePath);
    assert.deepEqual(fs.readFileSync(outsideFile), hidden);
    assert.deepEqual(fs.readFileSync(destination), hidden);
    assert.equal(fs.readFileSync(inbox, 'utf8'), LOCAL_CSV);
  } finally {
    cleanup(root, outside);
  }
});

test('localCsvText refuses a data file hard link before returning text', () => {
  const { root, outside } = makeRoot();
  try {
    const outsideFile = path.join(outside, 'secret.csv');
    const hidden = Buffer.from(OUTSIDE);
    fs.writeFileSync(outsideFile, hidden);
    const dataDir = path.join(root, 'app', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const stored = path.join(dataDir, 'sales.csv');
    fs.linkSync(outsideFile, stored);
    const stat = fs.lstatSync(stored);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.throws(() => localCsvText(root), unsafePath);
    assert.deepEqual(fs.readFileSync(outsideFile), hidden);
    assert.deepEqual(fs.readFileSync(stored), hidden);
  } finally {
    cleanup(root, outside);
  }
});

test('a path outside app/inbox throws unsafe_path', () => {
  const { root, outside } = makeRoot();
  try {
    const outsideFile = path.join(outside, 'secret.csv');
    const hidden = Buffer.from(OUTSIDE);
    fs.writeFileSync(outsideFile, hidden);
    fs.writeFileSync(path.join(root, 'secret.csv'), hidden);
    const destination = path.join(root, 'app', 'data', 'sales.csv');
    for (const source of ['../secret.csv', 'secret.csv', 'app/inbox/../secret.csv', outsideFile]) {
      assert.throws(() => copyApprovedCsv(root, source), unsafePath, source);
      assert.deepEqual(fs.readFileSync(outsideFile), hidden, source);
      assert.deepEqual(fs.readFileSync(path.join(root, 'secret.csv')), hidden, source);
      assert.equal(fs.existsSync(destination), false, source);
    }
  } finally {
    cleanup(root, outside);
  }
});
