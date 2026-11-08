import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { readManifest, saveManifest } from '../manifest.js';

const lock = 'a'.repeat(64);

function stored(revision: number): BuildManifest {
  return {
    schemaVersion: 1,
    projectId: 'app_abcdefghijkl',
    revision,
    selection: { kind: 'website', subtype: 'landing' },
    title: 'موقع',
    sourceDir: 'app',
    template: { id: 'loam-build', revision: '1', lockSha256: lock },
    consent: { autostart: false, publish: false },
  };
}

function isUnsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

test('an existing manifest with nlink greater than 1 is refused before rename', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-manifest-hard-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-manifest-out-'));
  const workspace = path.join(root, 'ws');
  const manifestFile = path.join(workspace, '.loam', 'build-menu', 'manifest.json');
  const outsideFile = path.join(outside, 'outside-bytes.json');
  const previous = Buffer.from(`${JSON.stringify(stored(1), null, 2)}\n`);
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(outsideFile, previous);
  fs.linkSync(outsideFile, manifestFile);
  try {
    const stat = fs.lstatSync(manifestFile);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    const names = fs.readdirSync(path.dirname(manifestFile)).sort();
    assert.deepEqual(names, ['manifest.json']);

    const latest = { ...stored(2), template: { ...stored(1).template, revision: 'LaTeSt' } };
    await assert.rejects(saveManifest(workspace, latest, 1), /invalid_request/);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(manifestFile), previous);

    await assert.rejects(saveManifest(workspace, stored(2), 1), isUnsafePath);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(manifestFile), previous);
    const after = fs.lstatSync(manifestFile);
    assert.equal(after.isSymbolicLink(), false);
    assert.equal(after.isFile(), true);
    assert.equal(after.nlink > 1, true);
    assert.equal(after.ino, fs.lstatSync(outsideFile).ino);
    assert.deepEqual(fs.readdirSync(path.dirname(manifestFile)).sort(), names);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a new manifest and a regular nlink 1 file still save', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-manifest-regular-'));
  const manifestFile = path.join(workspace, '.loam', 'build-menu', 'manifest.json');
  try {
    const created = await saveManifest(workspace, stored(1), 0);
    assert.equal(created.revision, 1);
    const createdStat = fs.lstatSync(manifestFile);
    assert.equal(createdStat.isSymbolicLink(), false);
    assert.equal(createdStat.isFile(), true);
    assert.equal(createdStat.nlink, 1);
    assert.equal(readManifest(workspace)?.revision, 1);

    const replaced = await saveManifest(workspace, stored(2), 1);
    assert.equal(replaced.revision, 2);
    const replacedStat = fs.lstatSync(manifestFile);
    assert.equal(replacedStat.isSymbolicLink(), false);
    assert.equal(replacedStat.isFile(), true);
    assert.equal(replacedStat.nlink, 1);
    assert.equal(readManifest(workspace)?.revision, 2);
    assert.equal(fs.readFileSync(manifestFile, 'utf8').includes('"revision": 2'), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
