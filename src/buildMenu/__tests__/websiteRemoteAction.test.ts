import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { unsafeWebsitePreview } from '../websites/bundle.js';
import { configureWebsiteLock } from '../websites/hostCommand.js';
import { materialize } from '../materialize.js';
import { writeStoredBrief } from '../planProvenance.js';
import { websiteDocument } from '../websites/page.js';
import { createWebsitesPorts } from '../websites/ports.js';

const OUTSIDE = [
  '<form action="https&#58;//pay.example/checkout" method="post"></form>',
  '<form action="&#47;&#47;pay.example/checkout"></form>',
  '<form method="post" action="/checkout"></form>',
  '<form action="\\\\pay.example/checkout" method="post"></form>',
  '<form method="post"></form>',
  '<a href="/checkout">ادفع</a>',
  '<button type="submit" formaction="//pay.example/checkout">ادفع</button>',
];

test('a website archive rejects a form or link that leaves the local page and keeps the previous zip', async () => {
  configureWebsiteLock(null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-web-action-'));
  const ports = createWebsitesPorts({ leases: new ProcessLeaseRegistry(200) });
  const ctx = context(root);
  try {
    const landing = websiteDocument('هبوط', 'landing');
    const chat = websiteDocument('دردشة', 'chatbot');
    assert.match(landing, /<form\b/);
    assert.match(chat, /<form\b/);
    assert.match(websiteDocument('متجر', 'store'), /سلة محلية/);
    assert.match(websiteDocument('حجز', 'booking'), /محلي فقط/);
    for (const subtype of ['landing', 'store', 'booking', 'chatbot'] as const) {
      assert.equal(unsafeWebsitePreview(websiteDocument('متجر', subtype)), false);
    }
    assert.equal(unsafeWebsitePreview(landing), false);
    assert.equal(unsafeWebsitePreview(chat), false);
    for (const attack of OUTSIDE) assert.equal(unsafeWebsitePreview(attack), true);

    await ports.scaffold(ctx);
    const artifact = await ports.export(ctx, 'web-zip');
    const zipPath = path.join(root, artifact.relativePath);
    const bytes = fs.readFileSync(zipPath);
    const indexPath = path.join(root, 'app', 'dist', 'index.html');
    const page = fs.readFileSync(indexPath, 'utf8');
    assert.equal(page.includes('action='), false);
    for (const attack of OUTSIDE) {
      fs.writeFileSync(indexPath, page + attack);
      await assert.rejects(
        ports.export(ctx, 'web-zip'),
        (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
      );
      assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
    }
    fs.rmSync(path.join(root, 'app', 'dist'), { recursive: true, force: true });
    fs.appendFileSync(path.join(root, 'app', 'preview.html'), '<form method="post" action="/checkout"></form>');
    await assert.rejects(
      ports.export(ctx, 'web-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.existsSync(indexPath), false);
    assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
  } finally {
    configureWebsiteLock(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a generated website page rejects a javascript url, a protocol-relative src, and data, file, and blob urls', () => {
  const localUrls = [
    ' src="data:text/html,hi"',
    " href='file:///c:/secret'",
    ' action="blob:null/uuid"',
    '>src="data:text/html,hi"',
    ".href='file:///c:/secret'",
    ' action=blob:null/uuid',
    ' src=file:///c:/secret',
    '.action=data:text/plain,hi',
  ];
  for (const subtype of ['landing', 'store', 'booking', 'chatbot'] as const) {
    const html = websiteDocument('صفحة', subtype);
    assert.match(html, /<!doctype html>/);
    assert.equal(/https?:\/\//i.test(html), false);
    assert.equal(/javascript\s*:/i.test(html), false);
    assert.equal(/(?:^|[\s.>])src\s*=\s*(?:["']\s*)?\/\//i.test(html), false);
    assert.equal(/(?:^|[\s.>]|&gt;)(?:src|href|action)\s*=\s*(?:(?:["']|&quot;)\s*)?(?:data|file|blob):/i.test(html), false);
    const stayed = websiteDocument('data: file: blob:', subtype);
    assert.match(stayed, /<title>data: file: blob:<\/title>/);
    for (const title of ['https://evil.example', 'javascript:alert(1)', 'javascript :alert(1)', ' src=//evil.example/a.js', ".src='//evil.example/a.js'", ...localUrls]) {
      assert.throws(
        () => websiteDocument(title, subtype),
        (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
      );
    }
  }
  assert.equal(savedRecover(websiteDocument('متجر', 'store'), 'loam-store'), 'تعذرت قراءة السلة المحفوظة؛ بدأت سلة فارغة');
  assert.equal(savedRecover(websiteDocument('حجز', 'booking'), 'loam-booking'), 'تعذرت قراءة الحجوزات المحفوظة؛ بدأت قائمة فارغة');
  assert.equal(savedRecover(websiteDocument('دردشة', 'chatbot'), 'loam-chat'), 'تعذرت قراءة المحادثة المحفوظة؛ بدأت محادثة فارغة');
});

test('a local brief is shown as text and a remote brief is not copied into the page', () => {
  const shown = websiteDocument('هبوط', 'landing', 'صفحة هبوط للدفتر المحلي');
  assert.match(shown, /<pre id="brief">صفحة هبوط للدفتر المحلي<\/pre>/);
  assert.equal(shown.includes('<script src='), false);
  const hidden = websiteDocument('هبوط', 'landing', 'انظر https://example.test ثم ارجع');
  assert.equal(hidden.includes('https://'), false);
  assert.match(hidden, /لم يُعرض في الصفحة/);
  const attack = websiteDocument('هبوط', 'store', '<img src=x onerror=alert(1)>');
  assert.equal(attack.includes('<img'), false);
  assert.match(attack, /&lt;img/);
});

test('materialize copies a stored local brief into the website page', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-site-brief-'));
  try {
    writeStoredBrief(root, 'صفحة هبوط للدفتر المحلي');
    materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace: root, title: 'هبوط' });
    const html = fs.readFileSync(path.join(root, 'app', 'preview.html'), 'utf8');
    assert.match(html, /<pre id="brief">صفحة هبوط للدفتر المحلي<\/pre>/);
    assert.equal(html.includes('https://'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function savedRecover(html: string, key: string): string {
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
  const storage = new Map<string, string>([[key, '{bad']]);
  const nodes = new Map<string, { textContent: string }>();
  const node = (id: string) => {
    const found = nodes.get(id);
    if (found) return found;
    const created = { textContent: '' };
    nodes.set(id, created);
    return created;
  };
  const document = {
    getElementById: (id: string) => node(id),
    querySelectorAll: () => [],
    querySelector: (selector: string) => {
      if (selector === 'form') return { set onsubmit(_value: unknown) { } };
      return { value: '' };
    },
  };
  const localStorage = {
    getItem: (itemKey: string) => storage.get(itemKey) ?? null,
    setItem: (itemKey: string, value: string) => { storage.set(itemKey, value); },
    removeItem: (itemKey: string) => { storage.delete(itemKey); },
  };
  vm.runInContext(script, vm.createContext({ document, localStorage, JSON, Object, Number }));
  return node('out').textContent;
}

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'website', subtype: 'store' };
  return {
    workspace,
    jobId: 'job_website_action',
    operation: { action: 'package', format: 'web-zip' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_bcdfghjkmnpq',
      revision: 3,
      selection,
      title: 'متجر',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'e'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}
