import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError, issueGrant, resetGrants } from '../grants.js';
import { appendJobLog, cancelJob, notePreviewCrashed, noteReady, readJob, readJobLog, recordCancellation, resetJobs, startJob } from '../jobs.js';
import { readManifest, saveManifest } from '../manifest.js';

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

function request(grantId: string, idempotencyKey: string) {
  return {
    projectId: manifest.projectId,
    expectedRevision: 1,
    operation: { action: 'generate' as const },
    planSha256: 'b'.repeat(64),
    grantId,
    idempotencyKey,
  };
}

test('a job log stays bounded and hides secrets', () => {
  resetGrants();
  resetJobs();
  const grantId = issueGrant({
    projectId: manifest.projectId,
    revision: 1,
    planSha256: 'b'.repeat(64),
    operation: { action: 'generate' },
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
  });
  const started = startJob(request(grantId, 'log-key'), 'session-a', manifest, '/tmp/owned', { scaffold: async () => undefined });
  appendJobLog(started.jobId, 'api_key=sk-testsecretvalue');
  assert.equal(readJobLog(manifest.projectId, started.jobId)[0], '[redacted]');
  appendJobLog(started.jobId, 'x'.repeat(4000));
  for (let index = 0; index < 499; index += 1) appendJobLog(started.jobId, `line-${index}`);
  const log = readJobLog(manifest.projectId, started.jobId);
  assert.equal(log.length, 500);
  assert.equal(log[0]?.startsWith('x'), true);
  assert.equal(Buffer.byteLength(log[0] ?? ''), 2048);
  assert.equal(log.some((line) => line.includes('sk-testsecretvalue')), false);
  assert.throws(
    () => readJobLog('app_zzzzzzzzzzzz', started.jobId),
    (error: unknown) => error instanceof BuildMenuError && error.status === 404,
  );
});

test('queued cancel does not scaffold and a late ready is ignored', async () => {
  resetGrants();
  resetJobs();
  let scaffolds = 0;
  const grantId = issueGrant({
    projectId: manifest.projectId,
    revision: 1,
    planSha256: 'b'.repeat(64),
    operation: { action: 'generate' },
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
  });
  const hooks = { scaffold: async (_ctx: BuildJobContext) => { scaffolds += 1; } };
  const started = startJob(request(grantId, 'same-key'), 'session-a', manifest, '/tmp/owned', hooks);
  const cancelled = cancelJob(manifest.projectId, started.jobId);
  assert.equal(cancelled.phase, 'cancelled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scaffolds, 0);
  noteReady(started.jobId, started.revision);
  assert.equal(readJob(manifest.projectId, started.jobId).phase, 'cancelled');
  const replay = startJob(request(grantId, 'same-key'), 'session-a', manifest, '/tmp/owned', hooks);
  assert.equal(replay.jobId, started.jobId);
  assert.equal(scaffolds, 0);
});

test('cancelling a queued job records cancelled evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-cancel-evidence-'));
  resetGrants();
  resetJobs();
  const grantId = issueGrant({
    projectId: manifest.projectId,
    revision: 1,
    planSha256: 'b'.repeat(64),
    operation: { action: 'generate' },
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
  });
  let scaffolds = 0;
  try {
    const started = startJob(request(grantId, 'cancel-evidence'), 'session-a', manifest, root, {
      scaffold: async () => { scaffolds += 1; },
    });
    assert.equal(cancelJob(manifest.projectId, started.jobId).phase, 'cancelled');
    recordCancellation(manifest.projectId, started.jobId);
    const recorded = JSON.parse(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'evidence', started.jobId, 'result.json'), 'utf8')) as { phase: string; action: string; kind: string; summary: string };
    assert.equal(recorded.phase, 'cancelled');
    assert.equal(recorded.action, 'generate');
    assert.equal(recorded.kind, 'website');
    assert.equal(recorded.summary, 'cancelled');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scaffolds, 0);
  } finally {
    resetJobs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cancel aborts the running preview signal and stays cancelled', async () => {
  resetGrants();
  resetJobs();
  const grantId = issueGrant({
    projectId: manifest.projectId,
    revision: 1,
    planSha256: 'b'.repeat(64),
    operation: { action: 'preview' },
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
  });
  let signal: AbortSignal | undefined;
  const started = startJob({
    ...request(grantId, 'abort-key'),
    operation: { action: 'preview' },
  }, 'session-a', manifest, '/tmp/owned', {
    scaffold: async () => undefined,
    run: async (ctx) => {
      signal = ctx.signal;
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
          return;
        }
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal?.aborted, false);
  assert.equal(cancelJob(manifest.projectId, started.jobId).phase, 'stopping');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal?.aborted, true);
  noteReady(started.jobId, started.revision);
  assert.equal(readJob(manifest.projectId, started.jobId).phase, 'cancelled');
});

test('a late noteReady leaves an already cancelled job cancelled', async () => {
  resetGrants();
  resetJobs();
  const grantId = issueGrant({
    projectId: manifest.projectId,
    revision: 1,
    planSha256: 'b'.repeat(64),
    operation: { action: 'preview' },
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
  });
  const started = startJob({
    ...request(grantId, 'late-ready-cancelled'),
    operation: { action: 'preview' },
  }, 'session-a', manifest, '/tmp/owned', {
    scaffold: async () => undefined,
    run: (ctx) => new Promise<void>((resolve) => {
      if (ctx.signal.aborted) {
        resolve();
        return;
      }
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelJob(manifest.projectId, started.jobId).phase, 'stopping');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readJob(manifest.projectId, started.jobId).phase, 'cancelled');
  noteReady(started.jobId, started.revision);
  assert.equal(readJob(manifest.projectId, started.jobId).phase, 'cancelled');
});

test('cancelling a running preview records cancelled evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-preview-cancel-'));
  resetGrants();
  resetJobs();
  const grantId = issueGrant({
    projectId: manifest.projectId,
    revision: 1,
    planSha256: 'b'.repeat(64),
    operation: { action: 'preview' },
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
  });
  try {
    const started = startJob({
      ...request(grantId, 'preview-cancel-evidence'),
      operation: { action: 'preview' },
    }, 'session-a', manifest, root, {
      scaffold: async () => undefined,
      run: (ctx) => new Promise((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
          return;
        }
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelJob(manifest.projectId, started.jobId).phase, 'stopping');
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'evidence', started.jobId, 'result.json')), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readJob(manifest.projectId, started.jobId).phase, 'cancelled');
    const recorded = JSON.parse(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'evidence', started.jobId, 'result.json'), 'utf8')) as { phase: string; action: string };
    assert.equal(recorded.phase, 'cancelled');
    assert.equal(recorded.action, 'preview');
  } finally {
    resetJobs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an aborted task rejection is cancelled rather than failed', async () => {
  resetGrants();
  resetJobs();
  const grantId = issueGrant({
    projectId: manifest.projectId,
    revision: 1,
    planSha256: 'b'.repeat(64),
    operation: { action: 'preview' },
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
  });
  const started = startJob({
    ...request(grantId, 'abort-reject'),
    operation: { action: 'preview' },
  }, 'session-a', manifest, '/tmp/owned', {
    scaffold: async () => undefined,
    run: (ctx) => new Promise((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelJob(manifest.projectId, started.jobId).phase, 'stopping');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readJob(manifest.projectId, started.jobId).phase, 'cancelled');
});

test('an idempotency key does not replay a different operation', async () => {
  resetGrants();
  resetJobs();
  const generateGrant = issueGrant({
    projectId: manifest.projectId,
    revision: 1,
    planSha256: 'b'.repeat(64),
    operation: { action: 'generate' },
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
  });
  const packageGrant = issueGrant({
    projectId: manifest.projectId,
    revision: 1,
    planSha256: 'b'.repeat(64),
    operation: { action: 'package', format: 'source-zip' },
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
  });
  const hooks = { scaffold: async () => undefined };
  const started = startJob(request(generateGrant, 'bound-key'), 'session-a', manifest, '/tmp/owned', hooks);
  assert.throws(
    () => startJob({
      ...request(packageGrant, 'bound-key'),
      operation: { action: 'package', format: 'source-zip' },
    }, 'session-a', manifest, '/tmp/owned', hooks),
    (error: unknown) => error instanceof BuildMenuError && error.status === 400,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const packaged = startJob({
    ...request(packageGrant, 'other-key'),
    operation: { action: 'package', format: 'source-zip' },
  }, 'session-a', manifest, '/tmp/owned', hooks);
  assert.notEqual(packaged.jobId, started.jobId);
  assert.equal(startJob(request(generateGrant, 'bound-key'), 'session-a', manifest, '/tmp/owned', hooks).jobId, started.jobId);
});

test('a consumed grant cannot start a second idempotency key', async () => {
  resetGrants();
  resetJobs();
  const grantId = issueGrant({
    projectId: manifest.projectId,
    revision: 1,
    planSha256: 'b'.repeat(64),
    operation: { action: 'generate' },
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
  });
  const hooks = { scaffold: async () => undefined };
  startJob(request(grantId, 'one'), 'session-a', manifest, '/tmp/owned', hooks);
  assert.throws(
    () => startJob(request(grantId, 'two'), 'session-a', manifest, '/tmp/owned', hooks),
    (error: unknown) => error instanceof BuildMenuError && error.message === 'busy' && error.status === 409,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => startJob(request(grantId, 'two'), 'session-a', manifest, '/tmp/owned', hooks), { status: 403 });
});

test('preview runs the supplied operation and a failure is recorded', async () => {
  resetGrants();
  resetJobs();
  let runs = 0;
  const grantId = issueGrant({
    projectId: manifest.projectId,
    revision: 1,
    planSha256: 'b'.repeat(64),
    operation: { action: 'preview' },
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
  });
  const started = startJob({
    ...request(grantId, 'preview-key'),
    operation: { action: 'preview' },
  }, 'session-a', manifest, '/tmp/owned', {
    scaffold: async () => undefined,
    run: async () => {
      runs += 1;
      throw new Error('missing_requirement');
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);
  assert.equal(readJob(manifest.projectId, started.jobId).phase, 'failed');
});

test('a preview that exits twice is failed and is not packaged', async () => {
  resetGrants();
  resetJobs();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-preview-exit-'));
  const grantId = issueGrant({
    projectId: manifest.projectId,
    revision: 1,
    planSha256: 'b'.repeat(64),
    operation: { action: 'preview' },
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
  });
  let packaged = 0;
  const started = startJob({
    ...request(grantId, 'crash-key'),
    operation: { action: 'preview' },
  }, 'session-a', manifest, root, {
    scaffold: async () => { packaged += 1; },
    run: async () => undefined,
  });
  await new Promise((resolve) => setImmediate(resolve));
  notePreviewCrashed(started.jobId);
  notePreviewCrashed(started.jobId);
  noteReady(started.jobId, started.revision);
  const job = readJob(manifest.projectId, started.jobId);
  assert.equal(job.phase, 'failed');
  if (job.phase === 'failed') assert.equal(job.message, 'preview_exited');
  assert.deepEqual(readJobLog(manifest.projectId, started.jobId), ['preview exited']);
  assert.equal(packaged, 0);
  const evidence = fs.readFileSync(path.join(root, '.loam', 'build-menu', 'evidence', started.jobId, 'result.json'), 'utf8');
  assert.match(evidence, /"phase": "failed"/);
  assert.match(evidence, /"summary": "preview_exited"/);
  assert.equal(evidence.includes('artifactId'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a late ready from another revision does not finish the job', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-revision-'));
  resetGrants();
  resetJobs();
  const grantId = issueGrant({
    projectId: manifest.projectId,
    revision: 1,
    planSha256: 'b'.repeat(64),
    operation: { action: 'generate' },
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
  });
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await saveManifest(root, manifest, 0);
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-revision-other-'));
    const started = startJob(request(grantId, 'revision-key'), 'session-a', manifest, root, {
      scaffold: async () => undefined,
      run: async () => { await gate; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      saveManifest(root, { ...manifest, revision: 2 }, 1),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'busy' && error.status === 409,
    );
    assert.equal(readManifest(root)?.revision, 1);
    const other = { ...manifest, projectId: 'app_bbcdefghijkl' as const, title: 'آخر' };
    await saveManifest(otherRoot, other, 0);
    noteReady(started.jobId, 2);
    assert.equal(readJob(manifest.projectId, started.jobId).phase, 'starting');
    release();
    const deadline = Date.now() + 1_000;
    let finished = readJob(manifest.projectId, started.jobId);
    while (finished.phase === 'starting' && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
      finished = readJob(manifest.projectId, started.jobId);
    }
    assert.equal(finished.phase, 'completed');
    await saveManifest(root, { ...manifest, revision: 2 }, 1);
    assert.equal(readManifest(root)?.revision, 2);
    fs.rmSync(otherRoot, { recursive: true, force: true });
  } finally {
    release();
    resetJobs();
    resetGrants();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
