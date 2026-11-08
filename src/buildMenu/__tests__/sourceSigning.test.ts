import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceEntries } from '../artifacts.js';

test('a source archive leaves signing files on disk and out of the zip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-source-sign-'));
  const app = path.join(root, 'app');
  try {
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'index.html'), '<p>صفحة</p>');
    fs.writeFileSync(path.join(app, 'release.keystore'), 'signing-key');
    fs.writeFileSync(path.join(app, 'google-services.json'), '{"project_id":"local"}\n');
    fs.writeFileSync(path.join(app, 'local.properties'), 'sdk.dir=C:\\\\secret\n');
    const names = sourceEntries(app).map((entry) => entry.name);
    assert.deepEqual(names, ['index.html']);
    assert.equal(fs.readFileSync(path.join(app, 'release.keystore'), 'utf8'), 'signing-key');
    assert.equal(fs.readFileSync(path.join(app, 'google-services.json'), 'utf8').includes('local'), true);
    assert.equal(fs.readFileSync(path.join(app, 'local.properties'), 'utf8').includes('sdk.dir'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
