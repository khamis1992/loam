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

function insideRoot(root: string, target: string): boolean {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

test('a hard link inside the app root is rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-nav-hard-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-nav-hard-out-'));
  const page = path.join(root, 'dist', 'index.html');
  const extra = path.join(outside, 'secret.html');
  fs.mkdirSync(path.dirname(page), { recursive: true });
  try {
    fs.writeFileSync(extra, 'secret');
    fs.linkSync(extra, page);
    const stat = fs.lstatSync(page);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(insideRoot(root, page), true);
    assert.equal(fs.readFileSync(page).toString(), 'secret');
    assert.equal(allowNavigation(pathToFileURL(page).href, root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('https, javascript, mailto, and a regular file keep their results', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-nav-hard-file-'));
  const page = path.join(root, 'dist', 'index.html');
  fs.mkdirSync(path.dirname(page), { recursive: true });
  try {
    fs.writeFileSync(page, '<p>local</p>');
    const stat = fs.lstatSync(page);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.equal(allowNavigation(pathToFileURL(page).href, root), true);
    assert.equal(allowNavigation('https://example.test/page', root), false);
    assert.equal(allowNavigation('javascript:alert(1)', root), false);
    assert.equal(allowNavigation('mailto:user@example.test', root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lstat EPERM is not swallowed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-nav-hard-eperm-'));
  const page = path.join(root, 'dist', 'index.html');
  fs.mkdirSync(path.dirname(page), { recursive: true });
  fs.writeFileSync(page, '<p>local</p>');
  const realLstatSync = fs.lstatSync;
  const patched = (() => {
    const error = new Error('operation not permitted') as NodeJS.ErrnoException;
    error.code = 'EPERM';
    throw error;
  }) as typeof fs.lstatSync;
  Object.defineProperty(fs, 'lstatSync', { value: patched });
  try {
    assert.throws(
      () => allowNavigation(pathToFileURL(page).href, root),
      (error: unknown) => Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EPERM'),
    );
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
