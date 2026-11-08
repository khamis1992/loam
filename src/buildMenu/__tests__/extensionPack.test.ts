import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { createChromePorts } from '../chrome/ports.js';
import { materialize } from '../materialize.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { extractZip } from '../../preview/zip.js';

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'chrome-extension' };
  return {
    workspace,
    jobId: 'job_chrome_pack',
    operation: { action: 'package', format: 'source-zip' },
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

test('a chrome source zip keeps extension files and leaves profile data out', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-ext-pack-'));
  const ports = createChromePorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'chrome-extension' }, workspace: root, title: 'ملاحظة' });
    const first = await ports.export(context(root), 'source-zip');
    const bytes = fs.readFileSync(path.join(root, first.relativePath));
    const profile = path.join(root, 'app', 'Default');
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'Cookies'), 'profile-cookie');
    fs.writeFileSync(path.join(root, 'app', 'package.json'), '{"name":"repo"}\n');
    const second = await ports.export(context(root), 'source-zip');
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-ext-unpack-'));
    try {
      const names = extractZip(fs.readFileSync(path.join(root, second.relativePath)), dest).sort();
      assert.deepEqual(names, ['manifest.json', 'popup.html', 'popup.js']);
      assert.equal(fs.readFileSync(path.join(dest, 'popup.js'), 'utf8').includes('profile-cookie'), false);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    assert.equal(fs.readFileSync(path.join(root, first.relativePath)).equals(bytes), true);
    assert.equal(fs.readFileSync(path.join(profile, 'Cookies'), 'utf8'), 'profile-cookie');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
