import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { issueGrant, resetGrants } from '../grants.js';
import { readJob, recoverActiveJob, resetJobs, startJob } from '../jobs.js';

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

test('jobs.ts owns no process API and recovery aborts before the phase is interrupted', async () => {
  const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'jobs.ts'), 'utf8');
  assert.equal(source.includes('child_process'), false);
  assert.equal(source.includes('taskkill'), false);
  assert.equal(source.includes('process.kill'), false);
  assert.equal(source.includes('spawn'), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-no-process-'));
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
  let phaseAtAbort = '';
  let resumed = 0;
  try {
    fs.mkdirSync(root, { recursive: true });
    const started = startJob({
      projectId: manifest.projectId,
      expectedRevision: 1,
      operation: { action: 'preview' },
      planSha256: 'b'.repeat(64),
      grantId,
      idempotencyKey: 'no-process-key',
    }, 'session-a', manifest, root, {
      scaffold: async () => {
        resumed += 1;
      },
      run: (ctx) => new Promise((resolve) => {
        signal = ctx.signal;
        ctx.signal.addEventListener('abort', () => {
          phaseAtAbort = readJob(manifest.projectId, ctx.jobId).phase;
          resolve();
        }, { once: true });
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readJob(manifest.projectId, started.jobId).phase, 'starting');
    assert.equal(signal?.aborted, false);
    assert.equal(recoverActiveJob(root), true);
    assert.equal(signal?.aborted, true);
    assert.equal(phaseAtAbort, 'starting');
    assert.equal(readJob(manifest.projectId, started.jobId).phase, 'interrupted');
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'active-job.json'), 'utf8')) as { phase: string; pid?: number };
    assert.equal(saved.phase, 'interrupted');
    assert.equal(saved.pid, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resumed, 0);
    assert.equal(readJob(manifest.projectId, started.jobId).phase, 'interrupted');
  } finally {
    resetJobs();
    resetGrants();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
