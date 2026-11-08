import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { validateProject, type MobileProject } from '../../mobile/store.js';
import { starterMobile } from '../mobile/fixture.js';
import { simulationDocument } from '../mobile/simulation.js';
import { createMobilePorts } from '../mobile/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';

const require = createRequire(path.resolve('packages/web/package.json'));
const { chromium } = require('playwright') as {
  chromium: {
    launch(options: { headless: boolean }): Promise<{
      newPage(): Promise<MobilePage>;
      close(): Promise<void>;
    }>;
  };
};

interface MobileLocator {
  fill(value: string): Promise<void>;
  inputValue(): Promise<string>;
  check(): Promise<void>;
  isChecked(): Promise<boolean>;
  textContent(): Promise<string | null>;
  click(): Promise<void>;
  count(): Promise<number>;
  isHidden(): Promise<boolean>;
  getAttribute(name: string): Promise<string | null>;
  selectOption(option: { label: string }): Promise<void>;
  filter(options: { hasText: string }): MobileLocator;
  locator(selector: string, options?: { hasText: string }): MobileLocator;
  evaluate(fn: (node: unknown, next: string) => void, next: string): Promise<void>;
}

interface MobilePage {
  setContent(html: string): Promise<void>;
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
  on(event: 'request', handler: (request: { url(): string }) => void): void;
  evaluate<T>(expression: string | (() => T)): Promise<T>;
  frameLocator(selector: string): { locator(selector: string): MobileLocator };
  frames(): Array<{ url(): string; evaluate<T>(fn: () => T): Promise<T> }>;
  locator(selector: string): MobileLocator;
}

test('the mobile web simulation keeps a note inside its iframe', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-mobile-preview-'));
  const ports = createMobilePorts({ leases: new ProcessLeaseRegistry(500) });
  const ctx = context(root);
  const browser = await chromium.launch({ headless: true });
  try {
    await ports.scaffold(ctx);
    const preview = await ports.preview(ctx);
    assert.equal(preview.kind, 'http');
    if (preview.kind !== 'http') return;
    const page = await browser.newPage();
    const external: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith(preview.url) && !url.startsWith('data:') && !url.startsWith('about:')) external.push(url);
    });
    await page.setContent(`<iframe sandbox="allow-scripts allow-same-origin" src="${preview.url}"></iframe>`);
    await page.evaluate(() => {
      (window as unknown as { __messages: unknown[] }).__messages = [];
      window.addEventListener('message', (event) => {
        (window as unknown as { __messages: unknown[] }).__messages.push(event.data);
      });
    });
    const frame = page.frameLocator('iframe');
    assert.match(await frame.locator('p').textContent() ?? '', /ليست محاكياً أصلياً/);
    const playing = page.frames().find((item) => item.url().startsWith(preview.url));
    assert.ok(playing);
    assert.equal(await playing.evaluate(() => document.documentElement.dir), 'rtl');
    assert.equal(await playing.evaluate(() => typeof (window as unknown as { require?: unknown }).require), 'undefined');
    assert.equal(await playing.evaluate(() => typeof (window as unknown as { desktop?: unknown }).desktop), 'undefined');
    await playing.evaluate(() => localStorage.setItem('loam-sim', '{bad'));
    await page.locator('iframe').evaluate((node, next) => {
      (node as { src: string }).src = String(next);
    }, `${preview.url}?reload=1`);
    await frame.locator('h1').textContent();
    assert.equal(await frame.locator('[data-field="note"]').inputValue(), '');
    await frame.locator('[data-field="note"]').fill('تذكرة');
    await frame.locator('[data-field="done"]').check();
    await page.locator('iframe').evaluate((node, next) => {
      (node as { src: string }).src = String(next);
    }, `${preview.url}?reload=2`);
    let restored = '';
    for (let attempt = 0; attempt < 40 && restored !== 'تذكرة'; attempt += 1) {
      restored = await frame.locator('[data-field="note"]').inputValue().catch(() => '');
      if (restored !== 'تذكرة') await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(restored, 'تذكرة');
    assert.equal(await frame.locator('[data-field="done"]').isChecked(), true);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages), []);
    assert.deepEqual(external, []);
    await page.close();
  } finally {
    await browser.close();
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('opening another screen keeps the note and restores that screen', async () => {
  const html = simulationDocument(twoScreens());
  const hosted = await hostHtml(html);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(hosted.url);
    await page.locator('[data-field="note"]').fill('تذكرة');
    await page.locator('section[data-screen="home"] [data-goto="list"]').click();
    assert.equal(await page.locator('section[data-screen="list"]:not([hidden]) h1').textContent(), 'القائمة');
    await page.reload();
    assert.equal(await page.locator('section[data-screen="list"]:not([hidden]) h1').textContent(), 'القائمة');
    await page.locator('nav [data-goto="home"]').click();
    assert.equal(await page.locator('[data-field="note"]').inputValue(), 'تذكرة');
  } finally {
    await browser.close();
    await hosted.close();
  }
});

test('the back button returns to the previous screen after reload', async () => {
  const hosted = await hostHtml(simulationDocument(twoScreens()));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(hosted.url);
    assert.match(await page.locator('body').textContent() ?? '', /محاكاة الويب — ليست محاكياً أصلياً\. تصدير المصدر ليس ملف APK/);
    assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
    assert.equal(await page.locator('#back').isHidden(), true);
    await page.locator('[data-field="note"]').fill('تذكرة');
    await page.locator('section[data-screen="home"] [data-goto="list"]').click();
    assert.equal(await page.locator('section[data-screen="list"]:not([hidden]) h1').textContent(), 'القائمة');
    assert.equal(await page.locator('#back').isHidden(), false);
    await page.reload();
    assert.equal(await page.locator('section[data-screen="list"]:not([hidden]) h1').textContent(), 'القائمة');
    assert.equal(await page.locator('#back').isHidden(), false);
    await page.locator('#back').click();
    assert.equal(await page.locator('section[data-screen="home"]:not([hidden]) h1').textContent(), 'دفتر');
    assert.equal(await page.locator('#back').isHidden(), true);
    assert.equal(await page.locator('[data-field="note"]').inputValue(), 'تذكرة');
  } finally {
    await browser.close();
    await hosted.close();
  }
});

test('rotating the web simulation keeps the same note and screen', async () => {
  const hosted = await hostHtml(simulationDocument(twoScreens()));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(hosted.url);
    await page.locator('[data-field="note"]').fill('تذكرة');
    await page.locator('section[data-screen="home"] [data-goto="list"]').click();
    assert.equal(await page.locator('html').getAttribute('data-orientation'), 'portrait');
    assert.equal(await page.evaluate('getComputedStyle(document.documentElement).maxWidth'), '390px');
    await page.locator('#rotate').click();
    assert.equal(await page.locator('html').getAttribute('data-orientation'), 'landscape');
    assert.equal(await page.evaluate('getComputedStyle(document.documentElement).maxWidth'), '844px');
    await page.reload();
    assert.equal(await page.locator('section[data-screen="list"]:not([hidden]) h1').textContent(), 'القائمة');
    assert.equal(await page.locator('[data-field="note"]').inputValue(), 'تذكرة');
    assert.equal(await page.locator('html').getAttribute('data-orientation'), 'landscape');
    assert.equal(await page.locator('#back').isHidden(), false);
    await page.evaluate("localStorage.setItem('loam-sim-orientation','sideways')");
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-orientation'), 'portrait');
    assert.equal(await page.locator('[data-field="note"]').inputValue(), 'تذكرة');
    assert.match(await page.locator('body').textContent() ?? '', /محاكاة الويب — ليست محاكياً أصلياً\. تصدير المصدر ليس ملف APK/);
  } finally {
    await browser.close();
    await hosted.close();
  }
});

function hostHtml(html: string): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
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

test('a collection record is added, found, edited, and deleted on this device', async () => {
  const hosted = await hostHtml(simulationDocument(collectionProject()));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(hosted.url);
    await page.evaluate(() => localStorage.setItem('loam-sim-records', '{bad'));
    await page.reload();
    const form = page.locator('[data-collection="tasks"]');
    await form.locator('button[type="submit"]').click();
    assert.equal(await form.locator('[data-error]').textContent(), 'العنوان مطلوب');
    await form.locator('[data-col-field="name"]').fill('<img src=x>');
    await form.locator('button[type="submit"]').click();
    await form.locator('[data-col-field="name"]').fill('قلم');
    await form.locator('button[type="submit"]').click();
    assert.equal(await form.locator('[data-rows] img').count(), 0);
    await form.locator('[data-search]').fill('img');
    assert.equal(await form.locator('[data-rows] li').count(), 1);
    await form.locator('[data-search]').fill('لا شيء');
    assert.equal(await form.locator('[data-rows] li').count(), 0);
    await form.locator('[data-search]').fill('');
    await form.locator('[data-rows] li').filter({ hasText: '<img src=x>' }).locator('button', { hasText: 'تعديل' }).click();
    await form.locator('[data-col-field="name"]').fill('دفتر');
    await form.locator('button[type="submit"]').click();
    assert.equal(await form.locator('[data-rows] li').count(), 2);
    await page.reload();
    assert.match(await form.locator('[data-rows]').textContent() ?? '', /دفتر/);
    await form.locator('[data-rows] li').filter({ hasText: 'قلم' }).locator('button', { hasText: 'حذف' }).click();
    await page.reload();
    assert.equal(await form.locator('[data-rows] li').count(), 1);
    assert.equal(await form.locator('[data-rows]').textContent(), 'دفترتعديلحذف');
  } finally {
    await browser.close();
    await hosted.close();
  }
});

test('a repeated collection title is refused by the record rules', async () => {
  const project = collectionProject();
  const tasks = project.collections?.[0];
  if (!tasks) throw new Error('missing collection');
  tasks.rules = [{ id: 'one', type: 'unique', fields: ['name'], message: 'الاسم مستخدم' }];
  const checked = { ...validateProject(project), revision: 1 };
  const hosted = await hostHtml(simulationDocument(checked));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(hosted.url);
    const form = page.locator('[data-collection="tasks"]');
    await form.locator('[data-col-field="name"]').fill('دفتر');
    await form.locator('button[type="submit"]').click();
    await form.locator('[data-col-field="name"]').fill('دفتر');
    await form.locator('button[type="submit"]').click();
    assert.equal(await form.locator('[data-error]').textContent(), 'الاسم مستخدم');
    assert.equal(await form.locator('[data-rows] li').count(), 1);
  } finally {
    await browser.close();
    await hosted.close();
  }
});

test('a return date must come after the loan date', async () => {
  const hosted = await hostHtml(simulationDocument(datedProject()));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(hosted.url);
    const form = page.locator('[data-collection="loans"]');
    await form.locator('[data-col-field="name"]').fill('دفتر');
    await form.locator('[data-col-field="start"]').fill('2026-11-10');
    await form.locator('[data-col-field="due"]').fill('2026-11-10');
    await form.locator('button[type="submit"]').click();
    assert.equal(await form.locator('[data-error]').textContent(), 'موعد الإرجاع يجب أن يلي تاريخ الإعارة');
    assert.equal(await form.locator('[data-rows] li').count(), 0);
    await form.locator('[data-col-field="due"]').fill('2026-11-11');
    await form.locator('button[type="submit"]').click();
    assert.equal(await form.locator('[data-rows] li').count(), 1);
    await page.reload();
    assert.equal(await form.locator('[data-rows] li').count(), 1);
  } finally {
    await browser.close();
    await hosted.close();
  }
});

test('a collection count stays inside its numeric bounds', async () => {
  const hosted = await hostHtml(simulationDocument(countedProject()));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(hosted.url);
    const form = page.locator('[data-collection="tasks"]');
    await form.locator('[data-col-field="name"]').fill('دفتر');
    await form.locator('[data-col-field="copies"]').fill('0');
    await form.locator('button[type="submit"]').click();
    assert.equal(await form.locator('[data-error]').textContent(), 'أقل قيمة مسموحة: 1');
    assert.equal(await form.locator('[data-rows] li').count(), 0);
    await form.locator('[data-col-field="copies"]').fill('9');
    await form.locator('button[type="submit"]').click();
    assert.equal(await form.locator('[data-error]').textContent(), 'أكبر قيمة مسموحة: 5');
    await form.locator('[data-col-field="copies"]').fill('1.5');
    await form.locator('button[type="submit"]').click();
    assert.equal(await form.locator('[data-error]').textContent(), 'أدخل عددًا صحيحًا');
    await form.locator('[data-col-field="copies"]').fill('2');
    await form.locator('button[type="submit"]').click();
    assert.equal(await form.locator('[data-rows] li').count(), 1);
    await page.reload();
    assert.equal(await form.locator('[data-rows] li').count(), 1);
  } finally {
    await browser.close();
    await hosted.close();
  }
});

test('a related record stays until the link is changed', async () => {
  const hosted = await hostHtml(simulationDocument(linkedProject()));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(hosted.url);
    const people = page.locator('[data-collection="people"]');
    const tasks = page.locator('[data-collection="tasks"]');
    await people.locator('[data-col-field="name"]').fill('دفتر');
    await people.locator('button[type="submit"]').click();
    await tasks.locator('[data-col-field="name"]').fill('مهمة');
    await tasks.locator('[data-col-field="owner"]').selectOption({ label: 'دفتر' });
    await tasks.locator('button[type="submit"]').click();
    assert.equal(await tasks.locator('[data-rows] li').count(), 1);
    await people.locator('[data-rows] button', { hasText: 'حذف' }).click();
    assert.equal(await people.locator('[data-error]').textContent(), 'هذا السجل مرتبط ببيانات أخرى. غيّر الارتباط أولًا.');
    assert.equal(await people.locator('[data-rows] li').count(), 1);
  } finally {
    await browser.close();
    await hosted.close();
  }
});

function datedProject(): MobileProject {
  const starter = starterMobile();
  return {
    ...validateProject({
      ...starter,
      collections: [{
        id: 'loans',
        title: 'الإعارات',
        singular: 'إعارة',
        titleField: 'name',
        fields: [
          { id: 'name', label: 'العنوان', type: 'text', required: true },
          { id: 'start', label: 'تاريخ الإعارة', type: 'date', required: true },
          { id: 'due', label: 'تاريخ الإرجاع', type: 'date', required: true },
        ],
        rules: [{ id: 'after', type: 'compare', field: 'due', otherField: 'start', operator: 'gt', message: 'موعد الإرجاع يجب أن يلي تاريخ الإعارة' }],
      }],
      screens: [{
        id: 'home',
        title: 'دفتر',
        kind: 'primary',
        blocks: [{ id: 'loanList', type: 'collection', text: 'الإعارات', collectionId: 'loans' }],
      }],
    }),
    revision: 1,
  };
}

function countedProject(): MobileProject {
  const starter = starterMobile();
  return {
    ...validateProject({
      ...starter,
      collections: [{
        id: 'tasks',
        title: 'المهام',
        singular: 'مهمة',
        titleField: 'name',
        fields: [
          { id: 'name', label: 'عنوان المهمة', type: 'text', required: true },
          { id: 'copies', label: 'النسخ', type: 'number', required: true, min: 1, max: 5, integer: true },
        ],
      }],
      screens: [{
        id: 'home',
        title: 'دفتر',
        kind: 'primary',
        blocks: [{ id: 'list', type: 'collection', text: 'المهام', collectionId: 'tasks' }],
      }],
    }),
    revision: 1,
  };
}

function linkedProject(): MobileProject {
  const starter = starterMobile();
  return {
    ...validateProject({
      ...starter,
      collections: [
        { id: 'people', title: 'الناس', singular: 'شخص', titleField: 'name', fields: [{ id: 'name', label: 'الاسم', type: 'text', required: true }] },
        { id: 'tasks', title: 'المهام', singular: 'مهمة', titleField: 'name', fields: [
          { id: 'name', label: 'عنوان المهمة', type: 'text', required: true },
          { id: 'owner', label: 'المالك', type: 'relation', collectionId: 'people', required: true },
        ] },
      ],
      screens: [{
        id: 'home',
        title: 'دفتر',
        kind: 'primary',
        blocks: [
          { id: 'peopleBlock', type: 'collection', text: 'الناس', collectionId: 'people' },
          { id: 'tasksBlock', type: 'collection', text: 'المهام', collectionId: 'tasks' },
        ],
      }],
    }),
    revision: 1,
  };
}

function collectionProject(): MobileProject {
  const starter = starterMobile();
  return {
    ...validateProject({
      ...starter,
      collections: [{
        id: 'tasks',
        title: 'المهام',
        singular: 'مهمة',
        titleField: 'name',
        fields: [
          { id: 'name', label: 'عنوان المهمة', type: 'text', required: true },
          { id: 'done', label: 'مكتملة', type: 'boolean' },
        ],
      }],
      screens: [{
        id: 'home',
        title: 'دفتر',
        kind: 'primary',
        blocks: [{ id: 'list', type: 'collection', text: 'المهام', collectionId: 'tasks' }],
      }],
    }),
    revision: 1,
  };
}

function twoScreens(): MobileProject {
  const starter = starterMobile();
  const home = starter.screens[0];
  if (!home) throw new Error('missing home');
  return {
    ...validateProject({
      ...starter,
      screens: [
        { ...home, blocks: [...home.blocks, { id: 'open', type: 'button', text: 'القائمة', target: 'list' }] },
        { id: 'list', title: 'القائمة', kind: 'primary', blocks: [{ id: 'item', type: 'heading', text: 'عناصر' }] },
      ],
    }),
    revision: 1,
  };
}

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'mobile' };
  return {
    workspace,
    jobId: 'job_mobile_preview',
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_bcdfghjkmnpq',
      revision: 1,
      selection,
      title: 'دفتر ملاحظات',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'f'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}
