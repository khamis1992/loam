import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError, issueGrant, resetGrants } from '../grants.js';
import { configureJobRecovery, readJob, recoverActiveJob, recoverRememberedJobs, resetJobs, startJob } from '../jobs.js';

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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recordFile(root: string): string {
  return path.join(root, '.loam', 'build-menu', 'active-job.json');
}

test('an active job is recorded and reboot does not resume generation', async () => {
  const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'jobs.ts'), 'utf8');
  assert.equal(source.includes('child_process'), false);
  assert.equal(source.includes('taskkill'), false);
  assert.equal(source.includes('process.kill'), false);
  assert.equal(source.includes('spawn('), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-recover-'));
  const page = path.join(root, 'app', 'page.html');
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
    fs.mkdirSync(path.dirname(page), { recursive: true });
    fs.writeFileSync(page, 'untouched');
    const started = startJob({
      projectId: manifest.projectId,
      expectedRevision: 1,
      operation: { action: 'generate' },
      planSha256: 'b'.repeat(64),
      grantId,
      idempotencyKey: 'recover-key',
    }, 'session-a', manifest, root, {
      scaffold: async () => {
        scaffolds += 1;
        fs.writeFileSync(page, 'generated');
      },
    });
    const recorded = JSON.parse(fs.readFileSync(recordFile(root), 'utf8')) as { jobId: string; phase: string; action: string; pid?: number };
    assert.equal(recorded.jobId, started.jobId);
    assert.equal(recorded.phase, 'queued');
    assert.equal(recorded.action, 'generate');
    assert.equal(recorded.pid, undefined);
    assert.equal(recoverActiveJob(root), true);
    const interrupted = JSON.parse(fs.readFileSync(recordFile(root), 'utf8')) as { phase: string; action: string; pid?: number };
    assert.equal(interrupted.phase, 'interrupted');
    assert.equal(interrupted.action, 'generate');
    assert.equal(interrupted.pid, undefined);
    assert.equal(readJob(manifest.projectId, started.jobId).phase, 'interrupted');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scaffolds, 0);
    assert.equal(fs.readFileSync(page, 'utf8'), 'untouched');
    assert.equal(recoverActiveJob(root), false);
    assert.equal(readJob(manifest.projectId, started.jobId).phase, 'interrupted');
  } finally {
    resetJobs();
    resetGrants();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a saved pid is not killed and export is not resumed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-pid-'));
  const page = path.join(root, 'app', 'page.html');
  const sleeper: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const pid = sleeper.pid;
  assert.equal(typeof pid, 'number');
  try {
    fs.mkdirSync(path.dirname(page), { recursive: true });
    fs.writeFileSync(page, 'untouched');
    const file = recordFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({
      schemaVersion: 1,
      jobId: 'job_reboot',
      projectId: manifest.projectId,
      revision: 1,
      kind: 'website',
      action: 'package',
      phase: 'running',
      pid,
      command: 'node export.js',
    })}\n`);
    assert.equal(alive(pid as number), true);
    assert.equal(recoverActiveJob(root), true);
    const saved = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(saved) as { phase: string; action: string; pid?: number; command?: string };
    assert.equal(parsed.phase, 'interrupted');
    assert.equal(parsed.action, 'package');
    assert.equal(parsed.pid, undefined);
    assert.equal(parsed.command, undefined);
    assert.equal(saved.includes(String(pid)), false);
    assert.equal(saved.includes('export.js'), false);
    assert.equal(fs.readFileSync(page, 'utf8'), 'untouched');
    assert.equal(fs.existsSync(path.join(root, 'app', 'export.zip')), false);
    assert.equal(alive(pid as number), true);
    assert.equal(recoverActiveJob(root), false);
    const finished = `${JSON.stringify({
      schemaVersion: 1,
      jobId: 'job_reboot',
      projectId: manifest.projectId,
      revision: 1,
      kind: 'website',
      action: 'package',
      phase: 'completed',
      pid,
    })}\n`;
    fs.writeFileSync(file, finished);
    assert.equal(recoverActiveJob(root), false);
    assert.equal(fs.readFileSync(file, 'utf8'), finished);
    assert.equal(alive(pid as number), true);
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.throws(
      () => recoverActiveJob(root),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path',
    );
    assert.equal(alive(pid as number), true);
    fs.rmSync(file, { recursive: true, force: true });
    assert.equal(recoverActiveJob(root), false);
    assert.equal(alive(pid as number), true);
  } finally {
    sleeper.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup recovery ignores a pointer aimed at another folder', () => {
  const route = fs.readFileSync(path.resolve('src/server/http.ts'), 'utf8');
  assert.match(route, /recoverRememberedJobs\(activeJobs\)/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-pointer-'));
  const owned = path.join(root, 'owned');
  const foreign = path.join(root, 'foreign');
  const registry = path.join(root, 'registry');
  configureJobRecovery(null);
  try {
    writeManifest(owned, manifest.projectId);
    writeManifest(foreign, 'app_bbcdefghijkl');
    const foreignJob = recordFile(foreign);
    const foreignBody = `${JSON.stringify({
      schemaVersion: 1,
      jobId: 'job_foreign',
      projectId: 'app_bbcdefghijkl',
      revision: 1,
      kind: 'website',
      action: 'generate',
      phase: 'running',
    })}\n`;
    fs.mkdirSync(path.dirname(foreignJob), { recursive: true });
    fs.writeFileSync(foreignJob, foreignBody);
    fs.mkdirSync(registry, { recursive: true });
    const pointer = path.join(registry, `${manifest.projectId}.json`);
    fs.writeFileSync(pointer, `${JSON.stringify({ workspace: foreign })}\n`);
    assert.equal(recoverRememberedJobs(registry), 0);
    assert.equal(fs.readFileSync(foreignJob, 'utf8'), foreignBody);
    const ownedJob = recordFile(owned);
    fs.mkdirSync(path.dirname(ownedJob), { recursive: true });
    fs.writeFileSync(ownedJob, `${JSON.stringify({
      schemaVersion: 1,
      jobId: 'job_owned',
      projectId: manifest.projectId,
      revision: 1,
      kind: 'website',
      action: 'package',
      phase: 'running',
    })}\n`);
    fs.writeFileSync(pointer, `${JSON.stringify({ workspace: owned })}\n`);
    assert.equal(recoverRememberedJobs(registry), 1);
    assert.equal(JSON.parse(fs.readFileSync(ownedJob, 'utf8')).phase, 'interrupted');
    assert.equal(fs.existsSync(path.join(owned, 'app', 'export.zip')), false);
  } finally {
    configureJobRecovery(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery aborts the in-flight signal and does not resume the preview', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-signal-'));
  const page = path.join(root, 'app', 'page.html');
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
  try {
    fs.mkdirSync(path.dirname(page), { recursive: true });
    const started = startJob({
      projectId: manifest.projectId,
      expectedRevision: 1,
      operation: { action: 'preview' },
      planSha256: 'b'.repeat(64),
      grantId,
      idempotencyKey: 'recover-signal',
    }, 'session-a', manifest, root, {
      scaffold: async () => undefined,
      run: (ctx) => new Promise((resolve) => {
        signal = ctx.signal;
        if (ctx.signal.aborted) {
          resolve();
          return;
        }
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signal?.aborted, false);
    assert.equal(recoverActiveJob(root), true);
    assert.equal(signal?.aborted, true);
    assert.equal(readJob(manifest.projectId, started.jobId).phase, 'interrupted');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readJob(manifest.projectId, started.jobId).phase, 'interrupted');
    assert.equal(fs.existsSync(page), false);
    assert.equal(JSON.parse(fs.readFileSync(recordFile(root), 'utf8')).phase, 'interrupted');
  } finally {
    resetJobs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeManifest(workspace: string, projectId: string): void {
  const dir = path.join(workspace, '.loam', 'build-menu');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({ ...manifest, projectId })}\n`);
}
