import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { createMobilePorts } from '../mobile/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';

function apkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...apkFiles(absolute));
    else if (item.isFile() && item.name.toLowerCase().endsWith('.apk')) found.push(absolute);
  }
  return found;
}

function refusedApk(error: unknown): boolean {
  if (error instanceof BuildMenuError) {
    return (error.message === 'missing_requirement' || error.message === 'not_an_apk') && error.status === 400;
  }
  return error instanceof Error && (error.message === 'missing_requirement' || error.message === 'not_an_apk');
}

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'mobile' };
  return {
    workspace,
    jobId: 'job_mobile_apk',
    operation: { action: 'package', format: 'apk-debug' },
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

test('mobile apk export throws before Gradle and writes no apk bytes', async () => {
  const source = fs.readFileSync(path.resolve('src/buildMenu/mobile/ports.ts'), 'utf8');
  const gate = source.indexOf("format === 'apk-debug'");
  const block = source.indexOf('throw new BuildMenuError(', gate);
  const delegate = source.indexOf('ports.export(', gate);
  assert.equal(gate >= 0 && block > gate && delegate > block, true);
  assert.match(source.slice(block, delegate), /missing_requirement|not_an_apk/);
  assert.equal(/gradle|assembleDebug|startAndroidBuild|\bspawn\b/.test(source), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-mobile-port-apk-'));
  const ports = createMobilePorts({ leases: new ProcessLeaseRegistry(200) });
  const ctx = context(root);
  try {
    await ports.scaffold(ctx);
    await assert.rejects(ports.export(ctx, 'apk-debug'), refusedApk);
    assert.deepEqual(apkFiles(root), []);
    assert.equal(fs.existsSync(path.join(root, '.loam', 'android')), false);
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'artifacts')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mobile executeCell throws unsupported_operation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-mobile-port-cell-'));
  const ports = createMobilePorts({ leases: new ProcessLeaseRegistry(200) });
  const ctx = context(root);
  const cell: BuildJobContext = { ...ctx, operation: { action: 'kernel-execute', cellId: 'cell-1' } };
  try {
    await assert.rejects(
      ports.executeCell(cell, 'cell-1'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsupported_operation' && error.status === 400,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
