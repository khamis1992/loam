/**
 * registerDryRun refuses a spec whose prompt or cron contains mailto, tel, sms,
 * intent, market, https, or javascript, including one percent-decode, before
 * the add callback runs. A normal local dry-run spec still registers disabled.
 * Cron stays 0 9 * * 1 Asia/Qatar. This file does not call connector.send or
 * start the scheduler.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/registerRemote.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerDryRun } from '../automations/register.js';
import { BuildMenuError } from '../grants.js';

const SCHEMES = ['mailto', 'tel', 'sms', 'intent', 'market', 'https', 'javascript'] as const;

const LITERAL: Record<(typeof SCHEMES)[number], string> = {
  mailto: 'mailto:user@example.com',
  tel: 'tel:+97455500000',
  sms: 'sms:+97455500000',
  intent: 'intent:#Intent;end',
  market: 'market://details',
  https: 'https://example.com/report',
  javascript: 'javascript:alert(1)',
};

function encodeOnce(value: string): string {
  return Array.from(value, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
}

function localSpec(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cron: '0 9 * * 1',
    timezone: 'Asia/Qatar',
    dryRun: true,
    send: false,
    enabled: false,
    ...extra,
  };
}

function withSpec(spec: Record<string, unknown>, check: (root: string, file: string, before: Buffer) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-register-remote-'));
  const file = path.join(root, 'app', 'automation.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(spec)}\n`);
  const before = fs.readFileSync(file);
  try {
    check(root, file, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function refused(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

function expectRefused(root: string, file: string, before: Buffer, label: string): void {
  let calls = 0;
  assert.throws(
    () => registerDryRun(root, () => {
      calls += 1;
      return { id: 'sched_remote', enabled: false };
    }),
    refused,
    label,
  );
  assert.equal(calls, 0, label);
  assert.equal(fs.readFileSync(file).equals(before), true, label);
}

test('registerDryRun does not call connector.send or start the scheduler', () => {
  const source = fs.readFileSync(new URL('../automations/register.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export function registerDryRun');
  assert.ok(start >= 0);
  const body = source.slice(start);
  assert.equal(body.includes('connector.send'), false);
  assert.equal(body.includes('.send('), false);
  assert.equal(source.includes('startScheduler'), false);
  assert.match(source, /spec\.cron !== '0 9 \* \* 1'/);
  assert.match(source, /spec\.timezone !== 'Asia\/Qatar'/);
  assert.match(source, /enabled: false/);
  assert.match(body, /dry-run local report only\. Do not send, publish, purchase, or delete\./);
});

test('a normal local dry-run spec registers disabled', () => {
  const specs = [
    localSpec(),
    localSpec({ enabled: true, prompt: 'تقرير محلي أسبوعي' }),
  ];
  for (const spec of specs) {
    withSpec(spec, (root, file) => {
      let calls = 0;
      const created = registerDryRun(root, (row) => {
        calls += 1;
        assert.equal(row.enabled, false);
        assert.equal(row.cron, '0 9 * * 1');
        assert.equal(row.timezone, 'Asia/Qatar');
        assert.equal(row.prompt, 'dry-run local report only. Do not send, publish, purchase, or delete.');
        return { id: 'sched_local', enabled: row.enabled };
      });
      assert.equal(calls, 1);
      assert.deepEqual(created, { scheduleId: 'sched_local', enabled: false });
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { cron?: string; timezone?: string; scheduleId?: string };
      assert.equal(stored.cron, '0 9 * * 1');
      assert.equal(stored.timezone, 'Asia/Qatar');
      assert.equal(stored.scheduleId, 'sched_local');
      let again = 0;
      const second = registerDryRun(root, () => {
        again += 1;
        return { id: 'sched_other', enabled: false };
      });
      assert.equal(again, 0);
      assert.deepEqual(second, { scheduleId: 'sched_local', enabled: false });
    });
  }
});

test('prompt or cron with a remote scheme is refused before add, including one percent-decode', () => {
  for (const scheme of SCHEMES) {
    const literal = LITERAL[scheme];
    const samples = [literal, literal.toUpperCase(), encodeOnce(literal), encodeOnce(literal).toUpperCase()];
    for (const sample of samples) {
      withSpec(localSpec({ prompt: `local ${sample} report` }), (root, file, before) => {
        expectRefused(root, file, before, `prompt ${scheme} ${sample}`);
      });
      withSpec(localSpec({ cron: sample, prompt: 'تقرير محلي أسبوعي' }), (root, file, before) => {
        expectRefused(root, file, before, `cron ${scheme} ${sample}`);
      });
    }
  }
});

test('a saved schedule id does not skip a remote prompt', () => {
  withSpec(localSpec({ scheduleId: 'sched_saved', prompt: encodeOnce('mailto:user@example.com') }), (root, file, before) => {
    expectRefused(root, file, before, 'saved encoded mailto');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { scheduleId?: string; cron?: string; timezone?: string };
    assert.equal(stored.scheduleId, 'sched_saved');
    assert.equal(stored.cron, '0 9 * * 1');
    assert.equal(stored.timezone, 'Asia/Qatar');
  });
});
