import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { materialize } from '../materialize.js';
import { createMobilePorts } from '../mobile/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { codeTag, readCode } from '../../mobile/versions.js';
import { readMobile } from '../../mobile/store.js';
import { saveSource } from '../../mobile/source.js';

const EDITED = 'android/app/src/main/java/app/loam/generated/MainActivity.kt';

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'mobile' };
  return {
    workspace,
    jobId: 'job_mobile_source_edit',
    operation: { action: 'package', format: 'source-zip' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'جوال',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

test('a mobile source zip keeps the kotlin edit and leaves the sdk path out', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-mobile-edit-'));
  const ports = createMobilePorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'mobile' }, workspace: root, title: 'جوال' });
    const first = await ports.export(context(root), 'source-zip');
    const bytes = fs.readFileSync(path.join(root, first.relativePath));
    let project = readMobile(root);
    assert.ok(project);
    const edited = saveSource(root, EDITED, 'package edited.keep\n', project.revision, codeTag(readCode(root)));
    saveSource(root, 'android/local.properties', 'sdk.dir=C:\\\\Users\\\\secret\\\\Android\\\\Sdk\n', edited.revision, codeTag(readCode(root)));
    const second = await ports.export(context(root), 'source-zip');
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(root, second.relativePath)));
    assert.match(await zip.file(EDITED)!.async('string'), /package edited\.keep/);
    assert.equal(zip.file('android/local.properties'), null);
    assert.match(await zip.file('README.md')!.async('string'), /not an APK/);
    assert.equal(Object.keys(zip.files).some((name) => name.endsWith('.apk')), false);
    assert.equal(fs.readFileSync(path.join(root, first.relativePath)).equals(bytes), true);
    assert.match(JSON.stringify(readCode(root).files), /local\.properties/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
