import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { materialize } from '../materialize.js';
import { widgetBrief, widgetProfile } from '../widget/profile.js';
import { clampPosition, widgetFrame } from '../widget/geometry.js';
import { decideAutostart, widgetPortableLabel, widgetReleaseMatrix } from '../widget/autostartPolicy.js';
import { desktopPreviewHtml } from '../desktop/previewPage.js';
import { widgetPreviewHtml, widgetPreviewScript } from '../widget/previewPage.js';

const require = createRequire(import.meta.url);
const playwrightRequire = createRequire(path.resolve('packages/web/package.json'));
const { chromium } = playwrightRequire('playwright') as {
  chromium: {
    launch(options: { headless: boolean }): Promise<{
      newPage(): Promise<{
        clock: { install(options: { time: Date }): Promise<void>; fastForward(ms: number): Promise<void> };
        goto(url: string): Promise<void>;
        reload(): Promise<void>;
        close(): Promise<void>;
        evaluate(source: string): Promise<void>;
        on(event: 'request', handler: (request: { url(): string }) => void): void;
        locator(selector: string): {
          textContent(): Promise<string | null>;
          inputValue(): Promise<string>;
          fill(value: string): Promise<void>;
          isDisabled(): Promise<boolean>;
          isChecked(): Promise<boolean>;
        };
      }>;
      close(): Promise<void>;
    }>;
  };
};
const templateGeometry = require('../../templates/electron-app/electron/widget-geometry.cjs') as {
  clampPosition: typeof clampPosition;
  widgetFrame: typeof widgetFrame;
  WIDGET_WIDTH: number;
  WIDGET_HEIGHT: number;
  MOVE_DEBOUNCE_MS: number;
};

test('widget: fixed capability boundary', () => {
  assert.equal(widgetProfile.kind, 'widget');
  assert.equal(widgetProfile.preview, 'widget');
  assert.equal(widgetProfile.externalEffects, 'approval-required');
  assert.ok(widgetProfile.exports.includes('source-zip'));
  assert.ok(widgetBrief.length > 40);
});

test('monitor unplugged never hides widget outside current display', () => {
  const area = { x: 0, y: 0, width: 1280, height: 720 };
  const point = { x: 3000, y: -200 };
  assert.deepEqual(clampPosition(point, area), { x: 960, y: 0 });
  assert.deepEqual(templateGeometry.clampPosition(point, area), clampPosition(point, area));
  assert.deepEqual(templateGeometry.widgetFrame(false), widgetFrame(false));
  assert.deepEqual(widgetFrame(false), { width: 320, height: 220, expanded: false });
  assert.deepEqual(templateGeometry.widgetFrame(true), { width: 480, height: 360, expanded: true });
  assert.deepEqual(clampPosition(point, area, widgetFrame(true)), { x: 800, y: 0 });
  assert.equal(templateGeometry.WIDGET_WIDTH, 320);
  assert.equal(templateGeometry.WIDGET_HEIGHT, 220);
  assert.equal(templateGeometry.MOVE_DEBOUNCE_MS, 250);
});

test('widget preview counts three hundred seconds and drops the timer when hidden', () => {
  const html = widgetPreviewHtml();
  const script = widgetPreviewScript();
  assert.match(html, /id="countdown"/);
  assert.match(html, /id="autostart-toggle"[^>]*disabled/);
  assert.match(html, /بدء هذا الويدجت مع دخول Windows غير متاح في النسخة المحمولة حتى يُثبَّت بمسار ثابت/);
  assert.equal(desktopPreviewHtml().includes('id="autostart"'), false);
  assert.equal(script.includes('setLoginItemSettings'), false);
  assert.equal(/https?:\/\//i.test(html), false);
  assert.equal(/https?:\/\//i.test(script), false);
  let now = 1_700_000_000_000;
  let started = 0;
  let cleared = 0;
  const clock: { tick: (() => void) | null } = { tick: null };
  const countdown = { textContent: '' };
  const note = { value: '', trim() { return this.value.trim(); }, addEventListener() {} };
  const error = { hidden: true, textContent: '' };
  const exported = { hidden: true, value: '' };
  const empty = { hidden: false };
  const listeners = new Map<string, Array<() => void>>();
  function listen(name: string, fn: () => void): void {
    const current = listeners.get(name) ?? [];
    current.push(fn);
    listeners.set(name, current);
  }
  const document = {
    visibilityState: 'visible',
    querySelector(selector: string) {
      switch (selector) {
        case '#countdown': return countdown;
        case '#note': return note;
        case '#save-error': return error;
        case '#export': return exported;
        case '#empty': return empty;
        default: return null;
      }
    },
    addEventListener: listen,
  };
  vm.runInNewContext(script, {
    document,
    window: { addEventListener: listen },
    Date: { now: () => now },
    localStorage: { getItem: () => '', setItem() {} },
    setInterval(fn: () => void) {
      started += 1;
      clock.tick = fn;
      return 1;
    },
    clearInterval() { cleared += 1; },
  });
  assert.equal(countdown.textContent, '300');
  assert.equal(started, 1);
  now += 5_000;
  clock.tick?.();
  assert.equal(countdown.textContent, '295');
  document.visibilityState = 'hidden';
  for (const fn of listeners.get('visibilitychange') ?? []) fn();
  assert.equal(cleared, 1);
  now += 60_000;
  clock.tick?.();
  assert.equal(countdown.textContent, '295');
});

test('widget autostart stays off and the template does not register a login item', () => {
  assert.deepEqual(decideAutostart({ requested: false, userGranted: false, portable: false }), { enabled: false, reason: 'default' });
  assert.deepEqual(decideAutostart({ requested: true, userGranted: false, portable: false }), { enabled: false, reason: 'grant_required' });
  assert.deepEqual(decideAutostart({ requested: true, userGranted: true, portable: true }), { enabled: false, reason: 'portable_unsupported' });
  assert.deepEqual(decideAutostart({ requested: false, userGranted: true, portable: false }), { enabled: false, reason: 'disabled' });
  assert.equal(decideAutostart({ requested: true, userGranted: true, portable: false }).enabled, false);
  const source = fs.readFileSync(new URL('../../templates/electron-app/electron/main.cjs', import.meta.url), 'utf8');
  assert.equal(source.includes('setLoginItemSettings'), false);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /quitting = true/);
  assert.match(source, /label: 'Expand'/);
  assert.match(source, /label: 'Compact'/);
});

test('widget release matrix keeps autostart off and does not promise a portable executable', () => {
  const rows = widgetReleaseMatrix();
  assert.deepEqual(rows.map((row) => row.mode), ['portable', 'development', 'installed']);
  for (const row of rows) {
    assert.equal(row.enabled, false);
    assert.equal(row.startupFolder, false);
    assert.equal(row.signed, false);
    assert.equal(row.built, false);
  }
  assert.equal(rows[0]?.reason, 'portable_unsupported');
  assert.equal(rows[1]?.reason, 'not_applied');
  assert.equal(rows[2]?.reason, 'not_applied');
  const label = widgetPortableLabel();
  assert.equal(label.includes('غير موقّعة'), true);
  assert.equal(label.includes('لم يُبنَ'), true);
  assert.equal(label.includes('بدء تشغيل'), true);
  assert.equal(/https?:\/\//i.test(label), false);
  const html = widgetPreviewHtml();
  assert.equal(html.includes(label), true);
  assert.match(html, /id="portable-export"/);
  assert.equal(desktopPreviewHtml().includes('id="portable-export"'), false);
  const forbidden = ['setLoginItemSettings', 'openAtLogin', 'shell:startup', 'Start Menu\\Programs'];
  const sources = [
    fs.readFileSync(new URL('../widget/autostartPolicy.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../widget/previewPage.ts', import.meta.url), 'utf8'),
    widgetPreviewScript(),
    fs.readFileSync(new URL('../../templates/electron-app/electron/main.cjs', import.meta.url), 'utf8'),
  ];
  for (const source of sources) {
    for (const phrase of forbidden) assert.equal(source.includes(phrase), false);
  }
});

test('a frameless widget keeps a hashed drag region and does not click through', () => {
  const html = widgetPreviewHtml();
  const style = html.match(/<style>([^<]*)<\/style>/)?.[1] ?? '';
  assert.equal(style.includes('#drag{-webkit-app-region:drag;app-region:drag;'), true);
  assert.equal(style.includes('#note,#export,#autostart,#autostart-toggle,#countdown{-webkit-app-region:no-drag;app-region:no-drag}'), true);
  assert.equal(style.includes('pointer-events:none'), false);
  assert.equal(/https?:\/\//i.test(style), false);
  const hash = createHash('sha256').update(style).digest('base64');
  assert.equal(html.includes(`style-src 'self' 'sha256-${hash}'`), true);
  assert.equal(html.includes('unsafe-inline'), false);
  assert.equal(desktopPreviewHtml().includes('-webkit-app-region'), false);
  const main = fs.readFileSync(new URL('../../templates/electron-app/electron/main.cjs', import.meta.url), 'utf8');
  assert.equal(main.includes('setIgnoreMouseEvents'), false);
  assert.match(main, /frame: !widget/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-drag-'));
  try {
    materialize({ selection: { kind: 'widget' }, workspace: root, title: 'سحب' });
    assert.equal(fs.readFileSync(path.join(root, 'app', 'dist', 'index.html'), 'utf8'), html);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'desktop-app.json'), 'utf8').includes('"surface": "widget"'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the tray icon is a local square', () => {
  const source = fs.readFileSync(new URL('../../templates/electron-app/electron/main.cjs', import.meta.url), 'utf8');
  const encoded = source.match(/createFromBuffer\(Buffer\.from\(\s*'([A-Za-z0-9+/=]+)'/)?.[1];
  assert.ok(encoded);
  const png = Buffer.from(encoded, 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 16);
  assert.equal(png.readUInt32BE(20), 16);
  assert.equal(source.includes('★'), false);
  assert.equal(source.includes('setIgnoreMouseEvents'), false);
  let offset = 8;
  const parts: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IDAT') parts.push(data);
    offset += 12 + length;
  }
  const rows = zlib.inflateSync(Buffer.concat(parts));
  const pixel = rows.subarray(1, 4);
  for (let y = 0; y < 16; y += 1) {
    assert.equal(rows[y * 49], 0);
    for (let x = 0; x < 16; x += 1) {
      assert.deepEqual(rows.subarray(y * 49 + 1 + x * 3, y * 49 + 4 + x * 3), pixel);
    }
  }
});

test('the widget countdown runs in a browser and stops when the page is hidden', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-clock-'));
  materialize({ selection: { kind: 'widget' }, workspace: root, title: 'تركيز' });
  const browser = await chromium.launch({ headless: true });
  let hosted: { url: string; close(): Promise<void> } | undefined;
  try {
    hosted = await host(path.join(root, 'app', 'dist'));
    const page = await browser.newPage();
    const leaks: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(hosted!.url)) leaks.push(request.url());
    });
    await page.clock.install({ time: new Date('2026-11-07T08:00:00Z') });
    await page.goto(hosted.url);
    assert.match(await page.locator('#autostart').textContent() ?? '', /غير متاح في النسخة المحمولة/);
    assert.match(await page.locator('#portable-export').textContent() ?? '', /غير موقّعة/);
    assert.match(await page.locator('#portable-export').textContent() ?? '', /لم يُبنَ/);
    assert.equal(await page.locator('#autostart-toggle').isDisabled(), true);
    assert.equal(await page.locator('#autostart-toggle').isChecked(), false);
    assert.equal(await page.locator('#countdown').textContent(), '300');
    await page.clock.fastForward(5_000);
    assert.equal(await page.locator('#countdown').textContent(), '295');
    await page.evaluate("Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));");
    await page.clock.fastForward(60_000);
    assert.equal(await page.locator('#countdown').textContent(), '295');
    await page.locator('#note').fill('تركيز');
    assert.equal(await page.locator('#countdown').textContent(), '295');
    await page.reload();
    assert.equal(await page.locator('#note').inputValue(), 'تركيز');
    assert.equal(await page.locator('#countdown').textContent(), '300');
    assert.equal(await page.locator('#autostart-toggle').isDisabled(), true);
    assert.equal(await page.locator('#autostart-toggle').isChecked(), false);
    await page.evaluate('Storage.prototype.setItem=function(){throw new DOMException("quota","QuotaExceededError");};');
    await page.locator('#note').fill('نص لم يُحفظ');
    assert.equal(await page.locator('#countdown').textContent(), '300');
    assert.equal(await page.locator('#save-error').textContent(), 'تعذر الحفظ على هذا الجهاز. انسخ النص من المربع.');
    assert.equal(await page.locator('#export').inputValue(), 'نص لم يُحفظ');
    await page.reload();
    assert.equal(await page.locator('#note').inputValue(), 'تركيز');
    assert.deepEqual(leaks, []);
    assert.match(fs.readFileSync(path.join(root, 'app', 'dist', 'index.html'), 'utf8'), /script-src 'self'/);
    await page.close();
  } finally {
    if (hosted) await hosted.close();
    await browser.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function host(dir: string): Promise<{ url: string; close(): Promise<void> }> {
  const root = path.resolve(dir);
  const server = http.createServer((request, response) => {
    const requestPath = (request.url ?? '/').split('?')[0] ?? '/';
    const name = requestPath === '/' ? 'index.html' : requestPath.replace(/^\//, '');
    if (name !== 'index.html' && name !== 'preview.js') {
      response.writeHead(404);
      response.end();
      return;
    }
    const file = path.resolve(root, name);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
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
