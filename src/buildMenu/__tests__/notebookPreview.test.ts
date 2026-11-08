import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext } from '../../../packages/shared/src/buildMenu.js';
import { copyApprovedCsv } from '../notebooks/csv.js';
import { createNotebooksPorts } from '../notebooks/ports.js';
import { notebookExportText } from '../notebooks/document.js';
import { notebookPage, parseNotebook } from '../notebooks/view.js';
import { ProcessLeaseRegistry } from '../processLease.js';

const require = createRequire(path.resolve('packages/web/package.json'));
const { chromium } = require('playwright') as {
  chromium: {
    launch(options: { headless: boolean }): Promise<{
      newPage(): Promise<{
        setContent(html: string): Promise<void>;
        goto(url: string): Promise<void>;
        reload(): Promise<void>;
        close(): Promise<void>;
        on(event: 'dialog' | 'request', handler: (value: { url(): string }) => void): void;
        locator(selector: string): {
          count(): Promise<number>;
          fill(value: string): Promise<void>;
          click(): Promise<void>;
          inputValue(): Promise<string>;
          getAttribute(name: string): Promise<string | null>;
          textContent(): Promise<string | null>;
        };
        evaluate<T>(fn: () => T): Promise<T>;
      }>;
      close(): Promise<void>;
    }>;
  };
};

test('a notebook page shows escaped output and does not run it', async () => {
  const pageHtml = notebookPage(parseNotebook(JSON.stringify({
    nbformat: 4,
    cells: [{
      id: 'cell-1',
      source: ['print(1)'],
      outputs: [{
        output_type: 'display_data',
        data: {
          'text/html': '<script>alert(1)</script>',
          'image/svg+xml': '<svg onload="alert(1)"></svg>',
          'text/plain': '3',
          'image/png': 'iVBORw0KGgo=',
        },
      }],
    }],
  })));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let dialogs = 0;
    page.on('dialog', () => { dialogs += 1; });
    await page.setContent(pageHtml);
    assert.equal(await page.locator('script').count(), 0);
    assert.equal(await page.locator('svg').count(), 0);
    assert.equal(await page.locator('a').count(), 0);
    assert.equal(await page.locator('#kernel-note').textContent(), 'لم تُنفَّذ خلية على هذا الجهاز. يمكن تحرير الدفتر وتصديره بلا حاوية.');
    assert.equal(await page.locator('img').getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=');
    assert.match(await page.evaluate(() => document.body.textContent ?? ''), /&lt;script&gt;|alert\(1\)|<script>|alert/);
    const text = await page.evaluate(() => document.body.innerText);
    assert.match(text, /alert\(1\)/);
    assert.equal(dialogs, 0);
    await page.close();
  } finally {
    await browser.close();
  }
});

test('a notebook preview shows a local csv as text and does not run it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notebook-csv-'));
  const ports = createNotebooksPorts({ leases: new ProcessLeaseRegistry(200) });
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: 'job_notebook_csv',
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_bcdfghjkmnpq',
      revision: 1,
      selection: { kind: 'notebook' },
      title: 'دفتر',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'b'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
  const browser = await chromium.launch({ headless: true });
  try {
    await ports.scaffold(ctx);
    fs.mkdirSync(path.join(root, 'app', 'inbox'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'inbox', 'sales.csv'), 'amount\n2\n<script>alert(1)</script>\n');
    assert.equal(copyApprovedCsv(root, 'app/inbox/sales.csv'), 'app/data/sales.csv');
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
    await page.goto(preview.url);
    const text = await page.locator('body').textContent();
    assert.match(text ?? '', /بيانات محلية — لم تُنفَّذ/);
    assert.equal(await page.locator('#kernel-note').textContent(), 'لم تُنفَّذ خلية على هذا الجهاز. يمكن تحرير الدفتر وتصديره بلا حاوية.');
    assert.equal(await page.locator('a').count(), 0);
    assert.match(text ?? '', /amount/);
    assert.match(text ?? '', /alert\(1\)/);
    assert.equal(await page.locator('script').count(), 0);
    assert.equal(dialogs, 0);
    assert.deepEqual(leaks, []);
    const source = await (await fetch(preview.url)).text();
    assert.equal(source.includes('<script'), false);
    assert.equal(/https?:\/\//i.test(source), false);
    await page.close();
    await ports.stop(ctx);
    await assert.rejects(fetch(preview.url, { signal: AbortSignal.timeout(1_000) }));
  } finally {
    await browser.close();
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an interrupted notebook preview keeps the cell and says the kernel restarted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notebook-stop-'));
  const ports = createNotebooksPorts({ leases: new ProcessLeaseRegistry(200) });
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: 'job_notebook_stop',
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_bcdfghjkmnpr',
      revision: 1,
      selection: { kind: 'notebook' },
      title: 'دفتر',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'b'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
  const browser = await chromium.launch({ headless: true });
  try {
    await ports.scaffold(ctx);
    const file = path.join(root, 'app', 'notebook.ipynb');
    const book = JSON.parse(fs.readFileSync(file, 'utf8')) as { cells: Array<{ source: string[]; outputs: unknown[] }> };
    const source = book.cells[0]?.source ?? [];
    assert.equal(source.length > 0, true);
    const cell = book.cells[0];
    if (!cell) throw new Error('missing cell');
    cell.outputs = [{ output_type: 'error', ename: 'interrupted', evalue: 'interrupted' }];
    fs.writeFileSync(file, `${JSON.stringify(book, null, 2)}\n`);
    const preview = await ports.preview(ctx);
    assert.equal(preview.kind, 'http');
    if (preview.kind !== 'http') return;
    const page = await browser.newPage();
    let dialogs = 0;
    page.on('dialog', () => { dialogs += 1; });
    await page.goto(preview.url);
    const text = await page.locator('body').textContent();
    assert.match(text ?? '', /أعيد تشغيل النواة وستحتاج إعادة تنفيذ الخلايا/);
    assert.match(text ?? '', /print/);
    assert.equal((text ?? '').includes('interrupted:'), false);
    assert.equal(await page.locator('script').count(), 0);
    assert.equal(dialogs, 0);
    const kept = JSON.parse(fs.readFileSync(file, 'utf8')) as { cells: Array<{ source: string[]; outputs: Array<{ ename?: string }> }> };
    assert.deepEqual(kept.cells[0]?.source, source);
    assert.equal(kept.cells[0]?.outputs[0]?.ename, 'interrupted');
    await page.close();
    await ports.stop(ctx);
  } finally {
    await browser.close();
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('editing a notebook cell writes the source and does not run it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notebook-edit-'));
  const ports = createNotebooksPorts({ leases: new ProcessLeaseRegistry(200) });
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: 'job_notebook_edit',
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_bcdfghjkmnps',
      revision: 1,
      selection: { kind: 'notebook' },
      title: 'دفتر',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'b'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
  const browser = await chromium.launch({ headless: true });
  try {
    await ports.scaffold(ctx);
    const file = path.join(root, 'app', 'notebook.ipynb');
    const before = JSON.parse(fs.readFileSync(file, 'utf8')) as { cells: Array<{ id: string; source: unknown; outputs: unknown[] }> };
    const preview = await ports.preview(ctx);
    assert.equal(preview.kind, 'http');
    if (preview.kind !== 'http') return;
    const refused = await fetch(`${preview.url}notebook-cell`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'id=missing&source=print(2)',
    });
    assert.equal(refused.status, 400);
    const unchanged = JSON.parse(fs.readFileSync(file, 'utf8')) as { cells: Array<{ source: unknown }> };
    assert.deepEqual(unchanged.cells[0]?.source, before.cells[0]?.source);
    const page = await browser.newPage();
    let dialogs = 0;
    const leaks: string[] = [];
    page.on('dialog', () => { dialogs += 1; });
    page.on('request', (request) => {
      if (!request.url().startsWith(preview.url)) leaks.push(request.url());
    });
    await page.goto(preview.url);
    const edited = 'print("خميس")\n<script>alert(1)</script>';
    await page.locator('textarea').fill(edited);
    await page.locator('button').click();
    await page.reload();
    assert.equal(await page.locator('textarea').inputValue(), edited);
    assert.equal(await page.locator('#save-note').textContent(), 'حُفظت الخلية في الدفتر. لم تُنفَّذ.');
    assert.equal(await page.locator('script').count(), 0);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { metadata?: Record<string, unknown> };
    raw.metadata = { ...(raw.metadata ?? {}), kernel_id: 'not-a-kernel' };
    const exported = JSON.parse(notebookExportText(JSON.stringify(raw))) as { nbformat: number; metadata: Record<string, unknown>; cells: Array<{ source: unknown }> };
    assert.equal(exported.nbformat, 4);
    assert.equal(exported.cells[0]?.source, edited);
    assert.equal(exported.metadata.kernel_id, undefined);
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as { cells: Array<{ id: string; source: unknown; outputs: unknown[] }> };
    assert.equal(after.cells.length, before.cells.length);
    assert.equal(after.cells[0]?.id, 'cell-1');
    assert.equal(after.cells[0]?.source, edited);
    assert.deepEqual(after.cells[0]?.outputs, before.cells[0]?.outputs);
    assert.equal(dialogs, 0);
    assert.deepEqual(leaks, []);
    await page.close();
    await ports.stop(ctx);
  } finally {
    await browser.close();
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
