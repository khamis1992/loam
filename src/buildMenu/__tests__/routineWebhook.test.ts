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

const DUE_AT = '2026-11-09T06:00:00.000Z';
const LOCAL_REPORT = `تقرير محلي\n${DUE_AT}\n`;

function refused(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

function schemePayloads(): string[] {
  const payloads: string[] = [];
  for (const name of ['mailto', 'tel', 'sms', 'intent', 'market']) {
    const upper = name.toUpperCase();
    payloads.push(
      `${name}:payload`,
      `${upper}:payload`,
      `${name}://payload`,
      `${name}%3apayload`,
      `${upper}%3Apayload`,
      `${name}%253apayload`,
      `${upper}%253Apayload`,
      `${name}%3a%2f%2fpayload`,
      `${name}%253a%252f%252fpayload`,
      `"${name}"+":"`,
      `${name}'+':`,
      `"${upper}" + ":"`,
      `"${name}"+"//payload"`,
      `${name}'+'://payload`,
      `"${name}"%2b":"`,
      `"${name}"%252b":"`,
      `"${name}"+"%2f%2fpayload"`,
      `"${name}"+"%252f%252fpayload"`,
    );
  }
  payloads.push(
    '//hooks.example/a',
    '//HOOKS.example/a',
    '%2f%2fhooks.example/a',
    '%2F%2Fhooks.example/a',
    '%252f%252fhooks.example/a',
    '%252F%252Fhooks.example/a',
    'webhook://hooks.example/a',
    'WEBHOOK://hooks.example/a',
    'WebHook://hooks.example/a',
    'webhook:https://hooks.example/a',
    'webhook https://hooks.example/a',
    'webhook mailto:user@example.com',
    'webhook tel:+974',
    "webhook('https://hooks.example/a')",
    'webhook("//hooks.example/a")',
    'webhook //hooks.example/a',
    '"webhook"+"https://hooks.example/a"',
    "webhook'+'://hooks.example/a",
    'webhook\' + \'://hooks.example/a',
    '"webhook" + "://hooks.example/a"',
    "webhook'+':https://hooks.example/a",
    '"webhook" + "//hooks.example/a"',
    'webhook%3a%2f%2fhooks.example/a',
    'WEBHOOK%3A%2F%2Fhooks.example/a',
    'webhook%253a%252f%252fhooks.example/a',
    'webhook%20%2f%2fhooks.example/a',
    'webhook%20mailto%3auser@example.com',
    'webhook%20mailto%253auser@example.com',
    'webhook%2520https%253a%252f%252fhooks.example/a',
    '%77%65%62%68%6f%6f%6b%3a%2f%2fhooks.example/a',
    '%2577%2565%2562%2568%256f%256f%256b%253a%252f%252fhooks.example/a',
  );
  return payloads;
}

test('a dry-run write refuses webhook urls and keeps the previous bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-routine-webhook-'));
  const leases = new ProcessLeaseRegistry(200);
  const ports = createAutomationsPorts({ leases });
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: 'job_routine_webhook',
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
  const sentences = ['نشر', 'publisher', 'deleted', 'webhook', 'webhook:', 'a local webhook report', 'dry-run local report only', 'حضّر ملخصاً محلياً', 'تقرير محلي'] as const;
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
      assert.throws(() => writeProjectText(root, name, 'mailto:payload\n'), refused);
      assert.equal(fs.existsSync(file), false);
      const bytes = Buffer.from(`kept-${name}\n`, 'utf8');
      fs.writeFileSync(file, bytes);
      previous.set(name, bytes);
    }
    for (const name of names) {
      const file = path.join(root, 'app', name);
      const kept = previous.get(name);
      assert.ok(kept);
      for (const payload of schemePayloads()) {
        assert.throws(() => writeProjectText(root, name, `note ${payload}\n`), refused);
        assert.throws(() => writeProjectText(root, name, `note ${payload}\n`, true), refused);
        assert.equal(fs.readFileSync(file).equals(kept), true);
      }
    }
    for (const name of names) {
      for (const sentence of sentences) {
        writeProjectText(root, name, sentence);
        assert.equal(fs.readFileSync(path.join(root, 'app', name), 'utf8'), sentence);
      }
    }
    for (const prompt of ['نشر', 'publisher', 'deleted', 'webhook', 'dry-run local report only', 'حضّر ملخصاً محلياً'] as const) {
      const result = runRoutine({ workspace: root, runId: 'run_webhook_local', dueAt: DUE_AT, prompt, connector });
      assert.equal(result.outcome, 'local-report');
      assert.equal(fs.readFileSync(path.join(root, 'app', 'local-report.txt'), 'utf8'), LOCAL_REPORT);
    }
    assert.equal(sent, 0);
    await ports.preview(ctx);
    const schedule = fs.readFileSync(path.join(root, 'app', 'schedule.txt'), 'utf8');
    const preview = fs.readFileSync(path.join(root, 'app', 'preview.html'), 'utf8');
    assert.equal(/mailto:|tel:|sms:|intent:|market:|webhook:\/\//i.test(schedule), false);
    assert.equal(/mailto:|tel:|sms:|intent:|market:|webhook:\/\//i.test(preview), false);
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

test('external effects stay approval_required and a local report still writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-routine-webhook-effect-'));
  let sent = 0;
  const connector = { send() { sent += 1; } };
  const effects = [
    ['أرسل إلى user@example.com النص secret-body', 'external-send'],
    ['publish the site', 'publish'],
    ['purchase the item', 'purchase'],
    ['delete the files', 'delete'],
  ] as const;
  try {
    for (const [index, [prompt, effect]] of effects.entries()) {
      const refusedEffect = runRoutine({ workspace: root, runId: `run_webhook_effect_${index}`, dueAt: DUE_AT, prompt, connector });
      assert.equal(refusedEffect.outcome, 'approval_required');
      const proposal = JSON.parse(fs.readFileSync(path.join(root, 'app', 'proposed.json'), 'utf8')) as Record<string, unknown>;
      if (effect === 'external-send') {
        assert.equal(proposal.recipient, 'user@example.com');
        assert.equal(proposal.body, prompt);
        assert.equal(proposal.status, 'approval_required');
      } else {
        assert.deepEqual(proposal, { effect, status: 'approval_required' });
      }
    }
    for (const prompt of ['حضّر ملخصاً محلياً', 'نشر', 'publisher', 'deleted', 'webhook'] as const) {
      const result = runRoutine({ workspace: root, runId: 'run_webhook_kept', dueAt: DUE_AT, prompt, connector });
      assert.equal(result.outcome, 'local-report');
      assert.equal(fs.readFileSync(path.join(root, 'app', 'local-report.txt'), 'utf8'), LOCAL_REPORT);
    }
    const runs = fs.readFileSync(path.join(root, 'app', 'runs.jsonl'), 'utf8');
    assert.equal(runs.includes('approval_required'), true);
    assert.equal(runs.includes('local-report'), true);
    assert.equal(runs.includes('Asia/Qatar'), true);
    assert.equal(runs.includes('secret-body'), false);
    assert.equal(sent, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
