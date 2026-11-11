import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError, issueGrant, resetGrants } from '../grants.js';
import { cancelJob, configureJobRecovery, recoverActiveJob, recoverRememberedJobs, resetJobs, startJob } from '../jobs.js';

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

const jobsSource = fs.readFileSync(new URL('../jobs.ts', import.meta.url), 'utf8');
const routeSource = fs.readFileSync(new URL('../../server/routes/buildMenu.ts', import.meta.url), 'utf8');

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

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.equal(from >= 0 && to > from, true);
  return source.slice(from, to);
}

function jobState(workspace: string): string {
  return path.join(workspace, '.loam', 'build-menu', 'active-job.json');
}

function pointerFile(registry: string): string {
  return path.join(registry, `${manifest.projectId}.json`);
}

function reset(): void {
  configureJobRecovery(null);
  resetJobs();
  resetGrants();
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

function writeManifest(workspace: string): void {
  const dir = path.join(workspace, '.loam', 'build-menu');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
}

function writeRunning(workspace: string, jobId: string): string {
  const file = jobState(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    jobId,
    projectId: manifest.projectId,
    revision: 1,
    kind: 'website',
    action: 'generate',
    phase: 'running',
  })}\n`);
  return file;
}

function withRoot(prefix: string, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  reset();
  try {
    run(root);
  } finally {
    reset();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function guardReads(target: string, run: (reads: () => number) => void): void {
  const realReadFileSync = fs.readFileSync;
  let reads = 0;
  const wrapped = (file: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (samePath(String(file), target)) {
      reads += 1;
      throw new Error('read_outside_bytes');
    }
    return realReadFileSync(file, options);
  };
  fs.readFileSync = wrapped as typeof fs.readFileSync;
  try {
    run(() => reads);
  } finally {
    fs.readFileSync = realReadFileSync;
  }
}

function refuseRead(error: NodeJS.ErrnoException, target: string, run: () => void): void {
  const realReadFileSync = fs.readFileSync;
  const wrapped = (file: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (samePath(String(file), target)) throw error;
    return realReadFileSync(file, options);
  };
  fs.readFileSync = wrapped as typeof fs.readFileSync;
  try {
    run();
  } finally {
    fs.readFileSync = realReadFileSync;
  }
}

test('job reads keep the log caps, the POST 200, and the write-side nlink checks', () => {
  assert.equal(jobsSource.includes('child_process'), false);
  assert.equal(jobsSource.includes('taskkill'), false);
  assert.equal(jobsSource.includes('process.kill'), false);
  assert.equal(jobsSource.includes('spawn'), false);
  assert.equal(jobsSource.includes('symlinkSync'), false);
  assert.match(jobsSource, /MAX_LOG_LINES = 500/);
  assert.match(jobsSource, /MAX_LOG_BYTES = 2048/);
  assert.equal(routeSource.includes("finished.phase === 'failed' ? 400 : 200"), true);

  const guard = between(jobsSource, 'function assertNotHardLinked', 'function activeJobFile');
  assert.equal(guard.includes('stat.nlink > 1'), true);
  const remember = between(jobsSource, 'function rememberJob', 'function forgetJob');
  assert.equal(remember.indexOf('assertNotHardLinked(file)') < remember.indexOf('fs.writeFileSync'), true);
  assert.equal(remember.lastIndexOf('assertNotHardLinked(file)') < remember.indexOf('fs.renameSync'), true);
  const pointerWrite = between(jobsSource, 'function writeJobPointer', 'function removeJobPointer');
  assert.equal(pointerWrite.indexOf('assertNotHardLinked(file)') < pointerWrite.indexOf('fs.writeFileSync'), true);
  const recover = between(jobsSource, 'export function recoverActiveJob', 'export function startJob');
  assert.equal(recover.indexOf('stat.nlink > 1') < recover.indexOf('readActiveRecord('), true);
  assert.equal(recover.indexOf('assertNotHardLinked(file)') < recover.indexOf('fs.renameSync'), true);

  const forget = between(jobsSource, 'function forgetJob', 'function commit');
  assert.equal(forget.indexOf('current.nlink > 1') < forget.indexOf('readFileSync'), true);
  assert.equal(forget.includes("if (errorCode(error) === 'EPERM') throw error;"), true);
  const reader = between(jobsSource, 'function readActiveRecord', 'export function configureJobRecovery');
  assert.equal(reader.indexOf('stat.nlink > 1') < reader.indexOf('try {'), true);
  assert.equal(reader.indexOf('stat.nlink > 1') < reader.indexOf('readFileSync'), true);
  assert.equal(reader.includes("if (errorCode(error) === 'EPERM') throw error;"), true);
  const loop = between(jobsSource, 'for (const name of fs.readdirSync(dir))', 'return count;');
  assert.equal(loop.indexOf('stat.nlink > 1') < loop.indexOf('try {'), true);
  assert.equal(loop.indexOf('stat.nlink > 1') < loop.indexOf('readFileSync'), true);
  assert.equal(loop.includes("if (errorCode(error) === 'EPERM') throw error;"), true);
});

test('a hard-linked job file throws unsafe_path before the record is parsed', () => {
  withRoot('loam-48-job-read-', (root) => {
    const workspace = path.join(root, 'workspace');
    const outsideFile = path.join(root, 'outside-job');
    const state = jobState(workspace);
    const previous = Buffer.from('outside-job-bytes');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, state);
    const stat = fs.lstatSync(state);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    guardReads(state, (reads) => {
      assert.throws(() => recoverActiveJob(workspace), isUnsafePath);
      assert.equal(reads(), 0);
    });
    assert.deepEqual(fs.readFileSync(state), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.equal(fs.lstatSync(state).nlink > 1, true);
    assert.equal(fs.lstatSync(outsideFile).ino, fs.lstatSync(state).ino);
  });
});

test('forgetJob throws unsafe_path before parsing a hard-linked job file', () => {
  withRoot('loam-48-job-forget-', (root) => {
    const workspace = path.join(root, 'workspace');
    const outsideFile = path.join(root, 'outside-job');
    const state = jobState(workspace);
    const previous = Buffer.from('outside-job-bytes');
    fs.mkdirSync(workspace);
    const started = start(workspace, 'forget-link-key');
    fs.writeFileSync(outsideFile, previous);
    fs.rmSync(state);
    fs.linkSync(outsideFile, state);
    const stat = fs.lstatSync(state);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    guardReads(state, (reads) => {
      assert.throws(() => cancelJob(manifest.projectId, started.jobId), isUnsafePath);
      assert.equal(reads(), 0);
    });
    assert.deepEqual(fs.readFileSync(state), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.equal(fs.lstatSync(state).nlink > 1, true);
    assert.equal(fs.lstatSync(outsideFile).ino, fs.lstatSync(state).ino);
  });
});

test('a hard-linked pointer throws unsafe_path before the workspace is parsed', () => {
  withRoot('loam-48-pointer-read-', (root) => {
    const workspace = path.join(root, 'workspace');
    const registry = path.join(root, 'registry');
    const outsideFile = path.join(root, 'outside-pointer');
    const state = writeRunning(workspace, 'job_pointer_link');
    const running = fs.readFileSync(state);
    const previous = Buffer.from(`${JSON.stringify({ workspace: path.resolve(workspace) })}\n`);
    fs.mkdirSync(registry);
    writeManifest(workspace);
    fs.writeFileSync(outsideFile, previous);
    const pointer = pointerFile(registry);
    fs.linkSync(outsideFile, pointer);
    const stat = fs.lstatSync(pointer);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    guardReads(pointer, (reads) => {
      assert.throws(() => recoverRememberedJobs(registry), isUnsafePath);
      assert.equal(reads(), 0);
    });
    assert.deepEqual(fs.readFileSync(pointer), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(state), running);
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).phase, 'running');
    assert.equal(fs.lstatSync(pointer).nlink > 1, true);
    assert.equal(fs.lstatSync(outsideFile).ino, fs.lstatSync(pointer).ino);
  });
});

test('a regular nlink 1 job file and pointer still read', () => {
  withRoot('loam-48-job-nlink1-', (root) => {
    const direct = path.join(root, 'direct');
    const pointed = path.join(root, 'pointed');
    const registry = path.join(root, 'registry');
    const directFile = writeRunning(direct, 'job_direct_read');
    assert.equal(fs.lstatSync(directFile).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(directFile).nlink, 1);
    assert.equal(recoverActiveJob(direct), true);
    assert.equal(JSON.parse(fs.readFileSync(directFile, 'utf8')).phase, 'interrupted');
    assert.equal(fs.lstatSync(directFile).nlink, 1);

    const pointedFile = writeRunning(pointed, 'job_pointed_read');
    writeManifest(pointed);
    fs.mkdirSync(registry);
    const pointer = pointerFile(registry);
    fs.writeFileSync(pointer, `${JSON.stringify({ workspace: path.resolve(pointed) })}\n`);
    assert.equal(fs.lstatSync(pointer).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(pointer).isFile(), true);
    assert.equal(fs.lstatSync(pointer).nlink, 1);
    assert.equal(recoverRememberedJobs(registry), 1);
    assert.equal(JSON.parse(fs.readFileSync(pointedFile, 'utf8')).phase, 'interrupted');
    assert.equal(JSON.parse(fs.readFileSync(pointer, 'utf8')).workspace, path.resolve(pointed));
    assert.equal(fs.lstatSync(pointer).nlink, 1);
    assert.equal(fs.lstatSync(pointedFile).nlink, 1);
  });
});

test('forgetJob still reads a regular nlink 1 job file', () => {
  withRoot('loam-48-forget-nlink1-', (root) => {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const started = start(workspace, 'forget-nlink1-key');
    const state = jobState(workspace);
    const stat = fs.lstatSync(state);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).jobId, started.jobId);
    assert.equal(cancelJob(manifest.projectId, started.jobId).phase, 'cancelled');
    assert.equal(fs.existsSync(state), false);
  });
});

test('a hard-linked job file still throws unsafe_path before write', () => {
  withRoot('loam-48-job-write-', (root) => {
    const workspace = path.join(root, 'workspace');
    const outsideFile = path.join(root, 'outside-job');
    const state = jobState(workspace);
    const previous = Buffer.from('outside-write-bytes');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, state);
    assert.equal(fs.lstatSync(state).nlink > 1, true);
    assert.throws(() => start(workspace, 'write-link-key'), isUnsafePath);
    assert.deepEqual(fs.readFileSync(state), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.equal(fs.lstatSync(state).nlink > 1, true);
    assert.equal(fs.lstatSync(outsideFile).ino, fs.lstatSync(state).ino);
  });
});

test('EPERM from a job file read escapes', () => {
  withRoot('loam-48-job-eperm-', (root) => {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const started = start(workspace, 'job-eperm-key');
    const state = jobState(workspace);
    const previous = fs.readFileSync(state);
    assert.equal(fs.lstatSync(state).nlink, 1);
    const error = new Error('operation not permitted') as NodeJS.ErrnoException;
    error.code = 'EPERM';
    refuseRead(error, state, () => {
      assert.throws(() => cancelJob(manifest.projectId, started.jobId), isEperm);
    });
    assert.deepEqual(fs.readFileSync(state), previous);
    assert.equal(fs.lstatSync(state).nlink, 1);
  });
});

test('EPERM from the active record lstat escapes before parse', () => {
  withRoot('loam-48-record-eperm-', (root) => {
    const workspace = path.join(root, 'workspace');
    const state = writeRunning(workspace, 'job_record_eperm');
    const previous = fs.readFileSync(state);
    assert.equal(fs.lstatSync(state).nlink, 1);
    const realLstatSync = fs.lstatSync;
    let seen = 0;
    Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (samePath(String(target), state)) {
        seen += 1;
        if (seen > 1) {
          const error = new Error('operation not permitted') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync });
    try {
      assert.throws(() => recoverActiveJob(workspace), isEperm);
      assert.equal(seen > 1, true);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    }
    assert.deepEqual(fs.readFileSync(state), previous);
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).phase, 'running');
    assert.equal(fs.lstatSync(state).nlink, 1);
  });
});

test('EPERM from a pointer read escapes', () => {
  withRoot('loam-48-pointer-eperm-', (root) => {
    const workspace = path.join(root, 'workspace');
    const registry = path.join(root, 'registry');
    const state = writeRunning(workspace, 'job_pointer_eperm');
    const running = fs.readFileSync(state);
    writeManifest(workspace);
    fs.mkdirSync(registry);
    const pointer = pointerFile(registry);
    const body = `${JSON.stringify({ workspace: path.resolve(workspace) })}\n`;
    fs.writeFileSync(pointer, body);
    assert.equal(fs.lstatSync(pointer).nlink, 1);
    const error = new Error('operation not permitted') as NodeJS.ErrnoException;
    error.code = 'EPERM';
    refuseRead(error, pointer, () => {
      assert.throws(() => recoverRememberedJobs(registry), isEperm);
    });
    assert.equal(fs.readFileSync(pointer, 'utf8'), body);
    assert.deepEqual(fs.readFileSync(state), running);
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).phase, 'running');
    assert.equal(fs.lstatSync(pointer).nlink, 1);
  });
});

test('EPERM from a pointer lstat escapes', () => {
  withRoot('loam-48-pointer-lstat-', (root) => {
    const workspace = path.join(root, 'workspace');
    const registry = path.join(root, 'registry');
    const state = writeRunning(workspace, 'job_pointer_lstat');
    const running = fs.readFileSync(state);
    writeManifest(workspace);
    fs.mkdirSync(registry);
    const pointer = pointerFile(registry);
    const body = `${JSON.stringify({ workspace: path.resolve(workspace) })}\n`;
    fs.writeFileSync(pointer, body);
    const realLstatSync = fs.lstatSync;
    Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (samePath(String(target), pointer)) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync });
    try {
      assert.throws(() => recoverRememberedJobs(registry), isEperm);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    }
    assert.equal(fs.readFileSync(pointer, 'utf8'), body);
    assert.deepEqual(fs.readFileSync(state), running);
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).phase, 'running');
  });
});
