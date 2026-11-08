import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { readManifest, saveManifest } from '../manifest.js';

const lock = 'a'.repeat(64);

function manifest(revision: number): BuildManifest {
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

test('legacy read does not create a directory', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-build-'));
  assert.equal(readManifest(workspace), null);
  assert.equal(fs.existsSync(path.join(workspace, '.loam')), false);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('revision advances once and a stale parallel save loses', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-build-'));
  const workspace = path.join(root, 'ws');
  const sentinel = path.join(root, 'sentinel.txt');
  fs.mkdirSync(workspace);
  fs.writeFileSync(sentinel, 'keep');
  const first = await saveManifest(workspace, manifest(1), 0);
  assert.equal(first.revision, 1);
  const race = await Promise.allSettled([
    saveManifest(workspace, manifest(2), 1),
    saveManifest(workspace, manifest(2), 1),
  ]);
  assert.equal(race.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(race.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(readManifest(workspace)?.revision, 2);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a stopping job in the same workspace rejects the manifest save with busy 409', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-build-stopping-'));
  const workspace = path.join(root, 'busy');
  const other = path.join(root, 'free');
  fs.mkdirSync(workspace);
  fs.mkdirSync(other);
  try {
    await saveManifest(workspace, manifest(1), 0);
    const manifestFile = path.join(workspace, '.loam', 'build-menu', 'manifest.json');
    const before = fs.readFileSync(manifestFile, 'utf8');
    const dir = path.dirname(manifestFile);
    fs.writeFileSync(path.join(dir, 'active-job.json'), `${JSON.stringify({
      schemaVersion: 1,
      jobId: 'job_stopping',
      projectId: 'app_abcdefghijkl',
      revision: 1,
      kind: 'website',
      action: 'preview',
      phase: 'stopping',
    })}\n`);
    await assert.rejects(
      saveManifest(workspace, manifest(2), 1),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'busy' && error.status === 409,
    );
    assert.equal(fs.readFileSync(manifestFile, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['active-job.json', 'manifest.json']);
    const saved = await saveManifest(other, { ...manifest(1), projectId: 'app_bbcdefghijkl', title: 'آخر' }, 0);
    assert.equal(saved.revision, 1);
    assert.equal(readManifest(other)?.projectId, 'app_bbcdefghijkl');
    assert.equal(readManifest(workspace)?.revision, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a template revision named latest is rejected before it is written', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-build-latest-'));
  const stored = { ...manifest(1), template: { ...manifest(1).template, revision: 'latest' } };
  try {
    await assert.rejects(saveManifest(workspace, stored, 0), /invalid_request/);
    assert.equal(fs.existsSync(path.join(workspace, '.loam', 'build-menu', 'manifest.json')), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('an unknown manifest version is rejected', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-build-'));
  const file = path.join(workspace, '.loam', 'build-menu', 'manifest.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...manifest(1), schemaVersion: 2 }));
  assert.throws(() => readManifest(workspace), /invalid_request/);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('bad manifest and a linked sidecar are rejected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-build-'));
  const workspace = path.join(root, 'ws');
  const sentinel = path.join(root, 'sentinel.txt');
  fs.mkdirSync(workspace);
  fs.writeFileSync(sentinel, 'keep');
  const bad = { ...manifest(1), command: 'cmd', consent: { autostart: false, publish: true } };
  await assert.rejects(saveManifest(workspace, bad as BuildManifest, 0), /invalid_request/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(workspace, '.loam'));
  fs.symlinkSync(outside, path.join(workspace, '.loam', 'build-menu'), 'junction');
  await assert.rejects(saveManifest(workspace, manifest(1), 0), /unsafe_path/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  fs.rmSync(root, { recursive: true, force: true });
});
