import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildMenuError } from '../grants.js';
import { portableStatus, requestPortableExeBytes } from '../desktop/portableStatus.js';

function exeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...exeFiles(absolute));
    else if (item.isFile() && item.name.toLowerCase().endsWith('.exe')) found.push(absolute);
  }
  return found;
}

test('portable-exe is unsigned, was not built, and byte requests write no file', () => {
  const status = portableStatus();
  assert.equal(status.format, 'portable-exe');
  assert.equal(status.signed, false);
  assert.equal(status.built, false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-portable-status-'));
  const destination = path.join(root, 'dist', 'Loam-portable.exe');
  try {
    assert.throws(
      () => requestPortableExeBytes(destination),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement' && error.status === 400,
    );
    assert.throws(
      () => requestPortableExeBytes(''),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement' && error.status === 400,
    );
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(path.dirname(destination)), false);
    assert.deepEqual(exeFiles(root), []);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'artifacts')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
