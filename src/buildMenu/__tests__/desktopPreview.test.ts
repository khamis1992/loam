import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { materialize } from '../materialize.js';
import { writeStoredBrief } from '../planProvenance.js';
import { widgetPreviewHtml } from '../widget/previewPage.js';
import { desktopPreviewHtml, desktopPreviewScript } from '../desktop/previewPage.js';

test('a stored brief is text on the desktop and widget pages and a remote brief is not copied', () => {
  const local = 'ملاحظة محلية على هذا الجهاز فقط';
  assert.match(desktopPreviewHtml(local), new RegExp(`<pre id="brief">${local}</pre>`));
  assert.match(widgetPreviewHtml(local), new RegExp(`<pre id="brief">${local}</pre>`));
  assert.equal(desktopPreviewHtml('انظر https://example.test').includes('https://'), false);
  assert.equal(widgetPreviewHtml('انظر https://example.test').includes('https://'), false);
  assert.equal(/https?:\/\//i.test(desktopPreviewHtml()), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-desktop-brief-'));
  try {
    writeStoredBrief(root, local);
    materialize({ selection: { kind: 'desktop' }, workspace: root, title: 'مكتب' });
    const html = fs.readFileSync(path.join(root, 'app', 'dist', 'index.html'), 'utf8');
    assert.match(html, new RegExp(`<pre id="brief">${local}</pre>`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const require = createRequire(path.resolve('packages/web/package.json'));
const { chromium } = require('playwright') as {
  chromium: {
    launch(options: { headless: boolean }): Promise<{
      newPage(): Promise<PreviewPage>;
      close(): Promise<void>;
    }>;
  };
};

interface PreviewLocator {
  fill(value: string): Promise<void>;
  focus(): Promise<void>;
  inputValue(): Promise<string>;
  textContent(): Promise<string | null>;
  isHidden(): Promise<boolean>;
}

interface PreviewPage {
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  url(): string;
  evaluate(expression: string): Promise<void>;
  close(): Promise<void>;
  addInitScript(source: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  on(event: 'request' | 'download', handler: (request: { url(): string }) => void): void;
  locator(selector: string): PreviewLocator;
}

function servePreview(): Promise<{ url: string; close(): Promise<void> }> {
  const html = desktopPreviewHtml();
  const script = desktopPreviewScript();
  const server = http.createServer((req, res) => {
    if (req.url === '/preview.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(script);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
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

test('an empty desktop note is visible and Ctrl+S saves locally', () => {
  const html = desktopPreviewHtml();
  const script = desktopPreviewScript();
  assert.match(html, /لا توجد ملاحظة بعد/);
  assert.equal(/https?:\/\//i.test(script), false);
  const storage = new Map<string, string>();
  const note = { value: '', addEventListener() {} };
  const error = { hidden: true, textContent: '' };
  const exported = { hidden: true, value: '' };
  const empty = { hidden: true };
  const handlers: {
    save: (() => void) | null;
    onKey: ((event: { ctrlKey: boolean; metaKey: boolean; key: string; preventDefault: () => void }) => void) | null;
  } = { save: null, onKey: null };
  const document = {
    querySelector(selector: string) {
      switch (selector) {
        case '#note': return note;
        case '#save-error': return error;
        case '#export': return exported;
        case '#empty': return empty;
        default: return null;
      }
    },
    addEventListener(_type: string, fn: (event: { ctrlKey: boolean; metaKey: boolean; key: string; preventDefault: () => void }) => void) { handlers.onKey = fn; },
  };
  Object.defineProperty(note, 'addEventListener', { value(_type: string, fn: () => void) { handlers.save = fn; } });
  vm.runInNewContext(script, {
    document,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
  });
  assert.equal(empty.hidden, false);
  note.value = 'تذكرة';
  handlers.save?.();
  assert.equal(empty.hidden, true);
  assert.equal(storage.get('loam-desktop-note'), 'تذكرة');
  let prevented = false;
  handlers.onKey?.({ ctrlKey: true, metaKey: false, key: 's', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(storage.get('loam-desktop-note'), 'تذكرة');
  note.value = '   ';
  handlers.save?.();
  assert.equal(empty.hidden, false);
});

test('a desktop note stays on this device and a full store shows the text to copy', async () => {
  const script = desktopPreviewScript();
  assert.equal(/https?:\/\//i.test(desktopPreviewHtml()), false);
  assert.equal(/https?:\/\//i.test(script), false);
  assert.equal(script.includes('postMessage'), false);
  assert.equal(script.includes('require('), false);
  const hosted = await servePreview();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const external: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith(hosted.url)) external.push(url);
    });
    await page.goto(hosted.url);
    assert.equal(await page.locator('#empty').isHidden(), false);
    let downloads = 0;
    page.on('download', () => { downloads += 1; });
    await page.evaluate('document.querySelector("#note").value = "اختصار"');
    await page.reload();
    assert.equal(await page.locator('#note').inputValue(), '');
    await page.evaluate('document.querySelector("#note").value = "اختصار"');
    await page.locator('#note').focus();
    await page.keyboard.press('Control+s');
    assert.equal(downloads, 0);
    assert.equal(page.url().startsWith(hosted.url), true);
    assert.equal(await page.locator('#empty').isHidden(), true);
    await page.reload();
    assert.equal(await page.locator('#note').inputValue(), 'اختصار');
    await page.evaluate('document.querySelector("#note").value = "   "');
    await page.locator('#note').focus();
    await page.keyboard.press('Control+s');
    assert.equal(await page.locator('#empty').isHidden(), false);
    await page.locator('#note').fill('تذكرة');
    await page.reload();
    assert.equal(await page.locator('#note').inputValue(), 'تذكرة');
    assert.equal(await page.locator('#save-error').isHidden(), true);
    assert.equal(await page.locator('#export').isHidden(), true);

    const denied = await browser.newPage();
    await denied.addInitScript('Storage.prototype.setItem=function(){throw new DOMException("quota","QuotaExceededError");};');
    await denied.goto(hosted.url);
    await denied.locator('#note').fill('نص لم يُحفظ');
    assert.equal(await denied.locator('#save-error').textContent(), 'تعذر الحفظ على هذا الجهاز. انسخ النص من المربع.');
    assert.equal(await denied.locator('#export').inputValue(), 'نص لم يُحفظ');
    assert.deepEqual(external, []);
  } finally {
    await browser.close();
    await hosted.close();
  }
});

test('the generated desktop folder saves with Ctrl+S and keeps the last note when storage is full', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-desktop-dist-'));
  const browser = await chromium.launch({ headless: true });
  let hosted: { url: string; close(): Promise<void> } | undefined;
  try {
    materialize({ selection: { kind: 'desktop' }, workspace: root, title: 'ملاحظة' });
    const dir = path.join(root, 'app', 'dist');
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /script-src 'self'/);
    assert.match(html, /src="\.\/preview\.js"/);
    hosted = await serveDir(dir);
    const page = await browser.newPage();
    let downloads = 0;
    page.on('download', () => { downloads += 1; });
    await page.goto(hosted.url);
    assert.equal(await page.locator('#empty').isHidden(), false);
    await page.evaluate('document.querySelector("#note").value = "اختصار"');
    await page.reload();
    assert.equal(await page.locator('#note').inputValue(), '');
    await page.evaluate('document.querySelector("#note").value = "اختصار"');
    await page.locator('#note').focus();
    await page.keyboard.press('Control+s');
    assert.equal(downloads, 0);
    assert.equal(page.url().startsWith('http://127.0.0.1:'), true);
    await page.reload();
    assert.equal(await page.locator('#note').inputValue(), 'اختصار');
    await page.evaluate('Storage.prototype.setItem=function(){throw new DOMException("quota","QuotaExceededError");};');
    await page.locator('#note').fill('نص لم يُحفظ');
    assert.equal(await page.locator('#save-error').textContent(), 'تعذر الحفظ على هذا الجهاز. انسخ النص من المربع.');
    assert.equal(await page.locator('#export').isHidden(), false);
    assert.equal(await page.locator('#export').inputValue(), 'نص لم يُحفظ');
    assert.equal(downloads, 0);
    await page.reload();
    assert.equal(await page.locator('#note').inputValue(), 'اختصار');
    assert.equal(await page.locator('#save-error').isHidden(), true);
  } finally {
    await browser.close();
    if (hosted) await hosted.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function serveDir(dir: string): Promise<{ url: string; close(): Promise<void> }> {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const name = (req.url ?? '/').split('?')[0] === '/' ? 'index.html' : (req.url ?? '').split('?')[0]!.replace(/^\//, '');
    if (name !== 'index.html' && name !== 'preview.js') {
      res.writeHead(404);
      res.end();
      return;
    }
    const file = path.resolve(root, name);
    if (!file.startsWith(`${root}${path.sep}`)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const type = name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
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
