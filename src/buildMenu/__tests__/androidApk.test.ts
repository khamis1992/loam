import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { androidEnvironment } from '../../mobile/android/build.js';
import { resolveArtifact } from '../artifacts.js';
import { materialize } from '../materialize.js';
import { BuildMenuError } from '../grants.js';
import { apkBlockReason, assertPackedMobile } from '../mobile/apk.js';
import { readMobile, touchMobile } from '../../mobile/store.js';
import { createMobilePorts } from '../mobile/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';

test('an incomplete Android toolchain blocks the apk before Gradle starts', () => {
  assert.equal(apkBlockReason([{ ready: false }, { ready: true }]), 'missing_requirement');
  assert.equal(apkBlockReason([{ ready: true }]), null);
});

test('a mobile revision change during packaging is stale and writes nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-apk-rev-'));
  try {
    materialize({ selection: { kind: 'mobile' }, workspace: root, title: 'جوال' });
    const before = readMobile(root);
    assert.ok(before);
    touchMobile(root, before.revision, 'edit');
    assert.throws(
      () => assertPackedMobile(root, before.revision),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'stale_revision' && error.status === 409,
    );
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'artifacts')), false);
    const after = readMobile(root);
    assert.ok(after);
    assert.equal(after.revision, before.revision + 1);
    assertPackedMobile(root, after.revision);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a ready Android toolchain packages a debug apk', { timeout: 720_000 }, async () => {
  const environment = androidEnvironment();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-apk-'));
  const ports = createMobilePorts({ leases: new ProcessLeaseRegistry(500) });
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: 'job_mobile-apk',
    operation: { action: 'package', format: 'apk-debug' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection: { kind: 'mobile' } satisfies BuildManifest['selection'],
      title: 'الرئيسية',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
  try {
    materialize({ selection: ctx.manifest.selection, workspace: root, title: ctx.manifest.title });
    if (!environment.ready) {
      await assert.rejects(ports.export(ctx, 'apk-debug'), /missing_requirement/);
      return;
    }
    const artifact = await ports.export(ctx, 'apk-debug');
    const saved = resolveArtifact(root, ctx.manifest.projectId, artifact.artifactId);
    assert.equal(artifact.format, 'apk-debug');
    assert.equal(saved.bytes.length, artifact.bytes);
    assert.ok(saved.bytes.length > 10_000);
    assert.equal(saved.bytes.subarray(0, 2).toString('utf8'), 'PK');
  } catch (error) {
    const log = latestLog(root);
    if (log) console.error(log.slice(-4_000));
    throw error;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function latestLog(root: string): string {
  const builds = path.join(root, '.loam', 'android', 'builds');
  if (!fs.existsSync(builds)) return '';
  const logs = fs.readdirSync(builds).map((id) => path.join(builds, id, 'build.log')).filter((file) => fs.existsSync(file));
  const file = logs.at(-1);
  return file ? fs.readFileSync(file, 'utf8') : '';
}
