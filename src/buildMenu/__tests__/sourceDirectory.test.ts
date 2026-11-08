import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceEntries } from '../artifacts.js';

test('a directory named page.html is not walked and assets still pack', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-source-dir-'));
  const app = path.join(root, 'app');
  const secret = path.join(app, 'page.html', 'secret.txt');
  try {
    fs.mkdirSync(path.join(app, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(app, 'assets', 'hero.txt'), 'hero');
    fs.writeFileSync(path.join(app, 'note.html'), '<p>محلي</p>');
    fs.writeFileSync(path.join(app, 'app.js'), 'const local = 1;\n');
    fs.writeFileSync(path.join(app, 'theme.css'), 'body { color: black; }\n');
    fs.writeFileSync(path.join(app, 'meta.json'), '{"local":true}\n');
    const packed = sourceEntries(app);
    assert.deepEqual(packed.map((entry) => entry.name).sort(), ['app.js', 'assets/hero.txt', 'meta.json', 'note.html', 'theme.css']);
    assert.equal(packed.find((entry) => entry.name === 'assets/hero.txt')?.data.toString('utf8'), 'hero');
    fs.mkdirSync(path.join(app, 'page.html'));
    fs.writeFileSync(secret, 'secret');
    const before = fs.readFileSync(secret);
    assert.throws(
      () => sourceEntries(app),
      (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
    );
    assert.equal(fs.readFileSync(secret).equals(before), true);
    assert.equal(fs.existsSync(path.join(app, 'index.html')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
