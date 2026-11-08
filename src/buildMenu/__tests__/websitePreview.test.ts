import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest, WebsiteSubtype } from '../../../packages/shared/src/buildMenu.js';
import { createWebsitesPorts } from '../websites/ports.js';
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
  reload(): Promise<void>;
  close(): Promise<void>;
  url(): string;
  on(event: 'request' | 'dialog', handler: (request: { url(): string }) => void): void;
  locator(selector: string): {
    click(): Promise<void>;
    fill(value: string): Promise<void>;
    inputValue(): Promise<string>;
    textContent(): Promise<string | null>;
    getAttribute(name: string): Promise<string | null>;
    isHidden(): Promise<boolean>;
    count(): Promise<number>;
  };
}

test('the four website previews stay on this device', async () => {
  const browser = await chromium.launch({ headless: true });
  const leases = new ProcessLeaseRegistry(500);
  const ports = createWebsitesPorts({ leases });
  const roots: string[] = [];
  const jobs: BuildJobContext[] = [];
  try {
    const store = await openPreview(ports, roots, jobs, 'store', 'متجر عبايات', 'app_bcdfghjkmnpq');
    const booking = await openPreview(ports, roots, jobs, 'booking', 'حجز', 'app_bcdfghjkmnpr');
    const page = await browser.newPage();
    const external: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith(store.url) && !url.startsWith('data:') && !url.startsWith('about:')) external.push(url);
    });
    await page.goto(store.url);
    assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
    await page.locator('[data-sku="دفتر"]').click();
    await page.locator('[data-sku="قلم"]').click();
    assert.equal(await page.locator('#total').textContent(), '3700');
    await page.locator('#state').fill('["ليس-منتجاً"]');
    await page.locator('#import').click();
    assert.equal(await page.locator('#out').textContent(), 'تعذرت قراءة السلة المحفوظة؛ بدأت سلة فارغة');
    assert.equal(await page.locator('#total').textContent(), '0');
    await ports.stop(store.ctx);
    const gone = await fetch(store.url).then(() => false).catch(() => true);
    assert.equal(gone, true);
    const still = await fetch(booking.url);
    assert.equal(still.status, 200);
    assert.match(await still.text(), /حجز/);
    await page.close();

    await visit(browser, booking.url, async (next) => {
      await next.locator('[data-slot="2026-11-10T09:00"]').click();
      assert.equal(await next.locator('#out').textContent(), 'تم الحفظ محلياً');
      await next.reload();
      await next.locator('[data-slot="2026-11-10T09:00"]').click();
      assert.equal(await next.locator('#out').textContent(), 'slot_taken');
      await next.locator('#export').click();
      assert.equal(await next.locator('#state').inputValue(), '["2026-11-10T09:00"]');
      await next.locator('#state').fill('["2026-11-10T10:00"]');
      await next.locator('#import').click();
      assert.equal(await next.locator('#out').textContent(), '');
      await next.locator('[data-slot="2026-11-10T09:00"]').click();
      assert.equal(await next.locator('#out').textContent(), 'تم الحفظ محلياً');
      await next.locator('#state').fill('{bad');
      await next.locator('#import').click();
      assert.equal(await next.locator('#out').textContent(), 'تعذرت قراءة الحجوزات المحفوظة؛ بدأت قائمة فارغة');
    });
    const chat = await openPreview(ports, roots, jobs, 'chatbot', 'دردشة', 'app_bcdfghjkmnps');
    await visit(browser, chat.url, async (next) => {
      let dialogs = 0;
      next.on('dialog', () => { dialogs += 1; });
      await next.locator('input[name="q"]').fill('<img src=x onerror=alert(1)>');
      await next.locator('button[type="submit"]').click();
      assert.match(await next.locator('#log').textContent() ?? '', /<img/);
      assert.equal(await next.locator('img').count(), 0);
      assert.equal(dialogs, 0);
      assert.match(await next.locator('#out').textContent() ?? '', /تجريبية/);
    });
    const landing = await openPreview(ports, roots, jobs, 'landing', 'هبوط', 'app_bcdfghjkmnpt');
    await visit(browser, landing.url, async (next) => {
      assert.equal(await next.locator('#lead').isHidden(), true);
      await next.locator('#open').click();
      assert.equal(await next.locator('#lead').isHidden(), false);
      await next.locator('input[name="name"]').fill('خميس');
      await next.locator('#lead button[type="submit"]').click();
      assert.equal(await next.locator('#out').textContent(), 'بقيت الرسالة على هذا الجهاز');
      await next.reload();
      assert.equal(await next.locator('input[name="name"]').inputValue(), 'خميس');
      await next.locator('#export').click();
      assert.equal(await next.locator('#state').inputValue(), '"خميس"');
      await next.locator('#state').fill('{bad');
      await next.locator('#import').click();
      assert.equal(await next.locator('#out').textContent(), 'تعذرت قراءة الطلب المحفوظ؛ بدأ النموذج فارغاً');
      assert.equal(await next.locator('input[name="name"]').inputValue(), '');
      assert.equal(await next.locator('#lead').isHidden(), true);
      await next.locator('#state').fill('"ليلى"');
      await next.locator('#import').click();
      assert.equal(await next.locator('input[name="name"]').inputValue(), 'ليلى');
      await next.reload();
      assert.equal(await next.locator('input[name="name"]').inputValue(), 'ليلى');
      assert.equal(next.url().startsWith(landing.url), true);
    });
    assert.deepEqual(external, []);
  } finally {
    for (const ctx of jobs) await ports.stop(ctx).catch(() => undefined);
    await browser.close();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});

async function visit(browser: { newPage(): Promise<PreviewPage> }, url: string, check: (page: PreviewPage) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  const external: string[] = [];
  page.on('request', (request) => {
    const target = request.url();
    if (!target.startsWith(url) && !target.startsWith('data:') && !target.startsWith('about:')) external.push(target);
  });
  try {
    await page.goto(url);
    assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
    await check(page);
    assert.deepEqual(external, []);
  } finally {
    await page.close();
  }
}

async function openPreview(
  ports: ReturnType<typeof createWebsitesPorts>,
  roots: string[],
  jobs: BuildJobContext[],
  subtype: WebsiteSubtype,
  title: string,
  projectId: string,
): Promise<{ url: string; ctx: BuildJobContext }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-site-'));
  roots.push(root);
  const selection: BuildManifest['selection'] = { kind: 'website', subtype };
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: `job_site_${subtype}`,
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId,
      revision: 1,
      selection,
      title,
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'd'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
  jobs.push(ctx);
  await ports.scaffold(ctx);
  const preview = await ports.preview(ctx);
  if (preview.kind !== 'http') throw new Error('preview_not_http');
  return { url: preview.url, ctx };
}
