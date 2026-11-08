import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildMenuError } from '../grants.js';
import { writeAtomicFile, writeBytesArtifact } from '../artifacts.js';

test('a hard-linked artifact target is rejected before rename', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-artifact-nlink-'));
  const outside = path.join(root, 'outside', 'secret.bin');
  const target = path.join(root, 'artifacts', 'art.zip');
  const previous = Buffer.from('outside-bytes');
  const incoming = Buffer.from('PK\x03\x04partial-zip');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(outside, previous);
  fs.linkSync(outside, target);
  try {
    const stat = fs.lstatSync(target);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(fs.lstatSync(outside).isSymbolicLink(), false);
    assert.throws(
      () => writeAtomicFile(target, incoming),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.deepEqual(fs.readFileSync(outside), previous);
    assert.deepEqual(fs.readFileSync(target), previous);
    assert.equal(fs.lstatSync(target).nlink > 1, true);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    assert.equal(fs.existsSync(`${target}.tmp`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a new artifact path with no hard link still writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-artifact-fresh-'));
  const bytes = Buffer.from('PK\x03\x04fresh-zip');
  try {
    const artifact = writeBytesArtifact(root, 'app_abcdefghijkl', 1, 'source-zip', bytes, 'zip');
    const file = path.join(root, artifact.relativePath);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    const meta = path.join(root, '.loam', 'build-menu', 'artifacts', `${artifact.artifactId}.json`);
    assert.equal(fs.lstatSync(meta).nlink, 1);
    assert.equal(fs.existsSync(`${meta}.tmp`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('EPERM from the final target stat is rethrown and the bytes stay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-artifact-eperm-'));
  const target = path.join(root, 'art.zip');
  const previous = Buffer.from('kept-bytes');
  const incoming = Buffer.from('PK\x03\x04next-zip');
  fs.writeFileSync(target, previous);
  const realLstatSync = fs.lstatSync;
  const resolvedTarget = path.resolve(target);
  const temp = `${target}.tmp`;
  let allowedFinalStat = false;
  fs.lstatSync = ((file: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (path.resolve(String(file)) !== resolvedTarget) return realLstatSync(file, options);
    const tempReady = fs.existsSync(temp) && realLstatSync(temp).size === incoming.length;
    if (tempReady) {
      if (allowedFinalStat) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      allowedFinalStat = true;
    }
    return realLstatSync(file, options);
  }) as typeof fs.lstatSync;
  try {
    assert.throws(
      () => writeAtomicFile(target, incoming),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EPERM',
    );
    assert.deepEqual(fs.readFileSync(target), previous);
    assert.equal(realLstatSync(target).isSymbolicLink(), false);
    assert.equal(realLstatSync(target).nlink, 1);
    assert.equal(fs.existsSync(temp), false);
  } finally {
    fs.lstatSync = realLstatSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
