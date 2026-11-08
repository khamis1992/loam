/**
 * A due local catch-up must not call connector.send, and a prompt that contains
 * mailto, a webhook URL, or https must not replace the saved local report.
 * Paused and disabled specs do not run. This file calls catchUpLocalReport with
 * a fixed clock. It does not import the scheduler or fire a schedule.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/catchupScheme.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { catchUpLocalReport } from '../automations/catchup.js';
import { BuildMenuError } from '../grants.js';

const NOW = new Date('2026-11-09T06:00:00.000Z');
const DUE_AT = '2026-11-09T06:00:00.000Z';
const KEPT = 'kept-local-report\n';
const SAFE_REPORT = `تقرير محلي\n${DUE_AT}\n`;

const REMOTE_PROMPTS = [
  'mailto:catchup-scheme@example.com',
  'webhook://hooks.example/catchup-scheme',
  'webhook https://hooks.example/catchup-scheme',
  'https://catchup-scheme.example/report',
] as const;

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-catchup-scheme-'));
  fs.mkdirSync(path.join(root, 'app'));
  return root;
}

function writeSpec(root: string, input: { enabled: boolean; paused: boolean; prompt: string }): void {
  fs.writeFileSync(path.join(root, 'app', 'automation.json'), `${JSON.stringify({
    cron: '0 9 * * 1',
    timezone: 'Asia/Qatar',
    dryRun: true,
    send: false,
    enabled: input.enabled,
    paused: input.paused,
    scheduleId: 'sched_local',
    prompt: input.prompt,
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

function refusedWrite(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

test('catchUpLocalReport does not call connector.send and keeps the Monday Qatar cron', () => {
  const source = fs.readFileSync(new URL('../automations/catchup.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export function catchUpLocalReport');
  assert.ok(start >= 0);
  const body = source.slice(start, source.indexOf('function readUntil'));
  assert.equal(body.includes('connector.send'), false);
  assert.equal(body.includes('.send('), false);
  assert.match(source, /spec\.cron !== '0 9 \* \* 1'/);
  assert.match(source, /spec\.timezone !== 'Asia\/Qatar'/);
  assert.equal(source.includes('startScheduler'), false);
});

test('a paused or disabled spec does not run or send', () => {
  const cases = [
    { name: 'paused', enabled: true, paused: true, prompt: 'mailto:catchup-scheme@example.com' },
    { name: 'disabled', enabled: false, paused: false, prompt: 'https://catchup-scheme.example/report' },
  ] as const;
  for (const item of cases) {
    const root = workspace();
    const report = path.join(root, 'app', 'local-report.txt');
    const before = Buffer.from(KEPT);
    fs.writeFileSync(report, before);
    writeSpec(root, { enabled: item.enabled, paused: item.paused, prompt: item.prompt });
    const mail = countingConnector();
    try {
      const result = catchUpLocalReport({ workspace: root, now: NOW, connector: mail.connector });
      assert.deepEqual(result, { ran: false, dueAt: null });
      assert.equal(mail.sent(), 0, item.name);
      assert.equal(fs.readFileSync(report).equals(before), true, item.name);
      assert.equal(fs.existsSync(path.join(root, 'app', 'runs.jsonl')), false, item.name);
      assert.equal(fs.existsSync(path.join(root, 'app', 'catchup.json')), false, item.name);
      const spec = JSON.parse(fs.readFileSync(path.join(root, 'app', 'automation.json'), 'utf8')) as { cron?: string; timezone?: string };
      assert.equal(spec.cron, '0 9 * * 1', item.name);
      assert.equal(spec.timezone, 'Asia/Qatar', item.name);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a due local report with mailto, a webhook url, or https does not send or replace the report', () => {
  for (const prompt of REMOTE_PROMPTS) {
    const root = workspace();
    const report = path.join(root, 'app', 'local-report.txt');
    const before = Buffer.from(KEPT);
    fs.writeFileSync(report, before);
    writeSpec(root, { enabled: true, paused: false, prompt });
    const mail = countingConnector();
    try {
      let result: { ran: boolean; dueAt: string | null };
      try {
        result = catchUpLocalReport({ workspace: root, now: NOW, connector: mail.connector });
      } catch (error) {
        assert.equal(mail.sent(), 0, prompt);
        assert.equal(refusedWrite(error), true, prompt);
        assert.equal(fs.readFileSync(report).equals(before), true, prompt);
        continue;
      }
      assert.deepEqual(result, { ran: true, dueAt: DUE_AT }, prompt);
      assert.equal(mail.sent(), 0, prompt);
      const after = fs.readFileSync(report);
      const text = after.toString('utf8');
      assert.equal(text.includes(prompt), false, prompt);
      assert.equal(/mailto:|https?:\/\/|webhook:\/\//i.test(text), false, prompt);
      assert.equal(text === KEPT || text === SAFE_REPORT, true, text);
      const spec = JSON.parse(fs.readFileSync(path.join(root, 'app', 'automation.json'), 'utf8')) as { cron?: string; timezone?: string };
      assert.equal(spec.cron, '0 9 * * 1');
      assert.equal(spec.timezone, 'Asia/Qatar');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
