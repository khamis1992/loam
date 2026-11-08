import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveFile, writeJsonAtomic } = require('../../templates/electron-app/electron/apps/helpers.cjs') as {
  resolveFile: (rootDirectory: string, name: string, extension?: string) => string;
  writeJsonAtomic: (file: string, value: unknown) => void;
};

function isUnsafeLink(error: unknown): boolean {
  return error instanceof Error && error.message === 'Symbolic links are not allowed';
}

test('a hard link with nlink greater than 1 is refused and the outside bytes stay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-helpers-hard-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-helpers-hard-out-'));
  const outsideFile = path.join(outside, 'secret.json');
  const name = 'data.json';
  const destination = path.join(root, name);
  const previous = Buffer.from('outside-secret');
  try {
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, destination);
    const stat = fs.lstatSync(destination);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.throws(() => resolveFile(root, name, '.json'), isUnsafeLink);
    assert.throws(() => writeJsonAtomic(destination, { changed: true }), isUnsafeLink);
    assert.equal(fs.existsSync(`${destination}.${process.pid}.tmp`), false);
    assert.equal(fs.lstatSync(destination).nlink > 1, true);
    assert.deepEqual(fs.readFileSync(destination), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a new file with nlink 1 still saves', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-helpers-save-'));
  const name = 'fresh.json';
  try {
    const destination = resolveFile(root, name, '.json');
    assert.equal(destination, path.resolve(root, name));
    assert.equal(fs.existsSync(destination), false);
    writeJsonAtomic(destination, { ok: true });
    const stat = fs.lstatSync(destination);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), { ok: true });
    assert.equal(resolveFile(root, name, '.json'), destination);
    writeJsonAtomic(destination, { ok: true, next: 1 });
    assert.equal(fs.lstatSync(destination).nlink, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), { ok: true, next: 1 });
    assert.equal(fs.existsSync(`${destination}.${process.pid}.tmp`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
