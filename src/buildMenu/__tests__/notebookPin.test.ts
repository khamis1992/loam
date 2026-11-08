import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const pinPath = path.resolve('src/buildMenu/notebooks/python/image-pin.json');
const fakeReady = new Set(['ready', 'approved', 'pinned', 'present', 'resolved']);

test('the notebook image pin digest is null and the status is not a ready pin', () => {
  const text = fs.readFileSync(pinPath, 'utf8');
  const pin = JSON.parse(text) as { status?: unknown; digest?: unknown };
  assert.equal(pin.digest, null);
  assert.equal(pin.status, 'unresolved');
  assert.equal(fakeReady.has(String(pin.status)), false);
  assert.equal(/[a-f0-9]{64}/i.test(text), false);
});
