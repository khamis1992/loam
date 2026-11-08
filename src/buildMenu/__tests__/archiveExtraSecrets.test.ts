import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceEntries, writeSourceArtifact } from '../artifacts.js';

const MAX_FILES = 5_000;
const MAX_BYTES = 100_000_000;

function failed(error: unknown): boolean {
  return error instanceof Error && error.message === 'tool_failed';
}

function unsafe(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function writeTree(app: string, files: Array<[string, string | Buffer]>): void {
  for (const [relative, body] of files) {
    const absolute = path.join(app, ...relative.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, body);
  }
}

test('source zip skips extra secret file names anywhere and keeps ordinary files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-archive-extra-'));
  const app = path.join(root, 'app');
  const files: Array<[string, string]> = [
    ['index.html', '<p>محلي</p>'],
    ['keep.txt', 'local-note'],
    ['cookies.txt', 'cookie-list'],
    ['service-accounts.json', '{"note":"plural"}\n'],
    ['my-service-account.json', '{"note":"prefixed"}\n'],
    ['notes/client.ovpn.bak', 'bak-kept'],
    ['notes/Web Data.txt', 'web-note'],
    ['keys/readme.txt', 'key-note'],
    ['gcp/service-account.json', 'gcp-marker'],
    ['deep/Service-Account.JSON', 'gcp-upper'],
    ['browser/Cookies', 'cookie-marker'],
    ['profile/Network/Cookies', 'network-cookie'],
    ['other/cookies', 'cookie-lower'],
    ['browser/Login Data', 'login-marker'],
    ['other/login data', 'login-lower'],
    ['browser/Web Data', 'web-marker'],
    ['case/WEB DATA', 'web-upper'],
    ['keys/id.ppk', 'ppk-marker'],
    ['keys/extra/ID.PPK', 'ppk-upper'],
    ['keys/store.kdbx', 'kdbx-marker'],
    ['keys/extra/Store.KDBX', 'kdbx-upper'],
    ['vpn/office.ovpn', 'ovpn-marker'],
    ['vpn/Home.OVPN', 'ovpn-upper'],
    ['.env', 'dotenv-marker'],
    ['secrets.json', '{"note":"store-a"}\n'],
    ['node_modules/left.js', 'skip-mod'],
    ['cert.p12', 'p12-marker'],
    ['.ssh/id_ed25519', 'home-key'],
  ];
  try {
    writeTree(app, files);
    const entries = sourceEntries(app);
    assert.deepEqual(entries.map((entry) => entry.name).sort(), [
      'cookies.txt',
      'index.html',
      'keep.txt',
      'keys/readme.txt',
      'my-service-account.json',
      'notes/Web Data.txt',
      'notes/client.ovpn.bak',
      'service-accounts.json',
    ]);
    const bundled = entries.map((entry) => entry.data.toString('utf8')).join('\n');
    for (const needle of [
      'gcp-marker', 'gcp-upper', 'cookie-marker', 'network-cookie', 'cookie-lower',
      'login-marker', 'login-lower', 'web-marker', 'web-upper',
      'ppk-marker', 'ppk-upper', 'kdbx-marker', 'kdbx-upper', 'ovpn-marker', 'ovpn-upper',
      'dotenv-marker', 'store-a', 'skip-mod', 'p12-marker', 'home-key',
    ]) {
      assert.equal(bundled.includes(needle), false, needle);
    }
    for (const [relative, body] of files) {
      assert.equal(fs.readFileSync(path.join(app, ...relative.split('/')), 'utf8'), body);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('directory names ending html, js, css, json, or ipynb still throw unsafe_path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-archive-dir-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'index.html'), '<p>محلي</p>');
  try {
    for (const name of ['page.html', 'app.js', 'theme.css', 'meta.json', 'book.ipynb', 'service-account.json']) {
      const dir = path.join(app, name);
      const secret = path.join(dir, 'secret.txt');
      fs.mkdirSync(dir);
      fs.writeFileSync(secret, `stay-${name}`);
      assert.throws(() => sourceEntries(app), unsafe, name);
      assert.equal(fs.readFileSync(secret, 'utf8'), `stay-${name}`);
      assert.equal(fs.readFileSync(path.join(app, 'index.html'), 'utf8'), '<p>محلي</p>');
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(sourceEntries(app).map((entry) => entry.name), ['index.html']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function assertNoPartialZip(root: string, dest: string, partial: string): void {
  assert.equal(fs.existsSync(dest), true);
  assert.deepEqual(fs.readdirSync(dest).sort(), ['partial.zip']);
  assert.equal(fs.readFileSync(partial, 'utf8'), 'not-a-real-zip');
  assert.equal(fs.existsSync(path.join(root, 'app.zip')), false);
  assert.equal(fs.existsSync(`${partial}.tmp`), false);
}

test('a source walk past the file cap throws tool_failed and leaves no zip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-archive-files-'));
  const app = path.join(root, 'app');
  const dest = path.join(root, '.loam', 'build-menu', 'artifacts');
  const partial = path.join(dest, 'partial.zip');
  fs.mkdirSync(app);
  try {
    for (let i = 0; i <= MAX_FILES; i += 1) {
      fs.writeFileSync(path.join(app, `n${i}.txt`), 'x');
    }
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(partial, 'not-a-real-zip');
    assert.throws(() => sourceEntries(app), failed);
    assert.throws(
      () => writeSourceArtifact(root, 'app_abcdefghijkl', 1, 'source-zip'),
      failed,
    );
    assertNoPartialZip(root, dest, partial);
    assert.equal(fs.readFileSync(path.join(app, 'n0.txt'), 'utf8'), 'x');
    assert.equal(fs.readFileSync(path.join(app, `n${MAX_FILES}.txt`), 'utf8'), 'x');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a source walk past the byte cap throws tool_failed and leaves no zip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-archive-bytes-'));
  const app = path.join(root, 'app');
  const dest = path.join(root, '.loam', 'build-menu', 'artifacts');
  const partial = path.join(dest, 'partial.zip');
  const blob = path.join(app, 'blob.bin');
  fs.mkdirSync(app);
  try {
    fs.writeFileSync(path.join(app, 'keep.txt'), 'kept');
    fs.writeFileSync(blob, Buffer.alloc(MAX_BYTES + 1, 1));
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(partial, 'not-a-real-zip');
    assert.throws(
      () => writeSourceArtifact(root, 'app_abcdefghijkl', 1, 'source-zip'),
      failed,
    );
    assertNoPartialZip(root, dest, partial);
    assert.equal(fs.statSync(blob).size, MAX_BYTES + 1);
    assert.equal(fs.readFileSync(path.join(app, 'keep.txt'), 'utf8'), 'kept');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
