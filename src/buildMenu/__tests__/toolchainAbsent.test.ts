import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { absentRequirements, findElectron, nodeSupported } from '../toolchain.js';

const SHELL_NAMES = ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe', 'sh.exe', 'cmd', 'powershell', 'pwsh', 'bash', 'sh'];

test('win32 absentRequirements still lists python-container and macos-xcode', () => {
  assert.deepEqual(
    absentRequirements(['python-container', 'macos-xcode'], 'win32'),
    ['python-container', 'macos-xcode'],
  );
});

test('nodeSupported is false for version 22 and true for version 24', () => {
  assert.equal(nodeSupported('22.0.0'), false);
  assert.equal(nodeSupported('24.5.0'), true);
});

test('findElectron does not return a shell name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-toolchain-absent-'));
  try {
    const dist = path.join(root, 'node_modules', 'electron', 'dist');
    fs.mkdirSync(dist, { recursive: true });
    for (const name of SHELL_NAMES) fs.writeFileSync(path.join(dist, name), '');
    const found = findElectron(root);
    const base = found === null ? '' : path.basename(found).toLowerCase();
    assert.equal(SHELL_NAMES.includes(base), false);
    assert.equal(found, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
