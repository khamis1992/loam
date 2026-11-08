import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { saveManifest } from '../manifest.js';

const lock = 'a'.repeat(64);

function validManifest(): BuildManifest {
  return {
    schemaVersion: 1,
    projectId: 'app_abcdefghijkl',
    revision: 1,
    selection: { kind: 'website', subtype: 'landing' },
    title: 'موقع',
    sourceDir: 'app',
    template: { id: 'loam-build', revision: '1', lockSha256: lock },
    consent: { autostart: false, publish: false },
  };
}

function filesBesideWorkspace(workspace: string): string[] {
  const parent = path.dirname(workspace);
  const base = path.basename(workspace);
  return fs.readdirSync(parent)
    .filter((name) => name !== base && (name.startsWith(`${base}.`) || name.startsWith(`${base}-`)))
    .sort();
}

test('rejected saves leave the outside sentinel bytes unchanged', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-manifest-sentinel-'));
  const sentinel = path.join(path.dirname(workspace), `${path.basename(workspace)}.sentinel`);
  const sentinelBytes = Buffer.from('keep-sentinel');
  fs.writeFileSync(sentinel, sentinelBytes);
  const beside = filesBesideWorkspace(workspace);
  assert.deepEqual(beside, [path.basename(sentinel)]);
  assert.equal(path.relative(workspace, sentinel).startsWith('..'), true);

  const base = validManifest();
  const rejected: Array<{ label: string; manifest: BuildManifest }> = [
    {
      label: 'bad kind',
      manifest: { ...base, selection: { kind: 'shell' } } as BuildManifest,
    },
    ...['latest', 'LATEST', 'Latest', 'LaTeSt'].map((revision) => ({
      label: `revision ${revision}`,
      manifest: { ...base, template: { ...base.template, revision } },
    })),
    {
      label: 'extra key command',
      manifest: { ...base, command: 'cmd' } as BuildManifest,
    },
    {
      label: 'publish true',
      manifest: { ...base, consent: { autostart: false, publish: true } } as BuildManifest,
    },
  ];

  try {
    for (const item of rejected) {
      await assert.rejects(saveManifest(workspace, item.manifest, 0), /invalid_request/, item.label);
      assert.equal(Buffer.compare(fs.readFileSync(sentinel), sentinelBytes), 0, item.label);
      assert.deepEqual(filesBesideWorkspace(workspace), beside, item.label);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  assert.equal(fs.existsSync(workspace), false);
  assert.equal(Buffer.compare(fs.readFileSync(sentinel), sentinelBytes), 0);
  assert.deepEqual(filesBesideWorkspace(workspace), [path.basename(sentinel)]);
});
