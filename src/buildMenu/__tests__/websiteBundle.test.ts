import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { createWebsitesPorts } from '../websites/ports.js';
import { BuildMenuError } from '../grants.js';
import { ProcessLeaseRegistry } from '../processLease.js';

const require = createRequire(path.resolve('packages/web/package.json'));
const { chromium } = require('playwright') as {
  chromium: {
    launch(options: { headless: boolean }): Promise<{
      newPage(): Promise<{
        goto(url: string): Promise<void>;
        reload(): Promise<void>;
        close(): Promise<void>;
        on(event: 'request', handler: (request: { url(): string; headers(): Record<string, string> }) => void): void;
        url(): string;
        locator(selector: string): {
          click(): Promise<void>;
          fill(value: string): Promise<void>;
          textContent(): Promise<string | null>;
          inputValue(): Promise<string>;
          isHidden(): Promise<boolean>;
        };
      }>;
      close(): Promise<void>;
    }>;
  };
};

test('a website web zip reloads from its own static host', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-webzip-'));
  const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-webzip-out-'));
  const ports = createWebsitesPorts({ leases: new ProcessLeaseRegistry(200) });
  const ctx = context(root);
  const browser = await chromium.launch({ headless: true });
  let hosted: { url: string; close(): Promise<void> } | undefined;
  try {
    await ports.scaffold(ctx);
    const previewPage = path.join(root, 'app', 'preview.html');
    const previewBytes = fs.readFileSync(previewPage);
    fs.rmSync(previewPage);
    await assert.rejects(ports.export(ctx, 'web-zip'), (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement');
    assert.equal(fs.existsSync(path.join(root, 'app', 'dist', 'index.html')), false);
    fs.writeFileSync(previewPage, previewBytes);
    const artifact = await ports.export(ctx, 'web-zip');
    const index = fs.readFileSync(path.join(root, 'app', 'dist', 'index.html'), 'utf8');
    assert.match(index, /src="\.\/page\.js"/);
    assert.equal(index.includes('<script>'), false);
    const zipPath = path.join(root, artifact.relativePath);
    const bytes = fs.readFileSync(zipPath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    const files = unzip(bytes);
    assert.deepEqual([...files.keys()].sort(), ['index.html', 'page.js']);
    fs.writeFileSync(path.join(root, 'app', 'dist', 'index.html'), `${index}\n<!-- changed -->\n`);
    assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
    for (const [name, body] of files) fs.writeFileSync(path.join(unpacked, name), body);

    hosted = await host(unpacked);
    const page = await browser.newPage();
    const leaks: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      const headers = request.headers();
      if (!url.startsWith(hosted!.url)) leaks.push(url);
      if (headers.authorization || headers['x-loam-local-token']) leaks.push('token');
    });
    await page.goto(hosted.url);
    await page.locator('[data-sku="دفتر"]').click();
    await page.locator('[data-sku="قلم"]').click();
    assert.equal(await page.locator('#total').textContent(), '3700');
    await page.reload();
    assert.equal(await page.locator('#total').textContent(), '3700');
    await page.locator('#export').click();
    assert.equal(await page.locator('#state').inputValue(), '["دفتر","قلم"]');
    await page.locator('#state').fill('["ليس-منتجاً"]');
    await page.locator('#import').click();
    assert.equal(await page.locator('#out').textContent(), 'تعذرت قراءة السلة المحفوظة؛ بدأت سلة فارغة');
    assert.equal(await page.locator('#total').textContent(), '0');
    await page.locator('#state').fill('["حقيبة"]');
    await page.locator('#import').click();
    await page.reload();
    assert.equal(await page.locator('#total').textContent(), '4500');
    assert.deepEqual(leaks, []);
    await page.close();
  } finally {
    if (hosted) await hosted.close();
    await browser.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(unpacked, { recursive: true, force: true });
  }
});

test('landing, booking, and chatbot packages reload without this app', async () => {
  const browser = await chromium.launch({ headless: true });
  const pages: Array<{ subtype: 'landing' | 'booking' | 'chatbot'; title: string; projectId: string; check: (page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newPage']>>) => Promise<void> }> = [
    {
      subtype: 'booking',
      title: 'حجز',
      projectId: 'app_bcdfghjkmnpr',
      check: async (page) => {
        await page.locator('[data-slot="2026-11-10T09:00"]').click();
        assert.equal(await page.locator('#out').textContent(), 'تم الحفظ محلياً');
        await page.reload();
        await page.locator('[data-slot="2026-11-10T09:00"]').click();
        assert.equal(await page.locator('#out').textContent(), 'slot_taken');
        await page.locator('#export').click();
        assert.equal(await page.locator('#state').inputValue(), '["2026-11-10T09:00"]');
        await page.locator('#state').fill('["2026-11-10T10:00"]');
        await page.locator('#import').click();
        await page.locator('[data-slot="2026-11-10T09:00"]').click();
        assert.equal(await page.locator('#out').textContent(), 'تم الحفظ محلياً');
        await page.locator('#state').fill('{bad');
        await page.locator('#import').click();
        assert.equal(await page.locator('#out').textContent(), 'تعذرت قراءة الحجوزات المحفوظة؛ بدأت قائمة فارغة');
      },
    },
    {
      subtype: 'chatbot',
      title: 'دردشة',
      projectId: 'app_bcdfghjkmnps',
      check: async (page) => {
        await page.locator('input[name="q"]').fill('احجز الآن');
        await page.locator('button[type="submit"]').click();
        assert.match(await page.locator('#out').textContent() ?? '', /تجريبية/);
        await page.reload();
        assert.match(await page.locator('#log').textContent() ?? '', /تجريبية/);
        await page.locator('#export').click();
        assert.match(await page.locator('#state').inputValue(), /احجز الآن/);
        await page.locator('#state').fill('{bad');
        await page.locator('#import').click();
        assert.equal(await page.locator('#out').textContent(), 'تعذرت قراءة المحادثة المحفوظة؛ بدأت محادثة فارغة');
        assert.equal(await page.locator('#log').textContent(), '');
        await page.locator('#state').fill('["<img src=x onerror=alert(1)>"]');
        await page.locator('#import').click();
        assert.match(await page.locator('#log').textContent() ?? '', /<img/);
        await page.reload();
        assert.equal(await page.locator('#log').textContent(), '<img src=x onerror=alert(1)>');
      },
    },
    {
      subtype: 'landing',
      title: 'هبوط',
      projectId: 'app_bcdfghjkmnpt',
      check: async (page) => {
        assert.equal(await page.locator('#lead').isHidden(), true);
        await page.locator('#open').click();
        await page.locator('input[name="name"]').fill('خميس');
        await page.locator('#lead button[type="submit"]').click();
        assert.equal(await page.locator('#out').textContent(), 'بقيت الرسالة على هذا الجهاز');
        await page.reload();
        assert.equal(await page.locator('#lead').isHidden(), false);
        assert.equal(await page.locator('input[name="name"]').inputValue(), 'خميس');
        await page.locator('#export').click();
        assert.equal(await page.locator('#state').inputValue(), '"خميس"');
        await page.locator('#state').fill('{bad');
        await page.locator('#import').click();
        assert.equal(await page.locator('#out').textContent(), 'تعذرت قراءة الطلب المحفوظ؛ بدأ النموذج فارغاً');
        assert.equal(await page.locator('input[name="name"]').inputValue(), '');
        assert.equal(await page.locator('#lead').isHidden(), true);
        await page.locator('#state').fill('"ليلى"');
        await page.locator('#import').click();
        await page.reload();
        assert.equal(await page.locator('input[name="name"]').inputValue(), 'ليلى');
        assert.equal(page.url().startsWith('http://127.0.0.1:'), true);
      },
    },
  ];
  try {
    for (const item of pages) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-webzip-'));
      const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-webzip-out-'));
      const ports = createWebsitesPorts({ leases: new ProcessLeaseRegistry(200) });
      let hosted: { url: string; close(): Promise<void> } | undefined;
      try {
        const ctx = context(root, item.subtype, item.title, item.projectId);
        await ports.scaffold(ctx);
        const artifact = await ports.export(ctx, 'web-zip');
        const files = unzip(fs.readFileSync(path.join(root, artifact.relativePath)));
        assert.deepEqual([...files.keys()].sort(), ['index.html', 'page.js']);
        const script = files.get('page.js')?.toString('utf8') ?? '';
        assert.equal(/https?:\/\//i.test(script), false);
        for (const [name, body] of files) fs.writeFileSync(path.join(unpacked, name), body);
        hosted = await host(unpacked);
        const page = await browser.newPage();
        const leaks: string[] = [];
        page.on('request', (request) => {
          const url = request.url();
          const headers = request.headers();
          if (!url.startsWith(hosted!.url)) leaks.push(url);
          if (headers.authorization || headers['x-loam-local-token']) leaks.push('token');
        });
        await page.goto(hosted.url);
        await item.check(page);
        assert.deepEqual(leaks, []);
        await page.close();
      } finally {
        if (hosted) await hosted.close();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(unpacked, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
  }
});

function context(workspace: string, subtype: 'landing' | 'store' | 'booking' | 'chatbot' = 'store', title = 'متجر عبايات', projectId = 'app_bcdfghjkmnpq'): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'website', subtype };
  return {
    workspace,
    jobId: 'job_website_zip',
    operation: { action: 'package', format: 'web-zip' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId,
      revision: 3,
      selection,
      title,
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'e'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

function host(dir: string): Promise<{ url: string; close(): Promise<void> }> {
  const root = path.resolve(dir);
  const server = http.createServer((request, response) => {
    const name = (request.url ?? '/').split('?')[0] === '/' ? 'index.html' : (request.url ?? '').split('?')[0]!.replace(/^\//, '');
    if (name !== 'index.html' && name !== 'page.js') {
      response.writeHead(404);
      response.end();
      return;
    }
    const file = path.resolve(root, name);
    if (!file.startsWith(root)) {
      response.writeHead(400);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
    response.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
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
