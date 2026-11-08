import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceEntries } from '../artifacts.js';

test('source zip leaves project secrets and the loam directory on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-zip-secret-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, '.loam', 'build-menu'), { recursive: true });
  fs.writeFileSync(path.join(app, '.loam', 'build-menu', 'kernel-lease.json'), '{"nonce":"0123456789abcdef"}\n');
  fs.writeFileSync(path.join(app, 'credentials.json'), '{"token":"local"}\n');
  fs.writeFileSync(path.join(app, 'signing.pem'), '-----BEGIN KEY-----\n');
  fs.writeFileSync(path.join(app, 'notes.txt'), 'sk-abcdefghijklmnop\n');
  fs.writeFileSync(path.join(app, 'index.html'), '<p>محلي</p>');
  try {
    const entries = sourceEntries(app);
    assert.deepEqual(entries.map((entry) => entry.name), ['index.html']);
    const bundled = entries.map((entry) => entry.data.toString('utf8')).join('\n');
    assert.equal(bundled.includes('sk-abcdefghijklmnop'), false);
    assert.equal(bundled.includes('0123456789abcdef'), false);
    assert.equal(bundled.includes('BEGIN KEY'), false);
    assert.match(fs.readFileSync(path.join(app, 'notes.txt'), 'utf8'), /sk-abcdefghijklmnop/);
    assert.match(fs.readFileSync(path.join(app, '.loam', 'build-menu', 'kernel-lease.json'), 'utf8'), /0123456789abcdef/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
