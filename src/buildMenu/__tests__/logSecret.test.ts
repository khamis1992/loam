import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { containsSecret, writeJobEvidence } from '../evidence.js';
import { issueGrant, resetGrants } from '../grants.js';
import { appendJobLog, readJob, readJobLog, resetJobs, startJob } from '../jobs.js';

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

test('a job log redacts an env token assignment', () => {
  resetGrants();
  resetJobs();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-log-'));
  try {
    const grantId = issueGrant({
      projectId: manifest.projectId,
      revision: 1,
      planSha256: 'b'.repeat(64),
      operation: { action: 'generate' },
      sessionId: 'session-a',
      expiresAt: Date.now() + 60_000,
    });
    const started = startJob({
      projectId: manifest.projectId,
      expectedRevision: 1,
      operation: { action: 'generate' },
      planSha256: 'b'.repeat(64),
      grantId,
      idempotencyKey: 'log-secret',
    }, 'session-a', manifest, root, { scaffold: async () => undefined });
    appendJobLog(started.jobId, 'install NPM_TOKEN=ghp_examplevalue line');
    const log = readJobLog(manifest.projectId, started.jobId)[0] ?? '';
    assert.equal(log.includes('ghp_examplevalue'), false);
    assert.equal(log.includes('NPM_TOKEN='), false);
    assert.match(log, /install \[redacted\] line/);
    assert.equal(containsSecret('const tokenizer = 1'), false);
    writeJobEvidence(root, started.jobId, { phase: 'failed', summary: 'NPM_TOKEN=ghp_examplevalue' });
    const evidence = fs.readFileSync(path.join(root, '.loam', 'build-menu', 'evidence', started.jobId, 'result.json'), 'utf8');
    assert.equal(evidence.includes('ghp_examplevalue'), false);
    assert.match(evidence, /\[redacted\]/);
  } finally {
    resetJobs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed job snapshot hides a path, an env token, and a grant id', async () => {
  resetGrants();
  resetJobs();
  const grant = 'ab'.repeat(32);
  try {
    const grantId = issueGrant({
      projectId: manifest.projectId,
      revision: 1,
      planSha256: 'b'.repeat(64),
      operation: { action: 'generate' },
      sessionId: 'session-a',
      expiresAt: Date.now() + 60_000,
    });
    const started = startJob({
      projectId: manifest.projectId,
      expectedRevision: 1,
      operation: { action: 'generate' },
      planSha256: 'b'.repeat(64),
      grantId,
      idempotencyKey: 'failed-secret',
    }, 'session-a', manifest, os.tmpdir(), {
      scaffold: async () => {
        throw new Error(`ENOENT: open 'C:\\Users\\khamis\\secret.txt' NPM_TOKEN=ghp_examplevalue grantId=${grant}`);
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const job = readJob(manifest.projectId, started.jobId);
    assert.equal(job.phase, 'failed');
    if (job.phase !== 'failed') return;
    assert.equal(job.code, 'tool_failed');
    assert.equal(job.message.includes('secret.txt'), false);
    assert.equal(job.message.includes('ghp_examplevalue'), false);
    assert.equal(job.message.includes(grant), false);
    assert.match(job.message, /\[path\]/);
    assert.match(job.message, /\[redacted\]/);
    const log = readJobLog(manifest.projectId, started.jobId).join('\n');
    assert.equal(log.includes(grant), false);
    assert.equal(log.includes('ghp_examplevalue'), false);
  } finally {
    resetJobs();
  }
});
