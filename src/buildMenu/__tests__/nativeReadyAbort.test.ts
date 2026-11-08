import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openNativeLease, waitForReadyFile } from '../nativeStop.js';

test('an already aborted ready wait or a bad nonce resolves false and creates no file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-ready-abort-'));
  const file = path.join(root, 'window-ready');
  const nonce = 'ab'.repeat(16);
  try {
    const aborted = new AbortController();
    aborted.abort();
    const started = Date.now();
    assert.equal(await waitForReadyFile(file, 10_000, aborted.signal, nonce), false);
    assert.equal(Date.now() - started < 1_000, true);
    assert.equal(fs.existsSync(file), false);

    const rejected = ['A'.repeat(32), 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), `${nonce}\n`, ''];
    for (const value of rejected) {
      const marked = Date.now();
      assert.equal(await waitForReadyFile(file, 10_000, new AbortController().signal, value), false);
      assert.equal(Date.now() - marked < 1_000, true);
    }
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(fs.readdirSync(root), []);

    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { pid: 4242 });
    const lease = openNativeLease('native_abort', child, false);
    assert.equal(Object.hasOwn(lease, 'pid'), false);
    assert.equal(Object.hasOwn(lease, 'messageNonce'), false);
    assert.equal(lease.child, child);
    assert.equal(lease.stopped, false);
    assert.match(lease.spawnNonce, /^[a-f0-9]{32}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
