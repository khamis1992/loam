import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJobEvidence } from '../evidence.js';
import { BuildMenuError } from '../grants.js';

function refused(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

test('evidence refuses a hard-linked result and still writes a file with nlink 1', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-evidence-nlink-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-evidence-nlink-out-'));
  const outsideFile = path.join(outside, 'secret.txt');
  const target = path.join(root, '.loam', 'build-menu', 'evidence', 'job_link', 'result.json');
  const previous = Buffer.from('outside-bytes');
  fs.writeFileSync(outsideFile, previous);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.linkSync(outsideFile, target);
  try {
    const stat = fs.lstatSync(target);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.throws(
      () => writeJobEvidence(root, 'job_link', { phase: 'completed', summary: 'changed' }),
      refused,
    );
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(target), previous);
    assert.equal(fs.lstatSync(target).nlink > 1, true);
    const normal = path.join(root, '.loam', 'build-menu', 'evidence', 'job_plain', 'result.json');
    writeJobEvidence(root, 'job_plain', { phase: 'completed', summary: 'kept' });
    const written = fs.lstatSync(normal);
    assert.equal(written.isFile(), true);
    assert.equal(written.isSymbolicLink(), false);
    assert.equal(written.nlink, 1);
    assert.match(fs.readFileSync(normal, 'utf8'), /kept/);
    writeJobEvidence(root, 'job_plain', { phase: 'completed', summary: 'rewritten' });
    assert.equal(fs.lstatSync(normal).nlink, 1);
    assert.match(fs.readFileSync(normal, 'utf8'), /rewritten/);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
