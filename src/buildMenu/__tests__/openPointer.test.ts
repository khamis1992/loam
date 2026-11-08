/**
 * A registry pointer that is a directory, or whose target is outside the
 * Loam workspace, is skipped and does not start a routine. A paused routine
 * does not run. Cron stays 0 9 * * 1 Asia/Qatar. This file does not start
 * the scheduler and does not create a symlink or junction.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/openPointer.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRememberedRoutines } from '../automations/open.js';

const DUE = new Date('2026-11-09T06:00:00.000Z');
const DUE_AT = '2026-11-09T06:00:00.000Z';
const PROMPT = 'dry-run local report only. Do not send, publish, purchase, or delete.';

function registryFor(root: string): string {
  return path.join(root, '.loam', 'build-menu', 'open-routines');
}

function writeRoutine(dir: string, projectId: string, enabled: boolean, paused: boolean): void {
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'automation.json'), `${JSON.stringify({
    cron: '0 9 * * 1',
    timezone: 'Asia/Qatar',
    dryRun: true,
    enabled,
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

function writePointer(registry: string, projectId: string, workspace: string): string {
  const pointer = path.join(registry, `${projectId}.json`);
  fs.writeFileSync(pointer, `${JSON.stringify({ workspace })}\n`);
  return pointer;
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

function assertIdle(dir: string): void {
  assert.equal(fs.existsSync(path.join(dir, 'app', 'local-report.txt')), false);
  assert.equal(fs.existsSync(path.join(dir, 'app', 'runs.jsonl')), false);
  assert.equal(fs.existsSync(path.join(dir, 'app', 'proposed.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'app', 'catchup.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'app', 'catchup.lock')), false);
}

function cronStays(dir: string): void {
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'app', 'automation.json'), 'utf8')) as { cron?: string; timezone?: string };
  assert.equal(spec.cron, '0 9 * * 1');
  assert.equal(spec.timezone, 'Asia/Qatar');
}

test('a directory pointer is skipped and does not start a routine', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-open-pointer-dir-'));
  const registry = registryFor(root);
  const projectId = 'app_bcdfghjkmnpq';
  const pointer = path.join(registry, `${projectId}.json`);
  const marker = path.join(pointer, 'keep.txt');
  try {
    writeRoutine(pointer, projectId, true, false);
    fs.writeFileSync(marker, 'keep');
    const counted = mail();
    const opened = openRememberedRoutines({ registryDir: registry, now: DUE, connector: counted.connector });
    assert.deepEqual(opened, []);
    assert.equal(counted.sent(), 0);
    assert.equal(fs.lstatSync(pointer).isDirectory(), true);
    assert.equal(fs.lstatSync(pointer).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
    assertIdle(pointer);
    cronStays(pointer);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a pointer target outside the workspace is skipped and does not start a routine', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-open-pointer-out-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-open-outside-'));
  const registry = registryFor(root);
  const insideId = 'app_bcdfghjkmnpt';
  const outsideId = 'app_bcdfghjkmnpr';
  const inside = path.join(root, 'enabled');
  const escaped = `${inside}${path.sep}..${path.sep}..${path.sep}${path.basename(outside)}`;
  try {
    fs.mkdirSync(registry, { recursive: true });
    writeRoutine(inside, insideId, true, false);
    writeRoutine(outside, outsideId, true, false);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'keep');
    assert.equal(path.isAbsolute(outside), true);
    assert.equal(path.resolve(escaped), path.resolve(outside));
    assert.equal(escaped.includes('..'), true);
    assert.equal(path.relative(root, path.resolve(outside)).startsWith('..'), true);
    writePointer(registry, outsideId, path.resolve(outside));
    const traversalId = 'app_bcdfghjkmnpv';
    const traversal = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-open-traversal-'));
      const traversalPath = `${inside}${path.sep}..${path.sep}..${path.sep}${path.basename(traversal)}`;
    try {
      writeRoutine(traversal, traversalId, true, false);
      fs.writeFileSync(path.join(traversal, 'secret.txt'), 'keep');
      assert.equal(path.resolve(traversalPath), path.resolve(traversal));
      writePointer(registry, traversalId, traversalPath);
      writePointer(registry, insideId, path.resolve(inside));
      const counted = mail();
      const opened = openRememberedRoutines({ registryDir: registry, now: DUE, connector: counted.connector });
      assert.equal(opened.filter((item) => item.ran).length, 1);
      assert.equal(opened.find((item) => item.ran)?.dueAt, DUE_AT);
      assert.equal(counted.sent(), 0);
      assert.match(fs.readFileSync(path.join(inside, 'app', 'local-report.txt'), 'utf8'), /تقرير محلي/);
      assertIdle(outside);
      assertIdle(traversal);
      assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'keep');
      assert.equal(fs.readFileSync(path.join(traversal, 'secret.txt'), 'utf8'), 'keep');
      cronStays(inside);
      cronStays(outside);
      cronStays(traversal);
    } finally {
      fs.rmSync(traversal, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a paused routine does not run when its pointer is opened', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-open-pointer-pause-'));
  const registry = registryFor(root);
  const projectId = 'app_bcdfghjkmnps';
  const workspace = path.join(root, 'paused');
  try {
    fs.mkdirSync(registry, { recursive: true });
    writeRoutine(workspace, projectId, true, true);
    writePointer(registry, projectId, path.resolve(workspace));
    const counted = mail();
    const opened = openRememberedRoutines({ registryDir: registry, now: DUE, connector: counted.connector });
    assert.deepEqual(opened, [{ ran: false, dueAt: null }]);
    assert.equal(counted.sent(), 0);
    assertIdle(workspace);
    cronStays(workspace);
    const spec = JSON.parse(fs.readFileSync(path.join(workspace, 'app', 'automation.json'), 'utf8')) as { paused?: boolean; enabled?: boolean };
    assert.equal(spec.enabled, true);
    assert.equal(spec.paused, true);
    const openSource = fs.readFileSync(new URL('../automations/open.ts', import.meta.url), 'utf8');
    const catchupSource = fs.readFileSync(new URL('../automations/catchup.ts', import.meta.url), 'utf8');
    const scheduler = fs.readFileSync(new URL('../../server/scheduler.ts', import.meta.url), 'utf8');
    assert.equal(openSource.includes('startScheduler'), false);
    assert.equal(openSource.includes('0 9 * * 1'), false);
    assert.match(catchupSource, /spec\.cron !== '0 9 \* \* 1'/);
    assert.match(catchupSource, /spec\.timezone !== 'Asia\/Qatar'/);
    assert.equal(scheduler.includes('openRememberedRoutines'), false);
    assert.equal(scheduler.includes('catchUpLocalReport'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
