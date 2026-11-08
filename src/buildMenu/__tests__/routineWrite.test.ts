import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext } from '../../../packages/shared/src/buildMenu.js';
import { createAutomationsPorts } from '../automations/ports.js';
import { BuildMenuError } from '../grants.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { runRoutine, writeProjectText } from '../automations/run.js';

test('a local report stays in the project and does not send mail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-routine-write-'));
  const outside = path.join(root, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  let sent = 0;
  try {
    const result = runRoutine({
      workspace: root,
      runId: 'run_local',
      dueAt: '2026-11-09T06:00:00.000Z',
      prompt: 'حضّر ملخصاً محلياً',
      connector: { send() { sent += 1; } },
    });
    assert.equal(result.outcome, 'local-report');
    assert.equal(sent, 0);
    assert.match(fs.readFileSync(path.join(root, 'app', 'local-report.txt'), 'utf8'), /تقرير محلي/);
    assert.match(fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8'), /local-report/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'secret');
    fs.rmSync(path.join(root, 'app', 'runs.jsonl'));
    fs.mkdirSync(path.join(root, 'app', 'runs.jsonl'));
    assert.throws(
      () => writeProjectText(root, 'runs.jsonl', 'x\n', true),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path',
    );
    assert.equal(fs.statSync(path.join(root, 'app', 'runs.jsonl')).isDirectory(), true);
    assert.throws(
      () => writeProjectText(root, '../secret.txt', 'no\n'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path',
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'secret');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a local report stays a file and external effects do not send', () => {
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-routine-app-file-'));
  const appFile = path.join(blocked, 'app');
  fs.writeFileSync(appFile, 'kept-app');
  let sent = 0;
  const connector = { send() { sent += 1; } };
  const dueAt = '2026-11-09T06:00:00.000Z';
  try {
    for (const prompt of ['حضّر ملخصاً محلياً', 'أرسل إلى user@example.com النص secret-body', 'publish the site', 'purchase the item', 'delete the files']) {
      assert.throws(
        () => runRoutine({ workspace: blocked, runId: 'run_app_file', dueAt, prompt, connector }),
        (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
      );
    }
    assert.equal(sent, 0);
    assert.equal(fs.readFileSync(appFile, 'utf8'), 'kept-app');
    assert.equal(fs.statSync(appFile).isFile(), true);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-routine-report-dir-'));
    const report = path.join(root, 'app', 'local-report.txt');
    fs.mkdirSync(report, { recursive: true });
    try {
      const effects = [
        ['أرسل إلى user@example.com النص secret-body', 'external-send'],
        ['publish the site', 'publish'],
        ['purchase the item', 'purchase'],
        ['delete the files', 'delete'],
      ] as const;
      for (const [index, [prompt, effect]] of effects.entries()) {
        const refused = runRoutine({ workspace: root, runId: `run_effect_${index}`, dueAt, prompt, connector });
        assert.equal(refused.outcome, 'approval_required');
        const proposal = JSON.parse(fs.readFileSync(path.join(root, 'app', 'proposed.json'), 'utf8')) as Record<string, unknown>;
        if (effect === 'external-send') {
          assert.equal(proposal.recipient, 'user@example.com');
          assert.equal(proposal.status, 'approval_required');
        } else {
          assert.deepEqual(proposal, { effect, status: 'approval_required' });
        }
        assert.equal(fs.statSync(report).isDirectory(), true);
        assert.equal(fs.readdirSync(report).length, 0);
      }
      assert.throws(
        () => runRoutine({ workspace: root, runId: 'run_report_dir', dueAt, prompt: 'حضّر ملخصاً محلياً', connector }),
        (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
      );
      assert.equal(sent, 0);
      assert.equal(fs.statSync(report).isDirectory(), true);
      assert.equal(fs.readdirSync(report).length, 0);
      assert.equal(fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8').includes('secret-body'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(blocked, { recursive: true, force: true });
  }
});

test('a dry-run preview does not replace a schedule folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-routine-schedule-'));
  const leases = new ProcessLeaseRegistry(200);
  const ports = createAutomationsPorts({ leases });
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: 'job_routine_schedule',
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_bcdfghjkmnpq',
      revision: 1,
      selection: { kind: 'automation' },
      title: 'تقرير',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'b'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
  try {
    await ports.scaffold(ctx);
    const schedule = path.join(root, 'app', 'schedule.txt');
    const preview = fs.readFileSync(path.join(root, 'app', 'preview.html'), 'utf8');
    fs.rmSync(schedule);
    fs.mkdirSync(schedule);
    await assert.rejects(
      ports.preview(ctx),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.statSync(schedule).isDirectory(), true);
    assert.equal(fs.readdirSync(schedule).length, 0);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'preview.html'), 'utf8'), preview);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'app', 'automation.json'), 'utf8')).previewCount, 0);
    assert.equal(leases.liveCount(), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a dry-run write refuses remote schemes and keeps the previous bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-routine-scheme-'));
  const leases = new ProcessLeaseRegistry(200);
  const ports = createAutomationsPorts({ leases });
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: 'job_routine_scheme',
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_bcdfghjkmnpq',
      revision: 1,
      selection: { kind: 'automation' },
      title: 'تقرير',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'b'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
  const names = ['schedule.txt', 'preview.html', 'local-report.txt'] as const;
  const schemes = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'http://example.test/a',
    'HTTP://example.test/a',
    'https://example.test/a',
    'HTTPS://example.test/a',
    'data:text/html,x',
    'DATA:text/html,x',
    'file:///tmp/x',
    'FILE:///tmp/x',
    'blob:00000000-0000-0000-0000-000000000000',
    'BLOB:00000000-0000-0000-0000-000000000000',
    'http%3a',
    'HTTP%3A//example.test/a',
    'https%3a',
    'HTTPS%3a//example.test/a',
    'javascript%3aalert(1)',
    'JAVASCRIPT%3Aalert(1)',
    'data%3a',
    'DATA%3Atext/html,x',
    'file%3a',
    'FILE%3A///tmp/x',
    'blob%3a',
    'BLOB%3A00000000-0000-0000-0000-000000000000',
    "http'+'://",
    "https'+'://example.test/a",
    "HTTP'+'://example.test/a",
    '"http"+"//"',
    '"https"+"//example.test/a"',
    '"HTTP"+"//example.test"',
    "javascript'+':alert(1)",
    '"javascript"+":"',
    "data'+':text/html,x",
    '"file"+":///tmp/x"',
    "blob'+':00000000-0000-0000-0000-000000000000",
    '//host',
    '//HOST/a',
    '//example.test/a',
  ];
  const sentences = ['نشر', 'publisher', 'deleted', 'dry-run local report only', 'حضّر ملخصاً محلياً'] as const;
  let sent = 0;
  const connector = { send() { sent += 1; } };
  try {
    await ports.scaffold(ctx);
    const specPath = path.join(root, 'app', 'automation.json');
    const specBefore = JSON.parse(fs.readFileSync(specPath, 'utf8')) as { cron?: string; timezone?: string };
    assert.equal(specBefore.cron, '0 9 * * 1');
    assert.equal(specBefore.timezone, 'Asia/Qatar');
    const previous = new Map<string, Buffer>();
    for (const name of names) {
      const file = path.join(root, 'app', name);
      if (fs.existsSync(file)) fs.rmSync(file);
      assert.throws(
        () => writeProjectText(root, name, 'javascript:alert(1)\n'),
        (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
      );
      assert.equal(fs.existsSync(file), false);
      const bytes = Buffer.from(`kept-${name}\n`, 'utf8');
      fs.writeFileSync(file, bytes);
      previous.set(name, bytes);
    }
    for (const name of names) {
      const file = path.join(root, 'app', name);
      const kept = previous.get(name);
      assert.ok(kept);
      for (const scheme of schemes) {
        const refused = (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
        assert.throws(() => writeProjectText(root, name, `note ${scheme}\n`), refused);
        assert.throws(() => writeProjectText(root, name, `note ${scheme}\n`, true), refused);
        assert.equal(fs.readFileSync(file).equals(kept), true);
      }
    }
    for (const name of names) {
      for (const sentence of sentences) {
        writeProjectText(root, name, sentence);
        assert.equal(fs.readFileSync(path.join(root, 'app', name), 'utf8'), sentence);
      }
    }
    for (const prompt of sentences) {
      const result = runRoutine({
        workspace: root,
        runId: 'run_scheme_local',
        dueAt: '2026-11-09T06:00:00.000Z',
        prompt,
        connector,
      });
      assert.equal(result.outcome, 'local-report');
      assert.equal(fs.readFileSync(path.join(root, 'app', 'local-report.txt'), 'utf8'), 'تقرير محلي\n2026-11-09T06:00:00.000Z\n');
    }
    assert.equal(sent, 0);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'schedule.txt'), 'utf8'), 'حضّر ملخصاً محلياً');
    assert.equal(fs.readFileSync(path.join(root, 'app', 'preview.html'), 'utf8'), 'حضّر ملخصاً محلياً');
    await ports.preview(ctx);
    const schedule = fs.readFileSync(path.join(root, 'app', 'schedule.txt'), 'utf8');
    const preview = fs.readFileSync(path.join(root, 'app', 'preview.html'), 'utf8');
    assert.equal(/javascript:|https?:\/\/|data:|file:|blob:/i.test(schedule), false);
    assert.equal(/javascript:|https?:\/\/|data:|file:|blob:/i.test(preview), false);
    assert.match(schedule, /09:00 Asia\/Qatar/);
    const specAfter = JSON.parse(fs.readFileSync(specPath, 'utf8')) as { cron?: string; timezone?: string };
    assert.equal(specAfter.cron, '0 9 * * 1');
    assert.equal(specAfter.timezone, 'Asia/Qatar');
    assert.equal(sent, 0);
    assert.equal(leases.liveCount(), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
