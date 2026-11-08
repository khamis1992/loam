import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError, issueGrant, resetGrants } from '../grants.js';
import { configureJobRecovery, readJob, recoverActiveJob, resetJobs, startJob } from '../jobs.js';

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

const jobsSource = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'jobs.ts'),
  'utf8',
);

function isUnsafePath(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (process.platform === 'win32') return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  return resolvedLeft === resolvedRight;
}

function jobState(workspace: string): string {
  return path.join(workspace, '.loam', 'build-menu', 'active-job.json');
}

function pointerFile(registry: string): string {
  return path.join(registry, `${manifest.projectId}.json`);
}

function start(workspace: string, key: string) {
  const grantId = issueGrant({
    projectId: manifest.projectId,
    revision: 1,
    planSha256: 'b'.repeat(64),
    operation: { action: 'generate' },
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
  });
  return startJob({
    projectId: manifest.projectId,
    expectedRevision: 1,
    operation: { action: 'generate' },
    planSha256: 'b'.repeat(64),
    grantId,
    idempotencyKey: key,
  }, 'session-a', manifest, workspace, {
    scaffold: async () => undefined,
  });
}

test('jobs.ts keeps the log caps and does not own a process API', () => {
  assert.equal(jobsSource.includes('child_process'), false);
  assert.equal(jobsSource.includes('taskkill'), false);
  assert.equal(jobsSource.includes('process.kill'), false);
  assert.equal(jobsSource.includes('spawn'), false);
  assert.equal(jobsSource.includes('symlinkSync'), false);
  assert.match(jobsSource, /MAX_LOG_LINES = 500/);
  assert.match(jobsSource, /MAX_LOG_BYTES = 2048/);
  assert.match(jobsSource, /nlink > 1/);
});

test('a hard-linked job state throws unsafe_path before write and the outside bytes stay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-job-state-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-job-state-out-'));
  const workspace = path.join(root, 'workspace');
  const outsideFile = path.join(outside, 'secret.txt');
  const state = jobState(workspace);
  const previous = Buffer.from('keep-outside-state');
  configureJobRecovery(null);
  resetJobs();
  resetGrants();
  try {
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, state);
    const stat = fs.lstatSync(state);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.throws(() => recoverActiveJob(workspace), isUnsafePath);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(state), previous);
    assert.equal(fs.lstatSync(state).nlink > 1, true);
    assert.throws(() => start(workspace, 'state-link-key'), isUnsafePath);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(state), previous);
    assert.equal(fs.lstatSync(outsideFile).ino, fs.lstatSync(state).ino);
  } finally {
    configureJobRecovery(null);
    resetJobs();
    resetGrants();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a hard-linked pointer throws unsafe_path and a normal new pointer still writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-job-pointer-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-job-pointer-out-'));
  const linkedWorkspace = path.join(root, 'linked');
  const freshWorkspace = path.join(root, 'fresh');
  const registry = path.join(root, 'registry');
  const outsideFile = path.join(outside, 'secret.txt');
  const linkedPointer = pointerFile(registry);
  const previous = Buffer.from('keep-outside-pointer');
  configureJobRecovery(null);
  resetJobs();
  resetGrants();
  try {
    fs.mkdirSync(linkedWorkspace);
    fs.mkdirSync(registry);
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, linkedPointer);
    const stat = fs.lstatSync(linkedPointer);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    configureJobRecovery(registry);
    assert.throws(() => start(linkedWorkspace, 'pointer-link-key'), isUnsafePath);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(linkedPointer), previous);
    assert.equal(fs.lstatSync(linkedPointer).nlink > 1, true);
    assert.equal(fs.lstatSync(linkedPointer).isSymbolicLink(), false);
    assert.equal(fs.existsSync(jobState(linkedWorkspace)), false);

    resetJobs();
    resetGrants();
    const freshRegistry = path.join(root, 'fresh-registry');
    fs.mkdirSync(freshWorkspace);
    configureJobRecovery(freshRegistry);
    const started = start(freshWorkspace, 'pointer-new-key');
    const created = pointerFile(freshRegistry);
    const written = fs.lstatSync(created);
    assert.equal(started.phase, 'queued');
    assert.equal(written.isSymbolicLink(), false);
    assert.equal(written.isFile(), true);
    assert.equal(written.nlink, 1);
    assert.equal(JSON.parse(fs.readFileSync(created, 'utf8')).workspace, path.resolve(freshWorkspace));
    const saved = fs.lstatSync(jobState(freshWorkspace));
    assert.equal(saved.isSymbolicLink(), false);
    assert.equal(saved.isFile(), true);
    assert.equal(saved.nlink, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readJob(manifest.projectId, started.jobId).phase, 'completed');
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(linkedPointer), previous);
  } finally {
    configureJobRecovery(null);
    resetJobs();
    resetGrants();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('recoverActiveJob lets EPERM from lstat escape', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-job-eperm-'));
  const workspace = path.join(root, 'workspace');
  const state = jobState(workspace);
  const previous = Buffer.from('keep-eperm-state');
  configureJobRecovery(null);
  resetJobs();
  const realLstatSync = fs.lstatSync;
  let seen = 0;
  try {
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, previous);
    assert.equal(realLstatSync(state).nlink, 1);
    fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (samePath(String(target), state)) {
        seen += 1;
        if (seen > 1) {
          const error = new Error('operation not permitted') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync;
    assert.throws(() => recoverActiveJob(workspace), isEperm);
    assert.equal(seen > 1, true);
    assert.deepEqual(fs.readFileSync(state), previous);
    assert.equal(realLstatSync(state).nlink, 1);
  } finally {
    fs.lstatSync = realLstatSync;
    configureJobRecovery(null);
    resetJobs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
