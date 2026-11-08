/**
 * Turning the build menu off must leave an existing sidecar in place.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/flagKeepsSidecar.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildMenuEnabled, configureBuildMenu } from '../../server/routes/buildMenu.js';

const SIDECAR = Buffer.from('{"schemaVersion":1,"keep":"flag-sidecar-bytes"}\n');

test('configureBuildMenu(false) keeps the build-menu sidecar and its bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-flag-sidecar-'));
  const dir = path.join(root, '.loam', 'build-menu');
  const file = path.join(dir, 'manifest.json');
  const previous = buildMenuEnabled();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, SIDECAR);
  const before = fs.statSync(file);
  try {
    configureBuildMenu(false);
    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.lstatSync(dir).isDirectory(), true);
    assert.equal(fs.existsSync(file), true);
    assert.deepEqual(fs.readFileSync(file), SIDECAR);

    configureBuildMenu(true);
    configureBuildMenu(false);
    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.lstatSync(dir).isDirectory(), true);
    assert.equal(fs.existsSync(file), true);
    const after = fs.readFileSync(file);
    assert.deepEqual(after, SIDECAR);
    assert.equal(after.equals(SIDECAR), true);
    const stat = fs.statSync(file);
    assert.equal(stat.size, before.size);
    assert.equal(stat.mtimeMs, before.mtimeMs);
    assert.equal(buildMenuEnabled(), false);
  } finally {
    configureBuildMenu(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
