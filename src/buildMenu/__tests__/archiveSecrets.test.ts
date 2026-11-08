import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceEntries } from '../artifacts.js';

test('source zip skips secrets.json, certificate files, private keys, and the loam brief', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-archive-secret-'));
  const app = path.join(root, 'app');
  const files: Array<[string, string]> = [
    ['index.html', '<p>محلي</p>'],
    ['keep.txt', 'local-note'],
    ['not-secrets.json', '{"note":"kept"}\n'],
    ['secrets.json', '{"note":"store-a"}\n'],
    ['nested/secrets.json', '{"note":"store-b"}\n'],
    ['other/SECRETS.JSON', '{"note":"store-c"}\n'],
    ['cert.p12', 'local-p12'],
    ['other/store.P12', 'local-p12-upper'],
    ['cert.pfx', 'local-pfx'],
    ['server.key', 'local-key'],
    ['keys/Server.KEY', 'local-key-upper'],
    ['.loam/brief.txt', 'brief-stays'],
  ];
  try {
    for (const [relative, body] of files) {
      const absolute = path.join(app, ...relative.split('/'));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, body);
    }
    const entries = sourceEntries(app);
    assert.deepEqual(entries.map((entry) => entry.name).sort(), ['index.html', 'keep.txt', 'not-secrets.json']);
    const bundled = entries.map((entry) => entry.data.toString('utf8')).join('\n');
    for (const needle of ['store-a', 'store-b', 'store-c', 'local-p12', 'local-p12-upper', 'local-pfx', 'local-key', 'local-key-upper', 'brief-stays']) {
      assert.equal(bundled.includes(needle), false, needle);
    }
    for (const [relative, body] of files) {
      assert.equal(fs.readFileSync(path.join(app, ...relative.split('/')), 'utf8'), body);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source zip refuses a remote formaction and keeps a local one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-archive-action-'));
  const app = path.join(root, 'app');
  const page = path.join(app, 'index.html');
  const remote = [
    'https://pay.example/checkout',
    'HTTPS://pay.example/checkout',
    'javascript:alert(1)',
    'javascript :alert(1)',
    'data:text/html,hi',
    'file:///c:/secret',
    'blob:null/uuid',
    '//pay.example/checkout',
  ];
  try {
    fs.mkdirSync(app);
    const local = '<button formaction="#stay">ابق</button><form action="#save"></form><a href="./notes.html">ملاحظة</a>';
    fs.writeFileSync(page, local);
    assert.deepEqual(sourceEntries(app).map((entry) => entry.name), ['index.html']);
    assert.equal(sourceEntries(app)[0]?.data.toString('utf8'), local);
    for (const url of remote) {
      const html = `<button type="submit" formaction="${url}">ادفع</button>`;
      fs.writeFileSync(page, html);
      assert.throws(
        () => sourceEntries(app),
        (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
        url,
      );
      assert.equal(fs.readFileSync(page, 'utf8'), html);
    }
    const quoted = "<button formaction='https://pay.example/checkout'>ادفع</button>";
    fs.writeFileSync(page, quoted);
    assert.throws(
      () => sourceEntries(app),
      (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
    );
    const bare = '<button formaction=https://pay.example/checkout>ادفع</button>';
    fs.writeFileSync(page, bare);
    assert.throws(
      () => sourceEntries(app),
      (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
    );
    const relative = '<button formaction="/checkout">ادفع</button><button formaction="./save">احفظ</button>';
    fs.writeFileSync(page, relative);
    assert.deepEqual(sourceEntries(app).map((entry) => entry.name), ['index.html']);
    assert.equal(fs.readFileSync(page, 'utf8'), relative);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
