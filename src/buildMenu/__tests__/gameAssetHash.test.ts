import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { materialize } from '../materialize.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { createGamesPorts } from '../games/ports.js';

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'game' };
  return {
    workspace,
    jobId: 'job_game_asset_hash',
    operation: { action: 'package', format: 'web-zip' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'لعبة',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

test('a changed game file keeps the previous zip when its asset hash no longer matches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-hash-'));
  const ports = createGamesPorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'game' }, workspace: root, title: 'لعبة' });
    const first = await ports.export(context(root), 'web-zip');
    const bytes = fs.readFileSync(path.join(root, first.relativePath));
    fs.appendFileSync(path.join(root, 'app', 'index.html'), '<!-- local -->');
    await assert.rejects(
      ports.export(context(root), 'web-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    const manifestPath = path.join(root, 'app', 'assets', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { assets: { source: string }[] };
    manifest.assets[0]!.source = 'remote';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    fs.writeFileSync(path.join(root, 'app', 'index.html'), fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8').replace('<!-- local -->', ''));
    await assert.rejects(
      ports.export(context(root), 'web-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.readFileSync(path.join(root, first.relativePath)).equals(bytes), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
