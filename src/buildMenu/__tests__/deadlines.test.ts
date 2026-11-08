import test from 'node:test';
import assert from 'node:assert/strict';
import type { BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { DESKTOP_READY_MS, jobBudget, KERNEL_TIMEOUT_MS, PACKAGE_TIMEOUT_MS, previewReadyMs, WEB_READY_MS } from '../deadlines.js';
import { issueGrant, resetGrants } from '../grants.js';
import { configurePackageTimeout, noteReady, readJob, resetJobs, startJob } from '../jobs.js';

const manifest: BuildManifest = {
  schemaVersion: 1,
  projectId: 'app_abcdefghijkl',
  revision: 1,
  selection: { kind: 'website', subtype: 'landing' },
  title: 'موقع',
  sourceDir: 'app',
  template: { id: 'loam-build', revision: '1', lockSha256: 'a'.repeat(64) },
  consent: { autostart: false, publish: false },
};

test('preview, kernel, and package deadlines match the plan', () => {
  assert.equal(WEB_READY_MS, 30_000);
  assert.equal(DESKTOP_READY_MS, 60_000);
  assert.equal(KERNEL_TIMEOUT_MS, 30_000);
  assert.equal(PACKAGE_TIMEOUT_MS, 15 * 60 * 1000);
  for (const kind of ['website', 'game', 'notebook', 'mobile', 'chrome-extension', 'safari-extension', 'automation'] as const) {
    assert.equal(previewReadyMs(kind), 30_000);
    assert.equal(jobBudget(kind, 'preview'), 30_000);
  }
  assert.equal(previewReadyMs('desktop'), 60_000);
  assert.equal(previewReadyMs('widget'), 60_000);
  assert.equal(jobBudget('desktop', 'preview'), 60_000);
  assert.equal(jobBudget('notebook', 'kernel-execute'), 30_000);
  assert.equal(jobBudget('website', 'package'), 15 * 60 * 1000);
});

test('a package past its deadline is cancelled and a late finish stays cancelled', async () => {
  configurePackageTimeout(30);
  resetGrants();
  resetJobs();
  try {
    const packageGrant = issueGrant({
      projectId: manifest.projectId,
      revision: 1,
      planSha256: 'b'.repeat(64),
      operation: { action: 'package', format: 'source-zip' },
      sessionId: 'session-a',
      expiresAt: Date.now() + 60_000,
    });
    const packaged = startJob({
      projectId: manifest.projectId,
      expectedRevision: 1,
      operation: { action: 'package', format: 'source-zip' },
      planSha256: 'b'.repeat(64),
      grantId: packageGrant,
      idempotencyKey: 'pack-deadline',
    }, 'session-a', manifest, '/tmp/owned', {
      scaffold: async () => undefined,
      run: (ctx) => new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    });
    const other: BuildManifest = { ...manifest, projectId: 'app_bbcdefghijkl', title: 'آخر' };
    const generateGrant = issueGrant({
      projectId: other.projectId,
      revision: 1,
      planSha256: 'b'.repeat(64),
      operation: { action: 'generate' },
      sessionId: 'session-a',
      expiresAt: Date.now() + 60_000,
    });
    const generated = startJob({
      projectId: other.projectId,
      expectedRevision: 1,
      operation: { action: 'generate' },
      planSha256: 'b'.repeat(64),
      grantId: generateGrant,
      idempotencyKey: 'generate-open',
    }, 'session-a', other, '/tmp/owned-other', {
      scaffold: () => new Promise(() => undefined),
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(readJob(manifest.projectId, packaged.jobId).phase, 'cancelled');
    noteReady(packaged.jobId, packaged.revision);
    assert.equal(readJob(manifest.projectId, packaged.jobId).phase, 'cancelled');
    assert.equal(readJob(other.projectId, generated.jobId).phase, 'starting');
  } finally {
    configurePackageTimeout(null);
    resetJobs();
    resetGrants();
  }
});
