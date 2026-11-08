/**
 * An existing registry pointer with nlink greater than 1 is refused before
 * write, and the hard-linked bytes stay. A new pointer still saves. A paused
 * routine does not run. This file does not start the scheduler and does not
 * create a symlink or junction.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/openHardLink.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildMenuError } from '../grants.js';
import { openRememberedRoutines, rememberOpenRoutine } from '../automations/open.js';

const DUE = new Date('2026-11-09T06:00:00.000Z');
const PROMPT = 'dry-run local report only. Do not send, publish, purchase, or delete.';

function registryFor(root: string): string {
  return path.join(root, '.loam', 'build-menu', 'open-routines');
}

function writeRoutine(dir: string, projectId: string, paused: boolean): void {
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'automation.json'), `${JSON.stringify({
    cron: '0 9 * * 1',
    timezone: 'Asia/Qatar',
    dryRun: true,
    enabled: true,
    paused,
    send: false,
    scheduleId: 'sched_local',
    prompt: PROMPT,
  })}\n`);
  const manifestDir = path.join(dir, '.loam', 'build-menu');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectId,
    revision: 1,
    selection: { kind: 'automation' },
    title: 'تقرير',
    sourceDir: 'app',
    template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
    consent: { autostart: false, publish: false },
  })}\n`);
}

function mail(): { sent: () => number; connector: { send: () => void } } {
  let count = 0;
  return {
    sent: () => count,
    connector: {
      send(): void {
        count += 1;
      },
    },
  };
}

function isUnsafePath(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

test('an existing pointer with nlink greater than 1 is refused and outside bytes stay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-open-hardlink-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-open-hardlink-out-'));
  const registry = path.join(root, 'registry');
  const workspace = path.join(root, 'workspace');
  const projectId = 'app_bcdfghjkmnpw';
  const pointer = path.join(registry, `${projectId}.json`);
  const outsideFile = path.join(outside, 'secret.txt');
  const previous = Buffer.from('keep-outside');
  try {
    fs.mkdirSync(registry);
    fs.mkdirSync(workspace);
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, pointer);
    const stat = fs.lstatSync(pointer);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.throws(() => rememberOpenRoutine(registry, projectId, workspace), isUnsafePath);
    assert.equal(fs.lstatSync(pointer).nlink > 1, true);
    assert.equal(fs.lstatSync(pointer).isSymbolicLink(), false);
    assert.deepEqual(fs.readFileSync(pointer), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a normal new pointer still saves', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-open-hardlink-new-'));
  const registry = path.join(root, 'registry');
  const workspace = path.join(root, 'workspace');
  const projectId = 'app_bcdfghjkmnpx';
  const pointer = path.join(registry, `${projectId}.json`);
  try {
    fs.mkdirSync(workspace);
    assert.equal(fs.existsSync(pointer), false);
    rememberOpenRoutine(registry, projectId, workspace);
    const stat = fs.lstatSync(pointer);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.equal(JSON.parse(fs.readFileSync(pointer, 'utf8')).workspace, path.resolve(workspace));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a paused routine does not run when its pointer is opened', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-open-hardlink-pause-'));
  const registry = registryFor(root);
  const projectId = 'app_bcdfghjkmnpy';
  const workspace = path.join(root, 'paused');
  const pointer = path.join(registry, `${projectId}.json`);
  try {
    fs.mkdirSync(registry, { recursive: true });
    writeRoutine(workspace, projectId, true);
    fs.writeFileSync(pointer, `${JSON.stringify({ workspace: path.resolve(workspace) })}\n`);
    const stat = fs.lstatSync(pointer);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    const counted = mail();
    const opened = openRememberedRoutines({ registryDir: registry, now: DUE, connector: counted.connector });
    assert.deepEqual(opened, [{ ran: false, dueAt: null }]);
    assert.equal(counted.sent(), 0);
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'local-report.txt')), false);
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'runs.jsonl')), false);
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'proposed.json')), false);
    const spec = JSON.parse(fs.readFileSync(path.join(workspace, 'app', 'automation.json'), 'utf8')) as { cron?: string; timezone?: string; paused?: boolean };
    assert.equal(spec.cron, '0 9 * * 1');
    assert.equal(spec.timezone, 'Asia/Qatar');
    assert.equal(spec.paused, true);
    const openSource = fs.readFileSync(new URL('../automations/open.ts', import.meta.url), 'utf8');
    assert.equal(openSource.includes('startScheduler'), false);
    assert.equal(openSource.includes('symlinkSync'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
