/**
 * openRememberedRoutines refuses a pointer whose nlink is greater than 1
 * before readFileSync, and does not parse the outside bytes. A regular nlink 1
 * pointer still reads. A paused routine does not run. Hard links use
 * fs.linkSync. EPERM is not caught. This file does not start the scheduler
 * and does not create a symlink or junction.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/openReadHardLink.test.ts
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

function pointerBytes(workspace: string): Buffer {
  return Buffer.from(`${JSON.stringify({ workspace: path.resolve(workspace) })}\n`);
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

function withPair(prefix: string, run: (root: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}out-`));
  try {
    run(root, outside);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

test('the read refuses nlink before readFileSync and keeps the write check and outside skip', () => {
  const source = fs.readFileSync(new URL('../automations/open.ts', import.meta.url), 'utf8');
  const rememberStart = source.indexOf('export function rememberOpenRoutine');
  const rememberEnd = source.indexOf('export function forgetOpenRoutine');
  const remember = source.slice(rememberStart, rememberEnd);
  const openStart = source.indexOf('export function openRememberedRoutines');
  const openBody = source.slice(openStart);
  const writeGuard = remember.indexOf('existing.nlink > 1');
  const writeAt = remember.indexOf('fs.writeFileSync');
  const readGuard = openBody.indexOf('pointerStat.nlink > 1');
  const readAt = openBody.indexOf('fs.readFileSync');
  const outsideSkip = openBody.indexOf('if (boundary && !isInside(boundary, parsed.workspace)) continue;');
  assert.ok(rememberStart >= 0);
  assert.ok(rememberEnd > rememberStart);
  assert.ok(openStart > rememberEnd);
  assert.ok(writeGuard >= 0);
  assert.ok(writeAt > writeGuard);
  assert.ok(readGuard >= 0);
  assert.ok(readAt > readGuard);
  assert.ok(outsideSkip > readAt);
  assert.equal(source.includes('startScheduler'), false);
  assert.equal(source.includes('EPERM'), false);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  const scheduler = fs.readFileSync(new URL('../../server/scheduler.ts', import.meta.url), 'utf8');
  assert.equal(scheduler.includes('openRememberedRoutines'), false);
  assert.equal(scheduler.includes('catchUpLocalReport'), false);
});

test('a pointer with nlink greater than 1 is refused before read and the outside bytes stay', () => {
  withPair('loam-48-open-read-hard-', (root, outside) => {
    const registry = registryFor(root);
    const projectId = 'app_bcdfghjkmnqa';
    const workspace = path.join(root, 'enabled');
    const pointer = path.join(registry, `${projectId}.json`);
    const outsideFile = path.join(outside, 'secret.json');
    const previous = pointerBytes(workspace);
    fs.mkdirSync(registry, { recursive: true });
    writeRoutine(workspace, projectId, false);
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, pointer);
    const stat = fs.lstatSync(pointer);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    assert.equal(JSON.parse(previous.toString('utf8')).workspace, path.resolve(workspace));
    const counted = mail();
    const opened = openRememberedRoutines({ registryDir: registry, now: DUE, connector: counted.connector });
    assert.deepEqual(opened, []);
    assert.equal(counted.sent(), 0);
    assertIdle(workspace);
    assert.deepEqual(fs.readFileSync(pointer), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.equal(fs.lstatSync(pointer).nlink > 1, true);
    assert.equal(fs.lstatSync(pointer).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(outsideFile).nlink > 1, true);
  });
});

test('a regular nlink 1 pointer still reads', () => {
  withPair('loam-48-open-read-nlink1-', (root) => {
    const registry = registryFor(root);
    const projectId = 'app_bcdfghjkmnqb';
    const workspace = path.join(root, 'enabled');
    const pointer = path.join(registry, `${projectId}.json`);
    fs.mkdirSync(registry, { recursive: true });
    writeRoutine(workspace, projectId, false);
    const bytes = pointerBytes(workspace);
    fs.writeFileSync(pointer, bytes);
    const stat = fs.lstatSync(pointer);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    const counted = mail();
    const opened = openRememberedRoutines({ registryDir: registry, now: DUE, connector: counted.connector });
    assert.deepEqual(opened, [{ ran: true, dueAt: DUE_AT }]);
    assert.equal(counted.sent(), 0);
    assert.match(fs.readFileSync(path.join(workspace, 'app', 'local-report.txt'), 'utf8'), /تقرير محلي/);
    assert.equal(fs.lstatSync(pointer).nlink, 1);
    assert.deepEqual(fs.readFileSync(pointer), bytes);
  });
});

test('a paused routine does not run when its pointer is opened', () => {
  withPair('loam-48-open-read-pause-', (root) => {
    const registry = registryFor(root);
    const projectId = 'app_bcdfghjkmnqc';
    const workspace = path.join(root, 'paused');
    const pointer = path.join(registry, `${projectId}.json`);
    fs.mkdirSync(registry, { recursive: true });
    writeRoutine(workspace, projectId, true);
    fs.writeFileSync(pointer, pointerBytes(workspace));
    const stat = fs.lstatSync(pointer);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    const counted = mail();
    const opened = openRememberedRoutines({ registryDir: registry, now: DUE, connector: counted.connector });
    assert.deepEqual(opened, [{ ran: false, dueAt: null }]);
    assert.equal(counted.sent(), 0);
    assertIdle(workspace);
    const spec = JSON.parse(fs.readFileSync(path.join(workspace, 'app', 'automation.json'), 'utf8')) as { cron?: string; timezone?: string; paused?: boolean };
    assert.equal(spec.cron, '0 9 * * 1');
    assert.equal(spec.timezone, 'Asia/Qatar');
    assert.equal(spec.paused, true);
  });
});

test('a pointer outside the workspace is still skipped', () => {
  withPair('loam-48-open-read-outside-', (root, outside) => {
    const registry = registryFor(root);
    const projectId = 'app_bcdfghjkmnqd';
    const pointer = path.join(registry, `${projectId}.json`);
    const secret = path.join(outside, 'secret.txt');
    const previous = Buffer.from('keep-outside');
    fs.mkdirSync(registry, { recursive: true });
    writeRoutine(outside, projectId, false);
    fs.writeFileSync(secret, previous);
    const bytes = pointerBytes(outside);
    fs.writeFileSync(pointer, bytes);
    const stat = fs.lstatSync(pointer);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.equal(path.relative(root, path.resolve(outside)).startsWith('..'), true);
    const counted = mail();
    const opened = openRememberedRoutines({ registryDir: registry, now: DUE, connector: counted.connector });
    assert.deepEqual(opened, []);
    assert.equal(counted.sent(), 0);
    assertIdle(outside);
    assert.deepEqual(fs.readFileSync(secret), previous);
    assert.deepEqual(fs.readFileSync(pointer), bytes);
    assert.equal(fs.lstatSync(pointer).nlink, 1);
  });
});

test('openRememberedRoutines lets EPERM from lstat escape', () => {
  withPair('loam-48-open-read-eperm-', (root) => {
    const registry = registryFor(root);
    const projectId = 'app_bcdfghjkmnqe';
    const workspace = path.join(root, 'enabled');
    const pointer = path.join(registry, `${projectId}.json`);
    fs.mkdirSync(registry, { recursive: true });
    writeRoutine(workspace, projectId, false);
    const bytes = pointerBytes(workspace);
    fs.writeFileSync(pointer, bytes);
    assert.equal(fs.lstatSync(pointer).nlink, 1);
    const realLstatSync = fs.lstatSync;
    const patched = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) !== path.resolve(pointer)) return realLstatSync(target, options);
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }) as typeof fs.lstatSync;
    Object.defineProperty(fs, 'lstatSync', { value: patched });
    try {
      const counted = mail();
      assert.throws(
        () => openRememberedRoutines({ registryDir: registry, now: DUE, connector: counted.connector }),
        isEperm,
      );
      assert.equal(counted.sent(), 0);
      assert.equal(realLstatSync(pointer).nlink, 1);
      assert.deepEqual(fs.readFileSync(pointer), bytes);
      assertIdle(workspace);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    }
  });
});
