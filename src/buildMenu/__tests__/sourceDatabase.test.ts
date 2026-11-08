import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceEntries } from '../artifacts.js';

test('a source archive leaves database files on disk and out of the zip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-source-db-'));
  const app = path.join(root, 'app');
  try {
    fs.mkdirSync(path.join(app, 'data'), { recursive: true });
    fs.writeFileSync(path.join(app, 'index.html'), '<p>صفحة</p>');
    fs.writeFileSync(path.join(app, 'data', 'app.sqlite'), 'local-rows');
    fs.writeFileSync(path.join(app, 'notes.db-wal'), 'wal');
    const names = sourceEntries(app).map((entry) => entry.name);
    assert.deepEqual(names, ['index.html']);
    assert.equal(fs.readFileSync(path.join(app, 'data', 'app.sqlite'), 'utf8'), 'local-rows');
    assert.equal(fs.readFileSync(path.join(app, 'notes.db-wal'), 'utf8'), 'wal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
