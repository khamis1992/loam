import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { BuildJobContext } from '../../../packages/shared/src/buildMenu.js';
import { materialize } from '../materialize.js';
import { createChromePorts } from '../chrome/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';

const require = createRequire(path.resolve('packages/web/package.json'));
const { chromium } = require('playwright') as {
  chromium: {
    launch(options: { headless: boolean }): Promise<{
      newPage(): Promise<{
        goto(url: string): Promise<void>;
        close(): Promise<void>;
        addInitScript(source: string): Promise<void>;
        on(event: 'dialog' | 'request', handler: (value: { url(): string }) => void): void;
        evaluate<T>(source: string): Promise<T>;
        evaluate<T>(fn: () => T): Promise<T>;
        locator(selector: string): {
          click(): Promise<void>;
          textContent(): Promise<string | null>;
          count(): Promise<number>;
          getAttribute(name: string): Promise<string | null>;
        };
      }>;
      close(): Promise<void>;
    }>;
  };
};

test('the popup shows a missing Chrome API as text and does not run the title', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-popup-'));
  const browser = await chromium.launch({ headless: true });
  let hosted: { url: string; close(): Promise<void> } | undefined;
  try {
    materialize({ selection: { kind: 'chrome-extension' }, workspace: root, title: '<img src=x onerror=alert(1)>' });
    hosted = await host(path.join(root, 'app'));
    const page = await browser.newPage();
    const leaks: string[] = [];
    let dialogs = 0;
    page.on('dialog', () => { dialogs += 1; });
    page.on('request', (request) => {
      if (!request.url().startsWith(hosted!.url)) leaks.push(request.url());
    });
    await page.goto(hosted.url);
    assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => document.querySelectorAll('script:not([src])').length), 0);
    assert.match(await page.locator('h1').textContent() ?? '', /<img/);
    await page.locator('#capture').click();
    assert.equal(await page.locator('#result').textContent(), 'تعذر الحفظ: missing_chrome');
    assert.equal(dialogs, 0);
    assert.deepEqual(leaks, []);
    await page.close();
  } finally {
    if (hosted) await hosted.close();
    await browser.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the popup stores one page as text and refuses a browser page', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-popup-api-'));
  const ports = createChromePorts({ leases: new ProcessLeaseRegistry(200), chromeExecutable: null });
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: 'job_chrome_popup',
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_bcdfghjkmnpq',
      revision: 1,
      selection: { kind: 'chrome-extension' },
      title: 'ملاحظة',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'b'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
  const browser = await chromium.launch({ headless: true });
  try {
    materialize({ selection: { kind: 'chrome-extension' }, workspace: root, title: 'ملاحظة' });
    const preview = await ports.preview(ctx);
    assert.equal(preview.kind, 'http');
    if (preview.kind !== 'http') return;
    const page = await browser.newPage();
    let dialogs = 0;
    const leaks: string[] = [];
    page.on('dialog', () => { dialogs += 1; });
    page.on('request', (request) => {
      if (!request.url().startsWith(preview.url)) leaks.push(request.url());
    });
    await page.addInitScript(`
      globalThis.__notes = { 'http://127.0.0.1/other': 'صفحة أخرى' };
      globalThis.__url = 'http://127.0.0.1/fixture';
      globalThis.__scripted = 0;
      globalThis.chrome = {
        tabs: { query: async () => [{ id: 7, url: globalThis.__url }] },
        scripting: { executeScript: async () => { globalThis.__scripted += 1; return [{ result: '<img src=x onerror=alert(1)>' }]; } },
        storage: { local: {
          get: async () => ({ notes: globalThis.__notes }),
          set: async (value) => { globalThis.__notes = value.notes; },
        } },
      };
    `);
    await page.goto(preview.url);
    await page.locator('#capture').click();
    const savedText = await readResult(page);
    assert.equal(savedText, 'حُفظت الملاحظة محلياً.');
    assert.equal(await page.locator('img').count(), 0);
    const notes = await page.evaluate<Record<string, string>>('globalThis.__notes');
    assert.equal(notes['http://127.0.0.1/fixture'], '<img src=x onerror=alert(1)>');
    assert.equal(notes['http://127.0.0.1/other'], 'صفحة أخرى');
    await page.evaluate("globalThis.__url = 'chrome://extensions';");
    await page.locator('#capture').click();
    const blocked = await readResult(page, savedText);
    assert.match(blocked, /unsupported_page/);
    assert.equal(await page.evaluate<number>('globalThis.__scripted'), 1);
    await page.evaluate("globalThis.__url = 'http://127.0.0.1/fixture'; globalThis.chrome.scripting.executeScript = async () => { throw new Error('script_denied'); };");
    await page.locator('#capture').click();
    const denied = await readResult(page, blocked);
    assert.match(denied, /تعذر الحفظ: script_denied/);
    await page.evaluate("globalThis.chrome.scripting.executeScript = async () => { globalThis.__scripted += 1; return [{ result: '   ' }]; };");
    await page.locator('#capture').click();
    assert.equal(await readResult(page, denied), 'تعذر الحفظ: empty_selection');
    assert.equal(await page.evaluate<number>('globalThis.__scripted'), 2);
    const kept = await page.evaluate<Record<string, string>>('globalThis.__notes');
    assert.equal(kept['http://127.0.0.1/fixture'], '<img src=x onerror=alert(1)>');
    assert.equal(kept['http://127.0.0.1/other'], 'صفحة أخرى');
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(dialogs, 0);
    assert.deepEqual(leaks, []);
    await page.close();
    await ports.stop(ctx);
    await assert.rejects(fetch(preview.url, { signal: AbortSignal.timeout(1_000) }));
  } finally {
    await browser.close();
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function readResult(page: { locator(selector: string): { textContent(): Promise<string | null> } }, previous = ''): Promise<string> {
  let text = previous;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    text = await page.locator('#result').textContent() ?? '';
    if (text.length > 0 && text !== previous) return text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return text;
}

function host(dir: string): Promise<{ url: string; close(): Promise<void> }> {
  const root = path.resolve(dir);
  const server = http.createServer((request, response) => {
    const name = (request.url ?? '/').split('?')[0] === '/' ? 'popup.html' : (request.url ?? '').split('?')[0]!.replace(/^\//, '');
    if (name !== 'popup.html' && name !== 'popup.js') {
      response.writeHead(404);
      response.end();
      return;
    }
    const file = path.resolve(root, name);
    if (!file.startsWith(`${root}${path.sep}`) && file !== root) {
      response.writeHead(400);
      response.end();
      return;
    }
    const type = name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    response.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' });
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
