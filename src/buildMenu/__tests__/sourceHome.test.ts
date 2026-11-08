import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceEntries } from '../artifacts.js';

test('a source archive leaves home credentials on disk and out of the zip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-source-home-'));
  const app = path.join(root, 'app');
  try {
    fs.mkdirSync(path.join(app, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(app, 'index.html'), '<p>صفحة</p>');
    fs.writeFileSync(path.join(app, '.npmrc'), 'legacy-auth=local-token\n');
    fs.writeFileSync(path.join(app, '.ssh', 'id_ed25519'), 'private-key');
    const names = sourceEntries(app).map((entry) => entry.name);
    assert.deepEqual(names, ['index.html']);
    assert.equal(fs.readFileSync(path.join(app, '.npmrc'), 'utf8'), 'legacy-auth=local-token\n');
    assert.equal(fs.readFileSync(path.join(app, '.ssh', 'id_ed25519'), 'utf8'), 'private-key');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
