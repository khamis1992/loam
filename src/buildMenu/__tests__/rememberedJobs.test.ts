import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { recoverRememberedJobs } from '../jobs.js';

const ownedId = 'app_abcdefghijkl';
const foreignId = 'app_bbcdefghijkl';
const missingId = 'app_cccdefghijkl';

const manifest: BuildManifest = {
  schemaVersion: 1,
  projectId: ownedId,
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

function samePath(left: string, right: string): boolean {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function writeManifest(workspace: string, projectId: string): void {
  const dir = path.join(workspace, '.loam', 'build-menu');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({ ...manifest, projectId })}\n`);
}

function writeRunningJob(workspace: string, projectId: string, jobId: string): string {
  const file = path.join(workspace, '.loam', 'build-menu', 'active-job.json');
  const body = `${JSON.stringify({
    schemaVersion: 1,
    jobId,
    projectId,
    revision: 1,
    kind: 'website',
    action: 'generate',
    phase: 'running',
  })}\n`;
  fs.writeFileSync(file, body);
  return body;
}

function writePointer(dir: string, projectId: string, workspace: string): string {
  const file = path.join(dir, `${projectId}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ workspace })}\n`);
  return file;
}

test('remembered job recovery does not spawn or signal a process', () => {
  const banned = ['child' + '_process', 'task' + 'kill', 'process' + '.kill', 'sp' + 'awn('];
  for (const token of banned) assert.equal(jobsSource.includes(token), false, token);
  assert.match(jobsSource, /if \(left !== right\) return false/);
  assert.match(jobsSource, /manifest\?\.projectId === projectId/);
  assert.match(jobsSource, /if \(!ownedJobWorkspace\(parsed\.workspace, projectId\)\) continue/);
  assert.equal(jobsSource.includes('listAppProjects'), false);
});

test('a foreign active-jobs pointer is skipped unless realpath and project id match', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-remembered-jobs-'));
  const activeJobs = path.join(root, '.loam', 'build-menu', 'active-jobs');
  const owned = path.join(root, 'owned');
  const foreign = path.join(root, 'foreign');
  const missing = path.join(root, 'missing');
  try {
    fs.mkdirSync(activeJobs, { recursive: true });
    writeManifest(owned, ownedId);
    writeManifest(foreign, foreignId);
    const ownedBody = writeRunningJob(owned, ownedId, 'job_owned');
    const foreignBody = writeRunningJob(foreign, foreignId, 'job_foreign');
    const foreignJob = path.join(foreign, '.loam', 'build-menu', 'active-job.json');
    const ownedJob = path.join(owned, '.loam', 'build-menu', 'active-job.json');
    assert.equal(samePath(fs.realpathSync(foreign), path.resolve(foreign)), true);
    assert.equal(samePath(fs.realpathSync(owned), path.resolve(owned)), true);

    const misnamed = writePointer(activeJobs, ownedId, foreign);
    const swapped = writePointer(activeJobs, foreignId, owned);
    const absent = writePointer(activeJobs, missingId, missing);
    assert.equal(recoverRememberedJobs(activeJobs), 0);
    assert.equal(fs.readFileSync(foreignJob, 'utf8'), foreignBody);
    assert.equal(fs.readFileSync(ownedJob, 'utf8'), ownedBody);
    assert.equal(JSON.parse(fs.readFileSync(foreignJob, 'utf8')).phase, 'running');
    assert.equal(JSON.parse(fs.readFileSync(ownedJob, 'utf8')).phase, 'running');
    assert.equal(fs.existsSync(missing), false);
    assert.equal(fs.existsSync(path.join(foreign, 'app')), false);
    assert.equal(fs.existsSync(path.join(owned, 'app')), false);
    assert.equal(fs.readFileSync(misnamed, 'utf8'), `${JSON.stringify({ workspace: foreign })}\n`);
    assert.equal(fs.readFileSync(swapped, 'utf8'), `${JSON.stringify({ workspace: owned })}\n`);
    assert.equal(fs.readFileSync(absent, 'utf8'), `${JSON.stringify({ workspace: missing })}\n`);

    writePointer(activeJobs, ownedId, owned);
    assert.equal(recoverRememberedJobs(activeJobs), 1);
    assert.equal(JSON.parse(fs.readFileSync(ownedJob, 'utf8')).phase, 'interrupted');
    assert.equal(fs.readFileSync(foreignJob, 'utf8'), foreignBody);
    assert.equal(JSON.parse(fs.readFileSync(foreignJob, 'utf8')).phase, 'running');
    assert.equal(fs.existsSync(missing), false);
    assert.equal(fs.existsSync(path.join(owned, 'app')), false);
    assert.equal(fs.existsSync(path.join(foreign, 'app')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
