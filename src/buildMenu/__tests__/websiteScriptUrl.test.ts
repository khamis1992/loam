import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { materialize } from '../materialize.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { createWebsitesPorts } from '../websites/ports.js';

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'website', subtype: 'landing' };
  return {
    workspace,
    jobId: 'job_website_script_url',
    operation: { action: 'package', format: 'web-zip' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'هبوط',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

test('a javascript url in the website dist keeps the previous web zip', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-web-script-'));
  const ports = createWebsitesPorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace: root, title: 'هبوط' });
    const first = await ports.export(context(root), 'web-zip');
    const bytes = fs.readFileSync(path.join(root, first.relativePath));
    fs.appendFileSync(path.join(root, 'app', 'dist', 'index.html'), '<a href="javascript:void(0)">x</a>');
    await assert.rejects(
      ports.export(context(root), 'web-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.readFileSync(path.join(root, first.relativePath)).equals(bytes), true);
    fs.rmSync(path.join(root, 'app', 'dist'), { recursive: true, force: true });
    fs.appendFileSync(path.join(root, 'app', 'preview.html'), '<a href="javascript:void(0)">x</a>');
    await assert.rejects(
      ports.export(context(root), 'web-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.readFileSync(path.join(root, first.relativePath)).equals(bytes), true);
    assert.equal(fs.existsSync(path.join(root, 'app', 'dist', 'index.html')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
