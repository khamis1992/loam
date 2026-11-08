import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { createChromePorts } from '../chrome/ports.js';
import { BuildMenuError } from '../grants.js';
import { materialize } from '../materialize.js';
import { ProcessLeaseRegistry } from '../processLease.js';

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'chrome-extension' };
  return {
    workspace,
    jobId: 'job_chrome_script_url',
    operation: { action: 'package', format: 'mv3-zip' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'ملاحظة',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

test('a javascript url in the chrome popup keeps the previous extension zip', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-chrome-script-'));
  const ports = createChromePorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'chrome-extension' }, workspace: root, title: 'ملاحظة' });
    const first = await ports.export(context(root), 'mv3-zip');
    const bytes = fs.readFileSync(path.join(root, first.relativePath));
    fs.appendFileSync(path.join(root, 'app', 'popup.html'), '<a href="javascript:void(0)">x</a>');
    await assert.rejects(
      ports.export(context(root), 'mv3-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.readFileSync(path.join(root, first.relativePath)).equals(bytes), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
