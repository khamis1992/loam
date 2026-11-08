import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyApprovedCsv } from '../notebooks/csv.js';

test('csv import replaces a project file and refuses a directory target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-csv-copy-'));
  const outside = path.join(root, 'secret.csv');
  fs.writeFileSync(outside, 'hidden\n');
  fs.mkdirSync(path.join(root, 'app', 'inbox'), { recursive: true });
  const inbox = path.join(root, 'app', 'inbox', 'sales.csv');
  fs.writeFileSync(inbox, 'amount\n1\n');
  try {
    assert.equal(copyApprovedCsv(root, 'app/inbox/sales.csv'), 'app/data/sales.csv');
    fs.writeFileSync(inbox, 'amount\n2\n');
    assert.equal(copyApprovedCsv(root, 'app/inbox/sales.csv'), 'app/data/sales.csv');
    const stored = path.join(root, 'app', 'data', 'sales.csv');
    assert.equal(fs.readFileSync(stored, 'utf8'), 'amount\n2\n');
    assert.equal(path.resolve(stored).startsWith(path.resolve(root, 'app', 'data')), true);
    fs.rmSync(stored);
    fs.mkdirSync(stored);
    assert.throws(() => copyApprovedCsv(root, 'app/inbox/sales.csv'), /unsafe_path/);
    assert.equal(fs.statSync(stored).isDirectory(), true);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'hidden\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
