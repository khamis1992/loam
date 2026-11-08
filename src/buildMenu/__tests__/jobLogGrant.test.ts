import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { issueGrant, resetGrants } from '../grants.js';
import { appendJobLog, readJobLog, resetJobs, startJob } from '../jobs.js';

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

test('a job log stores an Arabic summary without a grant id', () => {
  resetGrants();
  resetJobs();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-grant-'));
  const secret = '0123456789abcdef'.repeat(4);
  const summary = 'تم إنشاء الصفحة بنجاح';
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
      idempotencyKey: 'job-log-grant',
    }, 'session-a', manifest, root, { scaffold: async () => undefined });
    appendJobLog(started.jobId, `${summary} grantId=${secret}`);
    const stored = readJobLog(manifest.projectId, started.jobId).join('\n');
    assert.equal(stored.includes(secret), false);
    assert.equal(stored.includes(`grantId=${secret}`), false);
    assert.equal(stored.includes('grantId='), false);
    assert.match(stored, /تم إنشاء الصفحة بنجاح/);
  } finally {
    resetJobs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
