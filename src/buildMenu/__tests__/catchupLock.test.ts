/**
 * A catch-up lock held by a live owner is skipped and does not replace the
 * saved local report. This file calls catchUpLocalReport with a fixed clock.
 * It does not import the scheduler or call connector.send.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/catchupLock.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { catchUpLocalReport, holdCatchUp } from '../automations/catchup.js';

const NOW = new Date('2026-11-09T06:00:00.000Z');
const DUE_AT = '2026-11-09T06:00:00.000Z';
const KEPT = 'kept-local-report\n';
const LOCK_BODY = 'live-owner\n';

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-catchup-lock-'));
  fs.mkdirSync(path.join(root, 'app'));
  return root;
}

function writeSpec(root: string): void {
  fs.writeFileSync(path.join(root, 'app', 'automation.json'), `${JSON.stringify({
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

test('a catch-up lock held by a live owner is skipped and the saved report stays', () => {
  const root = workspace();
  const report = path.join(root, 'app', 'local-report.txt');
  const lock = path.join(root, 'app', 'catchup.lock');
  const before = Buffer.from(KEPT);
  fs.writeFileSync(report, before);
  fs.writeFileSync(lock, LOCK_BODY);
  writeSpec(root);
  const mail = countingConnector();
  const release = holdCatchUp(root);
  try {
    const result = catchUpLocalReport({ workspace: root, now: NOW, connector: mail.connector });
    assert.deepEqual(result, { ran: false, dueAt: DUE_AT });
    assert.equal(mail.sent(), 0);
    assert.equal(fs.readFileSync(report).equals(before), true);
    assert.equal(fs.readFileSync(lock, 'utf8'), LOCK_BODY);
    assert.equal(fs.existsSync(path.join(root, 'app', 'runs.jsonl')), false);
    assert.equal(fs.existsSync(path.join(root, 'app', 'catchup.json')), false);
    const spec = JSON.parse(fs.readFileSync(path.join(root, 'app', 'automation.json'), 'utf8')) as { cron?: string; timezone?: string };
    assert.equal(spec.cron, '0 9 * * 1');
    assert.equal(spec.timezone, 'Asia/Qatar');
  } finally {
    release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
