/**
 * Catch-up reads of app/automation.json and the catch-up marker refuse an
 * existing file whose nlink is greater than 1 before readFileSync. Outside
 * bytes stay unread. A regular nlink 1 file still reads. EPERM from lstat is
 * not caught. A live owner still skips catch-up and leaves the saved report
 * and lock unchanged. Cron stays 0 9 * * 1 and timezone stays Asia/Qatar.
 * This file does not call connector.send or start the scheduler. Hard links
 * use fs.linkSync. It does not create a symlink or junction.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/catchupReadHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { catchUpLocalReport, holdCatchUp } from '../automations/catchup.js';
import { BuildMenuError } from '../grants.js';

const NOW = new Date('2026-11-09T06:00:00.000Z');
const DUE_AT = '2026-11-09T06:00:00.000Z';
const KEPT = 'kept-local-report\n';
const LOCK_BODY = 'live-owner\n';
const OUTSIDE = Buffer.from('outside-secret-bytes\n');

function withWorkspace(run: (workspace: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-catchup-read-'));
  const workspace = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(workspace, 'app'), { recursive: true });
  fs.mkdirSync(outside);
  try {
    run(workspace, outside);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeSpec(workspace: string): void {
  fs.writeFileSync(path.join(workspace, 'app', 'automation.json'), `${JSON.stringify({
    cron: '0 9 * * 1',
    timezone: 'Asia/Qatar',
    dryRun: true,
    send: false,
    enabled: true,
    paused: false,
    scheduleId: 'sched_local',
    prompt: 'dry-run local report only. Do not send, publish, purchase, or delete.',
  })}\n`);
}

function countingConnector(): { sent: () => number; connector: { send: () => void } } {
  let sent = 0;
  return {
    sent: () => sent,
    connector: {
      send(): void {
        sent += 1;
        throw new Error('mail_called');
      },
    },
  };
}

function refused(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.equal(start >= 0, true, signature);
  const next = source.indexOf('\nfunction ', start + signature.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function hardLink(outsideDir: string, destination: string, bytes: Buffer): string {
  const outsideFile = path.join(outsideDir, path.basename(destination));
  fs.writeFileSync(outsideFile, bytes);
  fs.linkSync(outsideFile, destination);
  return outsideFile;
}

function keepReportAndLock(workspace: string): { report: string; lock: string; reportBytes: Buffer } {
  const report = path.join(workspace, 'app', 'local-report.txt');
  const lock = path.join(workspace, 'app', 'catchup.lock');
  const reportBytes = Buffer.from(KEPT);
  fs.writeFileSync(report, reportBytes);
  fs.writeFileSync(lock, LOCK_BODY);
  return { report, lock, reportBytes };
}

function assertUnread(file: string, run: () => void): void {
  const resolved = path.resolve(file);
  const realReadFileSync = fs.readFileSync;
  let reads = 0;
  const patched = ((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (typeof target !== 'number' && path.resolve(String(target)) === resolved) reads += 1;
    return realReadFileSync(target, options);
  }) as typeof fs.readFileSync;
  fs.readFileSync = patched;
  try {
    run();
  } finally {
    fs.readFileSync = realReadFileSync;
  }
  assert.equal(reads, 0);
}

function withLstatCode(file: string, code: string, run: () => void): void {
  const resolved = path.resolve(file);
  const realLstatSync = fs.lstatSync;
  Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (path.resolve(String(target)) === resolved) {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = code;
      throw error;
    }
    return realLstatSync(target, options);
  }) as typeof fs.lstatSync });
  try {
    run();
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
  }
}

test('catch-up reads refuse nlink before readFileSync and do not catch EPERM', () => {
  const source = fs.readFileSync(new URL('../automations/catchup.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('startScheduler'), false);
  assert.equal(source.includes('connector.send'), false);
  assert.equal(source.includes('.send('), false);
  assert.equal(source.includes('EPERM'), false);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.match(source, /spec\.cron !== '0 9 \* \* 1'/);
  assert.match(source, /spec\.timezone !== 'Asia\/Qatar'/);
  assert.equal((source.match(/fs\.readFileSync\(/g) ?? []).length, 2);
  for (const signature of ['function readSpec', 'function readMarker']) {
    const body = bodyOf(source, signature);
    const guardAt = body.indexOf('assertReadableFile(');
    const readAt = body.indexOf('fs.readFileSync(');
    assert.equal(guardAt >= 0, true, signature);
    assert.equal(readAt > guardAt, true, signature);
  }
  const guard = bodyOf(source, 'function assertReadableFile');
  assert.equal(guard.indexOf('stat.nlink > 1') >= 0, true);
  assert.equal(guard.includes('catch'), false);
  assert.equal(guard.includes('readFileSync'), false);
});

test('a regular nlink 1 spec still runs and a regular nlink 1 marker still skips', () => {
  withWorkspace((workspace) => {
    const file = path.join(workspace, 'app', 'automation.json');
    writeSpec(workspace);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    const mail = countingConnector();
    const result = catchUpLocalReport({ workspace, now: NOW, connector: mail.connector });
    assert.deepEqual(result, { ran: true, dueAt: DUE_AT });
    assert.equal(mail.sent(), 0);
    assert.equal(fs.readFileSync(path.join(workspace, 'app', 'local-report.txt'), 'utf8'), `تقرير محلي\n${DUE_AT}\n`);
    const written = fs.lstatSync(path.join(workspace, 'app', 'catchup.json'));
    assert.equal(written.isSymbolicLink(), false);
    assert.equal(written.isFile(), true);
    assert.equal(written.nlink, 1);
    assert.equal(fs.lstatSync(file).nlink, 1);
    const spec = JSON.parse(fs.readFileSync(file, 'utf8')) as { cron?: string; timezone?: string };
    assert.equal(spec.cron, '0 9 * * 1');
    assert.equal(spec.timezone, 'Asia/Qatar');
  });

  withWorkspace((workspace) => {
    const file = path.join(workspace, 'app', 'automation.json');
    const marker = path.join(workspace, 'app', 'catchup.json');
    writeSpec(workspace);
    const markerBytes = Buffer.from(`${JSON.stringify({
      dedupeKey: `sched_local\u0000${DUE_AT}`,
      lastDueAt: DUE_AT,
    })}\n`);
    fs.writeFileSync(marker, markerBytes);
    const stat = fs.lstatSync(marker);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.equal(fs.lstatSync(file).nlink, 1);
    const mail = countingConnector();
    const result = catchUpLocalReport({ workspace, now: NOW, connector: mail.connector });
    assert.deepEqual(result, { ran: false, dueAt: DUE_AT });
    assert.equal(mail.sent(), 0);
    assert.deepEqual(fs.readFileSync(marker), markerBytes);
    assert.equal(fs.lstatSync(marker).nlink, 1);
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'runs.jsonl')), false);
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'local-report.txt')), false);
  });
});

test('a hard-linked automation.json is refused before read and the outside bytes stay', () => {
  withWorkspace((workspace, outside) => {
    const file = path.join(workspace, 'app', 'automation.json');
    const outsideFile = hardLink(outside, file, OUTSIDE);
    const linked = fs.lstatSync(file);
    assert.equal(linked.isSymbolicLink(), false);
    assert.equal(linked.isFile(), true);
    assert.equal(linked.nlink > 1, true);
    assert.equal(linked.ino, fs.lstatSync(outsideFile).ino);
    const { report, lock, reportBytes } = keepReportAndLock(workspace);
    const mail = countingConnector();
    assertUnread(file, () => {
      assert.throws(
        () => catchUpLocalReport({ workspace, now: NOW, connector: mail.connector }),
        refused,
      );
    });
    assert.equal(mail.sent(), 0);
    assert.deepEqual(fs.readFileSync(file), OUTSIDE);
    assert.deepEqual(fs.readFileSync(outsideFile), OUTSIDE);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);
    assert.deepEqual(fs.readFileSync(report), reportBytes);
    assert.equal(fs.readFileSync(lock, 'utf8'), LOCK_BODY);
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'catchup.json')), false);
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'runs.jsonl')), false);
  });
});

test('a hard-linked catch-up marker is refused before read and the outside bytes stay', () => {
  withWorkspace((workspace, outside) => {
    const file = path.join(workspace, 'app', 'catchup.json');
    writeSpec(workspace);
    const outsideFile = hardLink(outside, file, OUTSIDE);
    const linked = fs.lstatSync(file);
    assert.equal(linked.isSymbolicLink(), false);
    assert.equal(linked.isFile(), true);
    assert.equal(linked.nlink > 1, true);
    assert.equal(linked.ino, fs.lstatSync(outsideFile).ino);
    const { report, lock, reportBytes } = keepReportAndLock(workspace);
    const mail = countingConnector();
    assertUnread(file, () => {
      assert.throws(
        () => catchUpLocalReport({ workspace, now: NOW, connector: mail.connector }),
        refused,
      );
    });
    assert.equal(mail.sent(), 0);
    assert.deepEqual(fs.readFileSync(file), OUTSIDE);
    assert.deepEqual(fs.readFileSync(outsideFile), OUTSIDE);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);
    assert.deepEqual(fs.readFileSync(report), reportBytes);
    assert.equal(fs.readFileSync(lock, 'utf8'), LOCK_BODY);
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'runs.jsonl')), false);
    const spec = JSON.parse(fs.readFileSync(path.join(workspace, 'app', 'automation.json'), 'utf8')) as { cron?: string; timezone?: string };
    assert.equal(spec.cron, '0 9 * * 1');
    assert.equal(spec.timezone, 'Asia/Qatar');
  });
});

test('lstat EPERM on the spec or the marker escapes', () => {
  withWorkspace((workspace) => {
    const file = path.join(workspace, 'app', 'automation.json');
    writeSpec(workspace);
    const specBytes = fs.readFileSync(file);
    assert.equal(fs.lstatSync(file).nlink, 1);
    const { report, lock, reportBytes } = keepReportAndLock(workspace);
    const mail = countingConnector();
    withLstatCode(file, 'EPERM', () => {
      assert.throws(
        () => catchUpLocalReport({ workspace, now: NOW, connector: mail.connector }),
        isEperm,
      );
    });
    assert.equal(mail.sent(), 0);
    assert.equal(fs.lstatSync(file).nlink, 1);
    assert.deepEqual(fs.readFileSync(file), specBytes);
    assert.deepEqual(fs.readFileSync(report), reportBytes);
    assert.equal(fs.readFileSync(lock, 'utf8'), LOCK_BODY);
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'catchup.json')), false);
  });

  withWorkspace((workspace) => {
    const file = path.join(workspace, 'app', 'catchup.json');
    writeSpec(workspace);
    const markerBytes = Buffer.from('marker-bytes\n');
    fs.writeFileSync(file, markerBytes);
    assert.equal(fs.lstatSync(file).nlink, 1);
    const { report, lock, reportBytes } = keepReportAndLock(workspace);
    const mail = countingConnector();
    withLstatCode(file, 'EPERM', () => {
      assert.throws(
        () => catchUpLocalReport({ workspace, now: NOW, connector: mail.connector }),
        isEperm,
      );
    });
    assert.equal(mail.sent(), 0);
    assert.equal(fs.lstatSync(file).nlink, 1);
    assert.deepEqual(fs.readFileSync(file), markerBytes);
    assert.deepEqual(fs.readFileSync(report), reportBytes);
    assert.equal(fs.readFileSync(lock, 'utf8'), LOCK_BODY);
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'runs.jsonl')), false);
  });
});

test('a live owner still skips catch-up and leaves the saved report and lock unchanged', () => {
  withWorkspace((workspace) => {
    const report = path.join(workspace, 'app', 'local-report.txt');
    const lock = path.join(workspace, 'app', 'catchup.lock');
    const reportBytes = Buffer.from(KEPT);
    fs.writeFileSync(report, reportBytes);
    fs.writeFileSync(lock, LOCK_BODY);
    writeSpec(workspace);
    const mail = countingConnector();
    const release = holdCatchUp(workspace);
    try {
      const result = catchUpLocalReport({ workspace, now: NOW, connector: mail.connector });
      assert.deepEqual(result, { ran: false, dueAt: DUE_AT });
      assert.equal(mail.sent(), 0);
      assert.deepEqual(fs.readFileSync(report), reportBytes);
      assert.equal(fs.readFileSync(lock, 'utf8'), LOCK_BODY);
      assert.equal(fs.existsSync(path.join(workspace, 'app', 'runs.jsonl')), false);
      assert.equal(fs.existsSync(path.join(workspace, 'app', 'catchup.json')), false);
      const spec = JSON.parse(fs.readFileSync(path.join(workspace, 'app', 'automation.json'), 'utf8')) as { cron?: string; timezone?: string };
      assert.equal(spec.cron, '0 9 * * 1');
      assert.equal(spec.timezone, 'Asia/Qatar');
    } finally {
      release();
    }
  });
});
