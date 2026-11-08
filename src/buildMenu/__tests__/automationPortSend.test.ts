/**
 * Automation port preview is dry-run only. external-send, publish, purchase,
 * and delete do not call connector.send. executeCell throws unsupported_operation.
 * Cron stays 0 9 * * 1 Asia/Qatar. This file does not start the scheduler.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/automationPortSend.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { createAutomationsPorts } from '../automations/ports.js';
import { automationProfile } from '../automations/profile.js';
import { BuildMenuError } from '../grants.js';
import type { KindDeps } from '../kindRuntime.js';
import { ProcessLeaseRegistry } from '../processLease.js';

const EFFECTS = [
  { name: 'external-send', brief: 'أرسل إلى user@example.com النص secret-body\n' },
  { name: 'publish', brief: 'publish the site\n' },
  { name: 'purchase', brief: 'purchase the item\n' },
  { name: 'delete', brief: 'delete the files\n' },
] as const;

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loam-auto-port-'));
}

function context(root: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'automation' };
  return {
    workspace: root,
    jobId: 'job_automation_port_send',
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'تقرير',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
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

function refusedCell(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsupported_operation' && error.status === 400;
}

test('automation ports do not call connector.send or start the scheduler', () => {
  const source = fs.readFileSync(new URL('../automations/ports.ts', import.meta.url), 'utf8');
  assert.equal(automationProfile.preview, 'dry-run');
  assert.equal(source.includes('connector.send'), false);
  assert.equal(source.includes('.send('), false);
  assert.equal(source.includes('startScheduler'), false);
  assert.match(source, /createKindPorts\(automationProfile, deps\)/);
});

test('preview stays a Monday Qatar dry-run and blocked effects do not send', async () => {
  for (const effect of EFFECTS) {
    const root = workspace();
    const leases = new ProcessLeaseRegistry(200);
    const mail = countingConnector();
    const deps: KindDeps & { connector: { send: () => void } } = { leases, connector: mail.connector };
    const ports = createAutomationsPorts(deps);
    const ctx = context(root);
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app', 'brief.txt'), effect.brief);
    try {
      await ports.scaffold(ctx);
      const preview = await ports.preview(ctx);
      assert.deepEqual(preview, { kind: 'none' }, effect.name);
      assert.equal(leases.liveCount(), 0, effect.name);
      assert.equal(mail.sent(), 0, effect.name);
      const spec = JSON.parse(fs.readFileSync(path.join(root, 'app', 'automation.json'), 'utf8')) as {
        cron?: string;
        timezone?: string;
        dryRun?: boolean;
        send?: boolean;
        enabled?: boolean;
      };
      assert.equal(spec.cron, '0 9 * * 1', effect.name);
      assert.equal(spec.timezone, 'Asia/Qatar', effect.name);
      assert.equal(spec.dryRun, true, effect.name);
      assert.equal(spec.send, false, effect.name);
      assert.equal(spec.enabled, false, effect.name);
      const routine = JSON.parse(fs.readFileSync(path.join(root, 'app', 'routine.json'), 'utf8')) as {
        cron?: string;
        timezone?: string;
        effects?: string[];
      };
      assert.equal(routine.cron, '0 9 * * 1', effect.name);
      assert.equal(routine.timezone, 'Asia/Qatar', effect.name);
      assert.deepEqual(routine.effects, ['local-report'], effect.name);
      assert.match(fs.readFileSync(path.join(root, 'app', 'report.txt'), 'utf8'), /dry-run/, effect.name);
      assert.equal(fs.existsSync(path.join(root, 'app', 'proposed.json')), false, effect.name);
      assert.equal(fs.existsSync(path.join(root, 'app', 'runs.jsonl')), false, effect.name);
      const page = fs.readFileSync(path.join(root, 'app', 'preview.html'), 'utf8');
      assert.match(page, /09:00 Asia\/Qatar/, effect.name);
      assert.equal(page.includes('user@example.com'), false, effect.name);
      await assert.rejects(ports.executeCell(ctx, 'cell-1'), refusedCell, effect.name);
      const kernel = { ...ctx, operation: { action: 'kernel-execute' as const, cellId: 'cell-1' } };
      await assert.rejects(ports.executeCell(kernel, 'cell-1'), refusedCell, effect.name);
      await ports.stop(ctx);
      assert.equal(leases.liveCount(), 0, effect.name);
      assert.equal(mail.sent(), 0, effect.name);
      const after = JSON.parse(fs.readFileSync(path.join(root, 'app', 'automation.json'), 'utf8')) as { cron?: string; timezone?: string };
      assert.equal(after.cron, '0 9 * * 1', effect.name);
      assert.equal(after.timezone, 'Asia/Qatar', effect.name);
    } finally {
      await ports.stop(ctx).catch(() => undefined);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
