import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { allowNavigation } = require('../../templates/electron-app/electron/navigation.cjs') as {
  allowNavigation: (url: string, appRoot: string, realpath?: (target: string) => string) => boolean;
};

const REMOTE = [
  'https://example.test/page',
  'http://example.test/page',
  'javascript:alert(1)',
  'mailto:user@example.test',
  'tel:+97455500000',
  'intent://scan/#Intent;end',
  'market://details?id=com.example.app',
  'data:text/html,hi',
  'blob:null/uuid',
] as const;

test('a file URL inside the app root is accepted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-nav-local-'));
  const page = path.join(root, 'dist', 'index.html');
  const realpath = (target: string) => path.resolve(target);
  try {
    assert.equal(allowNavigation(pathToFileURL(page).href, root, realpath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a file URL that escapes the app root is rejected, including a fake realpath', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-nav-local-'));
  const page = path.join(root, 'dist', 'index.html');
  const outside = path.join(path.dirname(root), 'loam-nav-outside.html');
  const asResolved = (target: string) => path.resolve(target);
  const escapedLink = (target: string) => (path.resolve(target) === path.resolve(page) ? outside : path.resolve(target));
  try {
    assert.equal(allowNavigation(pathToFileURL(outside).href, root, asResolved), false);
    assert.equal(allowNavigation(pathToFileURL(path.resolve(root, '..', 'loam-nav-parent.html')).href, root, asResolved), false);
    assert.equal(allowNavigation(new URL('../../secret.html', pathToFileURL(page)).href, root, asResolved), false);
    assert.equal(allowNavigation(pathToFileURL(page).href, root, escapedLink), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('https, http, javascript, mailto, tel, intent, market, data, and blob are rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-nav-local-'));
  const page = path.join(root, 'dist', 'index.html');
  const realpath = () => page;
  try {
    for (const url of REMOTE) {
      assert.equal(allowNavigation(url, root, realpath), false, url);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
