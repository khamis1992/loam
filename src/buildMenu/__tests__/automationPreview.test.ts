import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext } from '../../../packages/shared/src/buildMenu.js';
import { createAutomationsPorts } from '../automations/ports.js';
import { upcomingRuns } from '../automations/schedule.js';
import { ProcessLeaseRegistry } from '../processLease.js';

const require = createRequire(path.resolve('packages/web/package.json'));
const { chromium } = require('playwright') as {
  chromium: {
    launch(options: { headless: boolean }): Promise<{
      newPage(): Promise<PreviewPage>;
      close(): Promise<void>;
    }>;
  };
};

interface PreviewPage {
  goto(url: string): Promise<void>;
  close(): Promise<void>;
  on(event: 'request' | 'dialog', handler: (value: { url(): string }) => void): void;
  locator(selector: string): {
    textContent(): Promise<string | null>;
    count(): Promise<number>;
  };
}

test('an automation dry-run shows three Qatar mornings and sends nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-automation-preview-'));
  const leases = new ProcessLeaseRegistry(200);
  const ports = createAutomationsPorts({ leases });
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: 'job_automation_preview',
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
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'brief.txt'), 'كل صباح التاسعة حضّر ملخصاً من CSV المشروع وأرسله\n');
  const browser = await chromium.launch({ headless: true });
  let hosted: { url: string; close(): Promise<void> } | undefined;
  try {
    await ports.scaffold(ctx);
    const preview = await ports.preview(ctx);
    assert.deepEqual(preview, { kind: 'none' });
    assert.equal(leases.liveCount(), 0);
    const spec = JSON.parse(fs.readFileSync(path.join(root, 'app', 'automation.json'), 'utf8')) as { enabled?: boolean; send?: boolean };
    assert.equal(spec.enabled, false);
    assert.equal(spec.send, false);
    assert.equal(fs.existsSync(path.join(root, 'app', 'local-report.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'app', 'proposed.json')), false);
    hosted = await serve(path.join(root, 'app', 'preview.html'));
    const page = await browser.newPage();
    const external: string[] = [];
    let dialogs = 0;
    page.on('request', (request) => {
      if (!request.url().startsWith(hosted?.url ?? 'http://127.0.0.1')) external.push(request.url());
    });
    page.on('dialog', () => { dialogs += 1; });
    await page.goto(hosted.url);
    const text = await page.locator('body').textContent();
    assert.match(text ?? '', /ماذا: تقرير محلي/);
    assert.match(text ?? '', /متى: 09:00 Asia\/Qatar/);
    assert.match(text ?? '', /أين: هذا الجهاز/);
    assert.match(text ?? '', /الصلاحيات: تقرير محلي فقط/);
    assert.match(text ?? '', /التقارير المحلية متوقفة/);
    assert.equal((text ?? '').includes('مؤقتاً'), false);
    assert.equal((text ?? '').includes('مفعّلة'), false);
    assert.match(text ?? '', /الإرسال متوقف حتى موافقة منفصلة\. لم تُرسل رسالة\./);
    const runs = [...(text ?? '').matchAll(/\d\. (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/g)].map((match) => match[1] ?? '');
    assert.equal(runs.length, 3);
    assert.deepEqual(runs.map(qatarClock), ['Mon 09:00', 'Mon 09:00', 'Mon 09:00']);
    assert.equal((runs[0] ?? '') < (runs[1] ?? ''), true);
    assert.equal((runs[1] ?? '') < (runs[2] ?? ''), true);
    assert.equal(await page.locator('script').count(), 0);
    assert.equal(dialogs, 0);
    assert.deepEqual(external, []);
    await page.close();
    await ports.stop(ctx);
    assert.equal(leases.liveCount(), 0);
  } finally {
    await browser.close();
    await hosted?.close();
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an automation end date is shown and later mornings stay off the page', async () => {
  const browser = await chromium.launch({ headless: true });
  const cases = [
    { brief: 'كل صباح التاسعة حضّر ملخصاً وأرسله حتى 2026-11-08\n', until: '2026-11-08T23:59:59.999Z', send: true },
    { brief: 'كل صباح التاسعة حضّر ملخصاً حتى later. لا ترسل\n', until: undefined, send: false },
    { brief: 'كل صباح التاسعة حضّر ملخصاً حتى 2026-02-31. لا ترسل\n', until: undefined, send: false },
  ] as const;
  try {
    for (const item of cases) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-automation-until-'));
      const leases = new ProcessLeaseRegistry(200);
      const ports = createAutomationsPorts({ leases });
      const ctx: BuildJobContext = {
        workspace: root,
        jobId: 'job_automation_until',
        operation: { action: 'preview' },
        signal: new AbortController().signal,
        manifest: {
          schemaVersion: 1,
          projectId: 'app_bcdfghjkmnpr',
          revision: 1,
          selection: { kind: 'automation' },
          title: 'تقرير',
          sourceDir: 'app',
          template: { id: 'fixture', revision: '1', lockSha256: 'b'.repeat(64) },
          consent: { autostart: false, publish: false },
        },
      };
      let hosted: { url: string; close(): Promise<void> } | undefined;
      try {
        fs.mkdirSync(path.join(root, 'app'), { recursive: true });
        fs.writeFileSync(path.join(root, 'app', 'brief.txt'), item.brief);
        await ports.scaffold(ctx);
        const preview = await ports.preview(ctx);
        const expected = upcomingRuns('0 9 * * 1', new Date(), 3, item.until).map((run) => run.toISOString());
        assert.deepEqual(preview, { kind: 'none' });
        assert.equal(leases.liveCount(), 0);
        const spec = JSON.parse(fs.readFileSync(path.join(root, 'app', 'automation.json'), 'utf8')) as { enabled?: boolean; send?: boolean; until?: string };
        assert.equal(spec.enabled, false);
        assert.equal(spec.send, false);
        assert.equal(spec.until, item.until);
        assert.equal(fs.existsSync(path.join(root, 'app', 'local-report.txt')), false);
        assert.equal(fs.existsSync(path.join(root, 'app', 'proposed.json')), false);
        hosted = await serve(path.join(root, 'app', 'preview.html'));
        const page = await browser.newPage();
        const external: string[] = [];
        page.on('request', (request) => {
          if (!request.url().startsWith(hosted?.url ?? 'http://127.0.0.1')) external.push(request.url());
        });
        await page.goto(hosted.url);
        const text = await page.locator('body').textContent() ?? '';
        const runs = [...text.matchAll(/\d\. (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/g)].map((match) => match[1] ?? '');
        assert.deepEqual(runs, expected);
        if (item.until) {
          assert.match(text, /حتى: 2026-11-08T23:59:59\.999Z/);
          assert.ok(runs.every((run) => run <= item.until));
        } else {
          assert.equal(text.includes('حتى:'), false);
          assert.equal(runs.length, 3);
        }
        assert.equal(await page.locator('#send-block').count(), item.send ? 1 : 0);
        assert.equal(await page.locator('script').count(), 0);
        assert.deepEqual(external, []);
        await page.close();
      } finally {
        await hosted?.close();
        await ports.stop(ctx).catch(() => undefined);
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
  }
});

test('a paused automation preview says the local report will not run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-automation-pause-'));
  const leases = new ProcessLeaseRegistry(200);
  const ports = createAutomationsPorts({ leases });
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: 'job_automation_pause',
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_bcdfghjkmnps',
      revision: 1,
      selection: { kind: 'automation' },
      title: 'تقرير',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'b'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
  const browser = await chromium.launch({ headless: true });
  let hosted: { url: string; close(): Promise<void> } | undefined;
  try {
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'brief.txt'), 'كل صباح التاسعة حضّر ملخصاً. لا ترسل\n');
    await ports.scaffold(ctx);
    const specPath = path.join(root, 'app', 'automation.json');
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as { paused?: boolean; enabled?: boolean };
    spec.paused = true;
    fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
    assert.deepEqual(await ports.preview(ctx), { kind: 'none' });
    hosted = await serve(path.join(root, 'app', 'preview.html'));
    const page = await browser.newPage();
    await page.goto(hosted.url);
    const pausedText = await page.locator('body').textContent() ?? '';
    assert.match(pausedText, /التقارير المحلية متوقفة مؤقتاً/);
    assert.equal(pausedText.includes('الإرسال متوقف'), false);
    const runs = [...pausedText.matchAll(/\d\. (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/g)].map((match) => match[1] ?? '');
    assert.deepEqual(runs, upcomingRuns('0 9 * * 1', new Date(), 3).map((run) => run.toISOString()));
    assert.equal(runs.length, 3);
    spec.paused = false;
    fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
    assert.deepEqual(await ports.preview(ctx), { kind: 'none' });
    await page.reload();
    const resumed = await page.locator('body').textContent() ?? '';
    assert.equal(resumed.includes('التقارير المحلية متوقفة مؤقتاً'), false);
    assert.match(resumed, /التقارير المحلية متوقفة/);
    assert.equal(resumed.includes('مفعّلة'), false);
    spec.paused = false;
    spec.enabled = true;
    fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
    assert.deepEqual(await ports.preview(ctx), { kind: 'none' });
    await page.reload();
    const enabled = await page.locator('body').textContent() ?? '';
    assert.match(enabled, /التقارير المحلية مفعّلة/);
    assert.equal(enabled.includes('متوقفة'), false);
    assert.equal(leases.liveCount(), 0);
    assert.equal(fs.existsSync(path.join(root, 'app', 'local-report.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'app', 'proposed.json')), false);
    await page.close();
  } finally {
    await browser.close();
    await hosted?.close();
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function qatarClock(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Qatar',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('weekday')} ${value('hour')}:${value('minute')}`;
}

function serve(file: string): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing port');
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}
