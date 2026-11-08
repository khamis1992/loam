import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest, BuildOperation, DriverPorts, Requirement } from '../../../packages/shared/src/buildMenu.js';
import { bindDriver } from '../bindDriver.js';
import { BuildMenuError } from '../grants.js';
import { materialize } from '../materialize.js';
import { mobileProfile } from '../mobile/profile.js';
import { notebookProfile } from '../notebooks/profile.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { createSafariPorts } from '../safari/ports.js';
import { safariProfile } from '../safari/profile.js';

function context(selection: BuildManifest['selection'], operation: BuildOperation, workspace = '/test-owned'): BuildJobContext {
  return {
    workspace,
    jobId: 'job-bind-mismatch',
    signal: new AbortController().signal,
    operation,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_aaaaaaaaaaaa',
      revision: 1,
      selection,
      title: 'test',
      sourceDir: 'app',
      template: { id: 'fixture', revision: 'test', lockSha256: '0'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

function recordingPorts(calls: string[]): DriverPorts {
  return {
    missing: async (_ctx, requirements) => {
      calls.push(`missing:${requirements.join(',')}`);
      return requirements;
    },
    scaffold: async () => { calls.push('scaffold'); },
    preview: async () => { calls.push('preview'); return { kind: 'none' }; },
    export: async () => {
      calls.push('export');
      return {
        artifactId: 'art_bind_mismatch',
        projectId: 'app_aaaaaaaaaaaa',
        revision: 1,
        format: 'source-zip',
        relativePath: 'artifacts/source.zip',
        sha256: 'ab'.repeat(32),
        bytes: 1,
      };
    },
    executeCell: async () => { calls.push('executeCell'); },
    stop: async () => { calls.push('stop'); },
  };
}

test('a grant whose operation does not match the called method is rejected before the port runs', async () => {
  const calls: string[] = [];
  const ports = recordingPorts(calls);
  const notebook = bindDriver(notebookProfile, ports);
  const safari = bindDriver(safariProfile, ports);
  const notebookKind: BuildManifest['selection'] = { kind: 'notebook' };
  const safariKind: BuildManifest['selection'] = { kind: 'safari-extension' };

  await assert.rejects(notebook.preview(context(notebookKind, { action: 'package', format: 'source-zip' })), /operation_mismatch/);
  await assert.rejects(notebook.scaffold(context(notebookKind, { action: 'preview' })), /operation_mismatch/);
  await assert.rejects(notebook.export(context(notebookKind, { action: 'preview' }), 'source-zip'), /operation_mismatch/);
  await assert.rejects(notebook.export(context(notebookKind, { action: 'package', format: 'ipynb' }), 'source-zip'), /operation_mismatch/);
  await assert.rejects(notebook.executeCell(context(notebookKind, { action: 'preview' }), 'cell-1'), /unsupported_operation/);
  await assert.rejects(notebook.executeCell(context(notebookKind, { action: 'kernel-execute', cellId: 'other' }), 'cell-1'), /unsupported_operation/);
  await assert.rejects(safari.preview(context(safariKind, { action: 'package', format: 'xcode-source' })), /operation_mismatch/);
  await assert.rejects(safari.export(context(safariKind, { action: 'preview' }), 'xcode-source'), /operation_mismatch/);
  assert.deepEqual(calls, []);

  await notebook.scaffold(context(notebookKind, { action: 'generate' }));
  await notebook.preview(context(notebookKind, { action: 'preview' }));
  await notebook.export(context(notebookKind, { action: 'package', format: 'source-zip' }), 'source-zip');
  await notebook.executeCell(context(notebookKind, { action: 'kernel-execute', cellId: 'cell-1' }), 'cell-1');
  assert.deepEqual(calls, ['scaffold', 'preview', 'export', 'executeCell']);
});

test('source export does not require Python, an Android SDK, or Xcode', async () => {
  const seen: Requirement[][] = [];
  const ports = recordingPorts([]);
  ports.missing = async (_ctx, requirements) => {
    seen.push([...requirements]);
    return requirements;
  };
  const notebook = bindDriver(notebookProfile, ports);
  const mobile = bindDriver(mobileProfile, ports);
  const safari = bindDriver(safariProfile, ports);
  const notebookKind: BuildManifest['selection'] = { kind: 'notebook' };
  const mobileKind: BuildManifest['selection'] = { kind: 'mobile' };
  const safariKind: BuildManifest['selection'] = { kind: 'safari-extension' };

  assert.deepEqual(await notebook.preflight(context(notebookKind, { action: 'package', format: 'source-zip' })), []);
  assert.deepEqual(await notebook.preflight(context(notebookKind, { action: 'package', format: 'ipynb' })), []);
  assert.deepEqual(await mobile.preflight(context(mobileKind, { action: 'package', format: 'source-zip' })), []);
  assert.deepEqual(await safari.preflight(context(safariKind, { action: 'package', format: 'source-zip' })), []);
  assert.equal(seen.some((requirements) => requirements.includes('python-container') || requirements.includes('android-sdk') || requirements.includes('macos-xcode')), false);

  assert.deepEqual(await notebook.preflight(context(notebookKind, { action: 'kernel-execute', cellId: 'cell-1' })), ['python-container']);
  assert.deepEqual(await mobile.preflight(context(mobileKind, { action: 'package', format: 'apk-debug' })), ['node', 'android-sdk']);
  assert.deepEqual(await safari.preflight(context(safariKind, { action: 'package', format: 'xcode-source' })), ['macos-xcode']);
});

test('xcode-source on win32 stays unsupported even if source files exist', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-bind-xcode-'));
  const ports = createSafariPorts({ leases: new ProcessLeaseRegistry(200) });
  const driver = bindDriver(safariProfile, ports);
  try {
    materialize({ selection: { kind: 'safari-extension' }, workspace: root, title: 'ملاحظة' });
    const popup = path.join(root, 'app', 'popup.js');
    const conversion = path.join(root, 'app', 'conversion.json');
    assert.equal(fs.existsSync(popup), true);
    assert.equal(fs.existsSync(conversion), true);
    const ctx = context({ kind: 'safari-extension' }, { action: 'package', format: 'xcode-source' }, root);
    const expected = process.platform === 'darwin' ? 'missing_requirement' : 'unsupported_platform';
    await assert.rejects(
      driver.export(ctx, 'xcode-source'),
      (error: unknown) => error instanceof BuildMenuError && error.message === expected && error.status === 400,
    );
    assert.equal(fs.readFileSync(popup, 'utf8').length > 0, true);
    assert.equal(fs.existsSync(conversion), true);
    const names = fs.readdirSync(path.join(root, 'app'));
    assert.equal(names.some((name) => name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
