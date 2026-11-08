import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { nextCronRun } from '../../server/scheduleTime.js';
import { materialize } from '../materialize.js';
import { createAutomationsPorts } from '../automations/ports.js';
import { automationProfile, automationsBrief } from '../automations/profile.js';
import { authorizeStep } from '../automations/policy.js';
import { registerDryRun } from '../automations/register.js';
import { catchUpLocalReport, holdCatchUp } from '../automations/catchup.js';
import { BuildMenuError } from '../grants.js';
import { activateLocalReports, disableLocalReports, pauseLocalReports, recordPreview, resumeLocalReports, runRoutine } from '../automations/run.js';
import { scheduleCard, schedulePage, upcomingRuns } from '../automations/schedule.js';
import { ProcessLeaseRegistry } from '../processLease.js';

test('automation: fixed capability boundary', () => {
  assert.equal(automationProfile.kind, 'automation');
  assert.equal(automationProfile.preview, 'dry-run');
  assert.equal(automationProfile.externalEffects, 'approval-required');
  assert.ok(automationProfile.exports.includes('source-zip'));
  assert.ok(automationsBrief.length > 40);
});

test('09:00 Qatar daily and effects are separate', () => {
  const next = nextCronRun('0 9 * * *', new Date('2026-11-05T05:00:00Z'), 'Asia/Qatar');
  assert.equal(next.toISOString(), '2026-11-05T06:00:00.000Z');
  assert.equal(authorizeStep('local-report'), 'allowed');
  assert.equal(authorizeStep('external-send'), 'approval-required');
});

test('a dry-run routine is stored disabled and a send step is not stored', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-auto-'));
  const file = path.join(root, 'app', 'automation.json');
  fs.mkdirSync(path.dirname(file));
  const spec = { cron: '0 9 * * 1', timezone: 'Asia/Qatar', dryRun: true, enabled: true, send: false };
  fs.writeFileSync(file, `${JSON.stringify(spec)}\n`);
  let calls = 0;
  const first = registerDryRun(root, (row) => {
    calls += 1;
    assert.equal(row.enabled, false);
    assert.match(row.prompt, /Do not send/);
    return { id: 'sched_test', enabled: row.enabled };
  });
  assert.equal(first.enabled, false);
  assert.equal(first.scheduleId, 'sched_test');
  registerDryRun(root, () => { calls += 1; return { id: 'sched_other', enabled: false }; });
  assert.equal(calls, 1);
  fs.writeFileSync(file, `${JSON.stringify({ ...spec, send: true })}\n`);
  assert.throws(() => registerDryRun(root, () => { calls += 1; return { id: 'sched_send', enabled: false }; }), /approval_required/);
  assert.equal(calls, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a local routine writes a report and a send request does not call mail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-auto-run-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', 'automation.json'), `${JSON.stringify({ cron: '0 9 * * 1', timezone: 'Asia/Qatar', dryRun: true, enabled: false, send: false, previewCount: 0 })}\n`);
  let sent = 0;
  const connector = { send(): void { sent += 1; throw new Error('mail_called'); } };
  const local = runRoutine({ workspace: root, runId: 'run_1', dueAt: '2026-11-05T06:00:00.000Z', prompt: 'حضّر ملخصاً محلياً', connector });
  assert.equal(local.outcome, 'local-report');
  assert.match(fs.readFileSync(path.join(root, 'app', 'local-report.txt'), 'utf8'), /تقرير محلي/);
  const blocked = runRoutine({ workspace: root, runId: 'run_2', dueAt: '2026-11-06T06:00:00.000Z', prompt: 'أرسل إلى user@example.com النص secret-body', connector });
  assert.equal(blocked.outcome, 'approval_required');
  assert.equal(sent, 0);
  const proposed = JSON.parse(fs.readFileSync(path.join(root, 'app', 'proposed.json'), 'utf8')) as { recipient: string; body: string };
  assert.equal(proposed.recipient, 'user@example.com');
  assert.match(proposed.body, /secret-body/);
  const log = fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8');
  assert.match(log, /run_1/);
  assert.match(log, /Asia\/Qatar/);
  assert.equal(log.includes('secret-body'), false);
  const kept = fs.readFileSync(path.join(root, 'app', 'local-report.txt'));
  const blockedEffects = [
    ['publish the site', 'publish'],
    ['purchase the item', 'purchase'],
    ['delete the files', 'delete'],
    ['انشر الموقع', 'publish'],
    ['اشتر المنتج', 'purchase'],
    ['احذف الملفات', 'delete'],
  ] as const;
  for (const [index, [prompt, effect]] of blockedEffects.entries()) {
    const refused = runRoutine({ workspace: root, runId: `run_block_${index}`, dueAt: '2026-11-06T06:00:00.000Z', prompt, connector });
    assert.equal(refused.outcome, 'approval_required');
    const proposal = JSON.parse(fs.readFileSync(path.join(root, 'app', 'proposed.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(proposal, { effect, status: 'approval_required' });
  }
  assert.equal(sent, 0);
  assert.equal(fs.readFileSync(path.join(root, 'app', 'local-report.txt')).equals(kept), true);
  const negated = runRoutine({
    workspace: root,
    runId: 'run_negated',
    dueAt: '2026-11-06T06:00:00.000Z',
    prompt: 'dry-run local report only. Do not send, publish, purchase, or delete. لا تنشر',
    connector,
  });
  assert.equal(negated.outcome, 'local-report');
  assert.throws(() => runRoutine({ workspace: root, runId: 'run_3', dueAt: '2026-11-07T06:00:00.000Z', prompt: 'FULL_AUTO', connector }), /approval_required/);
  assert.equal(sent, 0);
  assertRunLog(path.join(root, 'app', 'runs.jsonl'), ['secret-body', 'FULL_AUTO']);
  assert.throws(() => activateLocalReports(root), /approval_required/);
  recordPreview(root);
  recordPreview(root);
  assert.equal(recordPreview(root), 3);
  activateLocalReports(root);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'app', 'automation.json'), 'utf8')).enabled, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the next three Qatar mornings stay local in the source bundle', async () => {
  const runs = upcomingRuns('0 9 * * 1', new Date('2026-11-06T12:00:00Z'));
  assert.equal(runs.length, 3);
  for (const run of runs) {
    assert.equal(run.getUTCHours(), 6);
    assert.equal(run.getUTCDay(), 1);
  }
  assert.equal(runs[1]!.getTime() - runs[0]!.getTime(), 7 * 86_400_000);
  const card = scheduleCard(runs);
  const page = schedulePage(`${card}<script>alert(1)</script>`);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(page.includes('<script'), false);
  assert.match(card, /ماذا: تقرير محلي/);
  assert.match(card, /أين: هذا الجهاز/);
  assert.equal(/oauth|hmac/i.test(card), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-auto-zip-'));
  const selection: BuildManifest['selection'] = { kind: 'automation' };
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: 'job_automation_source',
    operation: { action: 'package', format: 'source-zip' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'تقرير',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'c'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
  try {
    materialize({ selection, workspace: root, title: 'تقرير' });
    const artifact = await createAutomationsPorts({ leases: new ProcessLeaseRegistry(200) }).export(ctx, 'source-zip');
    const files = unzip(fs.readFileSync(path.join(root, artifact.relativePath)));
    assert.equal(files.has('routine.json'), true);
    assert.equal(files.has('README.md'), true);
    assert.equal(files.has('report.txt'), true);
    const bundled = [...files.values()].map((body) => body.toString('utf8')).join('\n');
    assert.match(files.get('README.md')?.toString('utf8') ?? '', /لا تحتوي مفاتيح/);
    assert.equal(/sk-[A-Za-z0-9]|hmac[_-]?key|oauth[_-]?token|bearer\s+\S/i.test(bundled), false);
    assert.equal(nextCronRun('0 9 * * 1', runs[2]!, 'Asia/Qatar').getTime() > runs[2]!.getTime(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('opening Loam runs the latest Qatar morning once and a closed app runs nothing', () => {
  const closed = routineRoot('closed');
  writeRoutine(closed, { enabled: true, prompt: 'كل صباح التاسعة حضّر ملخصاً من CSV المشروع. لا ترسل' });
  assert.equal(fs.existsSync(path.join(closed, 'app', 'runs.jsonl')), false);
  fs.rmSync(closed, { recursive: true, force: true });

  const onTime = routineRoot('ontime');
  const connector = { send() { throw new Error('mail_called'); } };
  try {
    writeRoutine(onTime, { enabled: true, prompt: 'كل صباح التاسعة حضّر ملخصاً من CSV المشروع. لا ترسل' });
    const first = catchUpLocalReport({ workspace: onTime, now: new Date('2026-11-09T06:00:00.000Z'), connector });
    assert.equal(first.ran, true);
    assert.equal(first.dueAt, '2026-11-09T06:00:00.000Z');
    assert.equal(fs.readFileSync(path.join(onTime, 'app', 'local-report.txt'), 'utf8'), 'تقرير محلي\n2026-11-09T06:00:00.000Z\n');
    const again = catchUpLocalReport({ workspace: onTime, now: new Date('2026-11-09T06:00:00.000Z'), connector });
    assert.equal(again.ran, false);
    assert.equal(fs.readFileSync(path.join(onTime, 'app', 'runs.jsonl'), 'utf8').trim().split('\n').length, 1);

    const overdue = routineRoot('overdue');
    writeRoutine(overdue, { enabled: true, prompt: 'كل صباح التاسعة حضّر ملخصاً من CSV المشروع. لا ترسل' });
    const caught = catchUpLocalReport({ workspace: overdue, now: new Date('2026-11-23T12:00:00.000Z'), connector });
    assert.equal(caught.dueAt, '2026-11-23T06:00:00.000Z');
    assert.equal(fs.readFileSync(path.join(overdue, 'app', 'runs.jsonl'), 'utf8').trim().split('\n').length, 1);
    fs.rmSync(overdue, { recursive: true, force: true });
  } finally {
    fs.rmSync(onTime, { recursive: true, force: true });
  }
});

test('a refused effect names itself and a later dry-run catch-up still writes the local report', () => {
  const root = routineRoot('effect');
  let sent = 0;
  const connector = { send() { sent += 1; } };
  const report = path.join(root, 'app', 'local-report.txt');
  try {
    writeRoutine(root, { enabled: true, prompt: 'dry-run local report only. Do not send, publish, purchase, or delete.' });
    fs.writeFileSync(report, 'kept-report\n');
    const kept = fs.readFileSync(report);
    const refusals = [
      ['publish the site to user@example.com secret-publish', 'publish'],
      ['purchase the item secret-purchase', 'purchase'],
      ['buy the pass secret-buy', 'purchase'],
      ['delete the files secret-delete', 'delete'],
    ] as const;
    for (const [index, [prompt, effect]] of refusals.entries()) {
      const refused = runRoutine({ workspace: root, runId: `run_${effect}_${index}`, dueAt: '2026-11-02T06:00:00.000Z', prompt, connector });
      assert.equal(refused.outcome, 'approval_required');
      const proposal = JSON.parse(fs.readFileSync(path.join(root, 'app', 'proposed.json'), 'utf8')) as Record<string, unknown>;
      assert.deepEqual(proposal, { effect, status: 'approval_required' });
      assert.equal(fs.readFileSync(report).equals(kept), true);
    }
    assert.equal(sent, 0);
    assertRunLog(path.join(root, 'app', 'runs.jsonl'), ['secret', '@', 'user@example.com']);
    const proposed = fs.readFileSync(path.join(root, 'app', 'proposed.json'), 'utf8');
    const caught = catchUpLocalReport({ workspace: root, now: new Date('2026-11-09T06:00:00.000Z'), connector });
    assert.equal(caught.ran, true);
    assert.equal(caught.dueAt, '2026-11-09T06:00:00.000Z');
    assert.equal(fs.readFileSync(report, 'utf8'), 'تقرير محلي\n2026-11-09T06:00:00.000Z\n');
    assert.equal(fs.readFileSync(path.join(root, 'app', 'proposed.json'), 'utf8'), proposed);
    assert.equal(sent, 0);
    assertRunLog(path.join(root, 'app', 'runs.jsonl'), ['secret', '@', 'user@example.com']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a disabled routine and a send request do not catch up into mail', () => {
  const root = routineRoot('send');
  let sent = 0;
  const connector = { send() { sent += 1; } };
  try {
    writeRoutine(root, { enabled: false, prompt: 'أرسل الملخص إلى user@example.com' });
    assert.deepEqual(catchUpLocalReport({ workspace: root, now: new Date('2026-11-09T06:00:00.000Z'), connector }), { ran: false, dueAt: null });
    assert.equal(fs.existsSync(path.join(root, 'app', 'catchup.json')), false);
    writeRoutine(root, { enabled: true, prompt: 'أرسل الملخص إلى user@example.com' });
    const proposed = catchUpLocalReport({ workspace: root, now: new Date('2026-11-09T06:00:00.000Z'), connector });
    assert.equal(proposed.ran, true);
    assert.equal(sent, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'app', 'proposed.json'), 'utf8')).recipient, 'user@example.com');
    assert.equal(catchUpLocalReport({ workspace: root, now: new Date('2026-11-09T06:00:00.000Z'), connector }).ran, false);
    assert.equal(sent, 0);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8').trim().split('\n').length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pausing skips missed mornings and resume runs the latest one once', () => {
  const root = routineRoot('pause');
  const connector = { send() { throw new Error('mail_called'); } };
  try {
    writeRoutine(root, { enabled: false, prompt: 'كل صباح التاسعة حضّر ملخصاً من CSV المشروع. لا ترسل' });
    assert.throws(
      () => pauseLocalReports(root),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'approval_required',
    );
    writeRoutine(root, { enabled: true, prompt: 'كل صباح التاسعة حضّر ملخصاً من CSV المشروع. لا ترسل' });
    catchUpLocalReport({ workspace: root, now: new Date('2026-11-09T06:00:00.000Z'), connector });
    const log = fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8');
    pauseLocalReports(root);
    assert.equal(catchUpLocalReport({ workspace: root, now: new Date('2026-11-16T06:00:00.000Z'), connector }).ran, false);
    assert.equal(catchUpLocalReport({ workspace: root, now: new Date('2026-11-23T06:00:00.000Z'), connector }).ran, false);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8'), log);
    const paused = JSON.parse(fs.readFileSync(path.join(root, 'app', 'automation.json'), 'utf8')) as { paused: boolean; enabled: boolean; cron: string };
    assert.equal(paused.paused, true);
    assert.equal(paused.enabled, true);
    assert.equal(paused.cron, '0 9 * * 1');
    resumeLocalReports(root);
    const resumed = catchUpLocalReport({ workspace: root, now: new Date('2026-11-23T06:00:00.000Z'), connector });
    assert.equal(resumed.ran, true);
    assert.equal(resumed.dueAt, '2026-11-23T06:00:00.000Z');
    assert.equal(catchUpLocalReport({ workspace: root, now: new Date('2026-11-23T07:00:00.000Z'), connector }).ran, false);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8').trim().split('\n').length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an expired until does not run and a later until still runs once', () => {
  const root = routineRoot('until');
  const connector = { send() { throw new Error('mail_called'); } };
  const limited = upcomingRuns('0 9 * * 1', new Date('2026-11-06T12:00:00.000Z'), 3, '2026-11-10T00:00:00.000Z');
  assert.deepEqual(limited.map((run) => run.toISOString()), ['2026-11-09T06:00:00.000Z']);
  assert.match(scheduleCard(limited, '2026-11-10T00:00:00.000Z'), /حتى: 2026-11-10T00:00:00.000Z/);
  try {
    writeRoutine(root, { enabled: true, prompt: 'كل صباح التاسعة حضّر ملخصاً من CSV المشروع. لا ترسل', until: '2026-11-01T00:00:00.000Z' });
    assert.deepEqual(catchUpLocalReport({ workspace: root, now: new Date('2026-11-09T06:00:00.000Z'), connector }), { ran: false, dueAt: null });
    assert.equal(fs.existsSync(path.join(root, 'app', 'runs.jsonl')), false);
    assert.equal(fs.existsSync(path.join(root, 'app', 'catchup.json')), false);
    writeRoutine(root, { enabled: true, prompt: 'كل صباح التاسعة حضّر ملخصاً من CSV المشروع. لا ترسل', until: '2026-11-10T00:00:00.000Z' });
    const ran = catchUpLocalReport({ workspace: root, now: new Date('2026-11-09T06:00:00.000Z'), connector });
    assert.equal(ran.ran, true);
    assert.equal(ran.dueAt, '2026-11-09T06:00:00.000Z');
    const log = fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8');
    writeRoutine(root, { enabled: true, prompt: 'كل صباح التاسعة حضّر ملخصاً من CSV المشروع. لا ترسل', until: 'later' });
    assert.throws(
      () => catchUpLocalReport({ workspace: root, now: new Date('2026-11-16T06:00:00.000Z'), connector }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request',
    );
    assert.equal(fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8'), log);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('disabling a routine keeps the log and skips the next morning', () => {
  const root = routineRoot('disable');
  const connector = { send() { throw new Error('mail_called'); } };
  try {
    writeRoutine(root, { enabled: true, prompt: 'كل صباح التاسعة حضّر ملخصاً من CSV المشروع. لا ترسل' });
    catchUpLocalReport({ workspace: root, now: new Date('2026-11-09T06:00:00.000Z'), connector });
    const log = fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8');
    disableLocalReports(root);
    const next = catchUpLocalReport({ workspace: root, now: new Date('2026-11-16T06:00:00.000Z'), connector });
    assert.equal(next.ran, false);
    assert.equal(next.dueAt, null);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8'), log);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'app', 'automation.json'), 'utf8')).cron, '0 9 * * 1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a busy morning is skipped and the next Monday still runs once', () => {
  const root = routineRoot('busy');
  const connector = { send() { throw new Error('mail_called'); } };
  try {
    writeRoutine(root, { enabled: true, prompt: 'كل صباح التاسعة حضّر ملخصاً من CSV المشروع. لا ترسل' });
    fs.writeFileSync(path.join(root, 'app', 'catchup.lock'), 'running\n');
    const recovered = catchUpLocalReport({ workspace: root, now: new Date('2026-11-09T06:00:00.000Z'), connector });
    assert.equal(recovered.ran, true);
    assert.equal(fs.existsSync(path.join(root, 'app', 'catchup.lock')), false);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8').trim().split('\n').length, 1);
    const release = holdCatchUp(root);
    try {
      const busy = catchUpLocalReport({ workspace: root, now: new Date('2026-11-16T06:00:00.000Z'), connector });
      assert.equal(busy.ran, false);
      assert.equal(fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8').trim().split('\n').length, 1);
    } finally {
      release();
    }
    assert.equal(catchUpLocalReport({ workspace: root, now: new Date('2026-11-09T06:00:00.000Z'), connector }).ran, false);
    assert.equal(fs.existsSync(path.join(root, 'app', 'catchup.lock')), false);
    assert.equal(catchUpLocalReport({ workspace: root, now: new Date('2026-11-16T06:00:00.000Z'), connector }).ran, true);
    assert.equal(catchUpLocalReport({ workspace: root, now: new Date('2026-11-16T07:00:00.000Z'), connector }).ran, false);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8').trim().split('\n').length, 2);
    fs.rmSync(path.join(root, 'app', 'catchup.json'));
    fs.mkdirSync(path.join(root, 'app', 'catchup.json'));
    assert.throws(
      () => catchUpLocalReport({ workspace: root, now: new Date('2026-11-23T06:00:00.000Z'), connector }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed catch-up keeps its due key and the next Monday still runs once', () => {
  const root = routineRoot('fail');
  let sent = 0;
  const connector = { send() { sent += 1; throw new Error('mail_called'); } };
  try {
    writeRoutine(root, { enabled: true, prompt: 'FULL_AUTO' });
    assert.throws(
      () => catchUpLocalReport({ workspace: root, now: new Date('2026-11-09T06:00:00.000Z'), connector }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'approval_required',
    );
    assert.equal(sent, 0);
    const marker = JSON.parse(fs.readFileSync(path.join(root, 'app', 'catchup.json'), 'utf8')) as { dedupeKey: string };
    assert.equal(marker.dedupeKey, 'sched_local\u00002026-11-09T06:00:00.000Z');
    const log = fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8');
    assert.equal(log.includes('FULL_AUTO'), false);
    assert.match(log, /approval_required/);
    assert.equal(fs.existsSync(path.join(root, 'app', 'catchup.lock')), false);
    writeRoutine(root, { enabled: true, prompt: 'كل صباح التاسعة حضّر ملخصاً من CSV المشروع. لا ترسل' });
    assert.equal(catchUpLocalReport({ workspace: root, now: new Date('2026-11-09T07:00:00.000Z'), connector }).ran, false);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8'), log);
    const next = catchUpLocalReport({ workspace: root, now: new Date('2026-11-16T06:00:00.000Z'), connector });
    assert.equal(next.ran, true);
    assert.equal(next.dueAt, '2026-11-16T06:00:00.000Z');
    assert.equal(sent, 0);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8').trim().split('\n').length, 2);
    assert.equal(catchUpLocalReport({ workspace: root, now: new Date('2026-11-16T07:00:00.000Z'), connector }).ran, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function assertRunLog(file: string, absent: readonly string[]): void {
  const text = fs.readFileSync(file, 'utf8');
  for (const token of absent) assert.equal(text.includes(token), false);
  for (const line of text.trim().split('\n')) {
    const row = JSON.parse(line) as Record<string, unknown>;
    assert.deepEqual(Object.keys(row).sort(), ['dueAt', 'outcome', 'runId', 'timezone']);
    assert.equal(row.timezone, 'Asia/Qatar');
  }
}

function routineRoot(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `loam-catch-${name}-`));
}

function writeRoutine(workspace: string, input: { enabled: boolean; prompt: string; until?: string }): void {
  fs.mkdirSync(path.join(workspace, 'app'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'app', 'automation.json'), `${JSON.stringify({
    cron: '0 9 * * 1',
    timezone: 'Asia/Qatar',
    dryRun: true,
    enabled: input.enabled,
    send: false,
    scheduleId: 'sched_local',
    prompt: input.prompt,
    ...(input.until ? { until: input.until } : {}),
  })}\n`);
}

function unzip(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const body = buffer.subarray(start, start + compressed);
    files.set(name, method === 0 ? Buffer.from(body) : zlib.inflateRawSync(body));
    offset = start + compressed;
  }
  return files;
}
