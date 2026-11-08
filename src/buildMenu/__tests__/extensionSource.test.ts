import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import type http from 'node:http';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { getAppProject } from '../../appbuilder/projects.js';
import { configureBuildMenu, handleBuildMenuRoutes } from '../../server/routes/buildMenu.js';
import { resetDb } from '../../server/sqliteStore.js';
import { assertLocalExtension, extensionFiles, popupScript } from '../extensions/source.js';
import { assertExtensionManifest, assertMinimalPermissions, approvedExtensionDigest, extensionPermissionDigest, recordApprovedExtension } from '../chrome/permissions.js';
import { chromePreviewSummary } from '../chrome/browser.js';
import { createChromePorts } from '../chrome/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { materialize } from '../materialize.js';
import { BuildMenuError, resetGrants } from '../grants.js';

test('a periodic brief stays outside the extension and adds no background', () => {
  const files = extensionFiles('ملاحظة', 'sync every hour in the background HOSTILE https://example.test');
  assertLocalExtension(files);
  const manifest = JSON.parse(files.find((file) => file.path === 'manifest.json')?.content ?? '{}') as Record<string, unknown>;
  assert.equal(Object.hasOwn(manifest, 'background'), false);
  assert.equal(JSON.stringify(manifest).includes('alarms'), false);
  const popup = files.find((file) => file.path === 'popup.html')?.content ?? '';
  assert.match(popup, /id="excluded"/);
  assert.match(popup, /لا تشغيل دوري ولا شبكة في الخلفية/);
  assert.equal(popup.includes('HOSTILE'), false);
  assert.equal(popup.includes('https://example.test'), false);
  assert.equal(popupScript().includes('alarms'), false);
  const quiet = extensionFiles('ملاحظة', 'احفظ النص المحدد محلياً');
  assert.equal((quiet.find((file) => file.path === 'popup.html')?.content ?? '').includes('id="excluded"'), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-ext-scope-'));
  try {
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'brief.txt'), 'background sync HOSTILE https://example.test\n');
    materialize({ selection: { kind: 'chrome-extension' }, workspace: root, title: 'ملاحظة' });
    const written = fs.readFileSync(path.join(root, 'app', 'popup.html'), 'utf8');
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'app', 'manifest.json'), 'utf8')) as Record<string, unknown>;
    assert.match(written, /id="excluded"/);
    assert.equal(written.includes('HOSTILE'), false);
    assert.equal(Object.hasOwn(saved, 'background'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a second extension generate keeps the edited popup and the approved digest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-ext-keep-'));
  try {
    materialize({ selection: { kind: 'chrome-extension' }, workspace: root, title: 'ملاحظة' });
    const popupPath = path.join(root, 'app', 'popup.html');
    const manifestPath = path.join(root, 'app', 'manifest.json');
    fs.writeFileSync(popupPath, fs.readFileSync(popupPath, 'utf8').replace('<h1>ملاحظة</h1>', '<h1>KEEP-POPUP</h1>'));
    const packed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { permissions: string[] };
    packed.permissions = ['activeTab', 'storage'];
    fs.writeFileSync(manifestPath, `${JSON.stringify(packed)}\n`);
    const approved = approvedExtensionDigest(root);
    fs.writeFileSync(path.join(root, 'app', 'brief.txt'), 'background sync every hour\n');
    const again = materialize({ selection: { kind: 'chrome-extension' }, workspace: root, title: 'عنوان آخر' });
    const popup = fs.readFileSync(popupPath, 'utf8');
    const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { permissions: string[] };
    assert.equal(again.summary, 'chrome-extension');
    assert.match(popup, /KEEP-POPUP/);
    assert.equal(popup.includes('id="excluded"'), false);
    assert.deepEqual(saved.permissions, ['activeTab', 'storage']);
    assert.equal(approvedExtensionDigest(root), approved);
    packed.permissions = ['debugger'];
    fs.writeFileSync(manifestPath, `${JSON.stringify(packed)}\n`);
    assert.throws(() => materialize({ selection: { kind: 'chrome-extension' }, workspace: root, title: 'ملاحظة' }), /permission_requires_review/);
    assert.match(fs.readFileSync(popupPath, 'utf8'), /KEEP-POPUP/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the popup stores selected text and refuses a browser page', async () => {
  const files = extensionFiles('<img src=x onerror=alert(1)>');
  assertLocalExtension(files);
  const manifest = JSON.parse(files.find((file) => file.path === 'manifest.json')?.content ?? '{}') as {
    permissions: string[];
    host_permissions?: string[];
    content_security_policy: { extension_pages: string };
  };
  assertMinimalPermissions(manifest.permissions, manifest.host_permissions ?? []);
  assert.equal(JSON.stringify(manifest).includes('<all_urls>'), false);
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'self'");
  const html = files.find((file) => file.path === 'popup.html')?.content ?? '';
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img/);
  assert.match(html, /id="capture"/);
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /<script src="popup.js"><\/script>/);
  assert.equal(popupScript().includes('innerHTML'), false);
  assert.match(popupScript(), /#capture/);

  const saved = await click(popupScript(), {
    tabs: { query: async () => [{ id: 7, url: 'http://127.0.0.1/fixture' }] },
    scripting: { executeScript: async () => [{ result: '<img src=x onerror=alert(1)>' }] },
    storage: { local: { async set() { return undefined; } } },
  });
  assert.equal(saved.notes['http://127.0.0.1/fixture'], '<img src=x onerror=alert(1)>');
  assert.equal(saved.note, '');
  assert.equal(popupScript().includes('lastNote'), false);
  assert.equal(saved.text, 'حُفظت الملاحظة محلياً.');
  assert.equal(saved.html, '');
  assert.match(popupScript(), /globalThis\.browser \?\? globalThis\.chrome/);

  const viaBrowser = await click(popupScript(), {
    tabs: { query: async () => [{ id: 3, url: 'http://127.0.0.1/fixture' }] },
    scripting: { executeScript: async () => [{ result: 'ملاحظة' }] },
    storage: { local: { async set() { return undefined; } } },
  }, 'browser');
  assert.equal(viaBrowser.notes['http://127.0.0.1/fixture'], 'ملاحظة');
  assert.equal(viaBrowser.note, '');
  assert.equal(viaBrowser.text, 'حُفظت الملاحظة محلياً.');

  const blocked = await click(popupScript(), {
    tabs: { query: async () => [{ id: 7, url: 'chrome://extensions' }] },
    scripting: { executeScript: async () => { throw new Error('should_not_run'); } },
    storage: { local: { async set() { return undefined; } } },
  });
  assert.match(blocked.text, /unsupported_page/);
  assert.equal(blocked.note, '');

  const denied = await click(popupScript(), {
    tabs: { query: async () => [{ id: 7, url: 'https://example.test/page' }] },
    scripting: { executeScript: async () => { throw new Error('script_denied'); } },
    storage: { local: { async set() { return undefined; } } },
  });
  assert.match(denied.text, /script_denied/);
  assert.equal(denied.note, '');
});

test('a note stays on its own page and opens as text', async () => {
  const script = popupScript();
  const kept = await click(script, {
    tabs: { query: async () => [{ id: 7, url: 'http://127.0.0.1/fixture' }] },
    scripting: { executeScript: async () => [{ result: '<b>تحديد</b>' }] },
    storage: { local: { async get() { return { notes: { 'http://127.0.0.1/other': 'صفحة أخرى' } }; }, async set() { return undefined; } } },
  });
  assert.equal(kept.note, '');
  assert.equal(kept.notes['http://127.0.0.1/other'], 'صفحة أخرى');
  assert.equal(kept.notes['http://127.0.0.1/fixture'], '<b>تحديد</b>');
  assert.equal(kept.html, '');
  assert.equal(kept.text, 'حُفظت الملاحظة محلياً.');

  const opened = await click(script, {
    tabs: { query: async () => [{ id: 9, url: 'http://127.0.0.1/other' }] },
    storage: { local: { async get() { return { notes: { 'http://127.0.0.1/other': '<img src=x onerror=alert(1)>' } }; }, async set() { return undefined; } } },
  }, 'chrome', false);
  assert.equal(opened.text, '<img src=x onerror=alert(1)>');
  assert.equal(opened.html, '');

  const unrelated = await click(script, {
    tabs: { query: async () => [{ id: 4, url: 'http://127.0.0.1/fixture' }] },
    storage: { local: { async get() { return { notes: { 'http://127.0.0.1/other': 'صفحة أخرى' } }; }, async set() { return undefined; } } },
  }, 'chrome', false);
  assert.equal(unrelated.text, '');
});

test('hidden extension permissions are refused before a zip is written', async () => {
  const manifest = JSON.parse(extensionFiles('ملاحظة').find((file) => file.path === 'manifest.json')?.content ?? '{}') as Record<string, unknown>;
  assertExtensionManifest(manifest);
  assert.throws(() => assertExtensionManifest({ ...manifest, optional_permissions: ['debugger'] }), /permission_requires_review/);
  assert.throws(() => assertExtensionManifest({ ...manifest, permissions: ['nativeMessaging'] }), /permission_requires_review/);
  assert.throws(() => assertExtensionManifest({ ...manifest, permissions: ['cookies'] }), /permission_requires_review/);
  assert.throws(() => assertExtensionManifest({ ...manifest, permissions: ['webRequest'] }), /permission_requires_review/);
  assert.throws(() => assertExtensionManifest({ ...manifest, optional_host_permissions: ['<all_urls>'] }), /host_requires_review/);
  assert.throws(() => assertExtensionManifest({ ...manifest, content_scripts: [{ matches: ['https://example.test/*'] }] }), /host_requires_review/);
  assert.throws(() => assertExtensionManifest({ ...manifest, externally_connectable: { matches: ['https://example.test/*'] } }), /permission_requires_review/);
  assert.throws(() => assertExtensionManifest({ ...manifest, background: { service_worker: 'bg.js' } }), /permission_requires_review/);
  assert.throws(() => assertExtensionManifest({ ...manifest, devtools_page: 'popup.html' }), /permission_requires_review/);
  assert.throws(() => assertExtensionManifest({ ...manifest, chrome_url_overrides: { newtab: 'popup.html' } }), /permission_requires_review/);
  assert.throws(() => assertExtensionManifest({ ...manifest, declarative_net_request: { rule_resources: [] } }), /permission_requires_review/);
  assert.throws(() => assertExtensionManifest({ ...manifest, content_scripts: [{ js: ['https://example.test/a.js'] }] }), /permission_requires_review/);
  assert.throws(() => assertExtensionManifest({ ...manifest, web_accessible_resources: [{ resources: ['popup.js'], matches: ['<all_urls>'] }] }), /host_requires_review/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-ext-'));
  const ports = createChromePorts({ leases: new ProcessLeaseRegistry(200) });
  const ctx = context(root);
  try {
    await ports.scaffold(ctx);
    const file = path.join(root, 'app', 'manifest.json');
    const packed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    packed.content_scripts = [{ matches: ['<all_urls>'] }];
    fs.writeFileSync(file, `${JSON.stringify(packed)}\n`);
    await assert.rejects(
      ports.export(ctx, 'mv3-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.status === 403 && error.message === 'host_requires_review',
    );
    await assert.rejects(
      ports.export({ ...ctx, operation: { action: 'package', format: 'source-zip' } }, 'source-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.status === 403 && error.message === 'host_requires_review',
    );
    delete packed.content_scripts;
    packed.background = { service_worker: 'bg.js' };
    fs.writeFileSync(file, `${JSON.stringify(packed)}\n`);
    await assert.rejects(
      ports.export(ctx, 'mv3-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.status === 403 && error.message === 'permission_requires_review',
    );
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'artifacts')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an allowed permission edit needs a new grant before export', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-ext-'));
  const ports = createChromePorts({ leases: new ProcessLeaseRegistry(200) });
  const ctx = context(root);
  try {
    await ports.scaffold(ctx);
    const file = path.join(root, 'app', 'manifest.json');
    const packed = JSON.parse(fs.readFileSync(file, 'utf8')) as { permissions: string[] };
    packed.permissions = ['activeTab', 'storage'];
    fs.writeFileSync(file, `${JSON.stringify(packed)}\n`);
    await assert.rejects(
      ports.export(ctx, 'mv3-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.status === 409 && error.message === 'stale_revision',
    );
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'artifacts')), false);
    const approved = recordApprovedExtension(root);
    assert.equal(approved, extensionPermissionDigest(packed));
    const artifact = await ports.export(ctx, 'mv3-zip');
    assert.equal(artifact.bytes > 0, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a package grant approves the edited extension and a forbidden manifest gets no grant', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-ext-grant-'));
  const previousData = process.env.LOAM_DATA_DIR;
  const previousWorkspace = process.env.LOAM_WORKSPACE;
  process.env.LOAM_DATA_DIR = path.join(root, 'data');
  process.env.LOAM_WORKSPACE = path.join(root, 'workspace');
  resetDb();
  resetGrants();
  configureBuildMenu(true);
  const ports = createChromePorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    const created = await post('/api/build-menu/projects', {
      title: 'ملاحظة',
      brief: 'ملاحظة محلية على هذا الجهاز',
      selection: { kind: 'chrome-extension' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const projectId = created.json.projectId as string;
    const project = getAppProject(projectId);
    assert.ok(project);
    materialize({ selection: { kind: 'chrome-extension' }, workspace: project.workspaceDir, title: 'ملاحظة' });
    const file = path.join(project.workspaceDir, 'app', 'manifest.json');
    const packed = JSON.parse(fs.readFileSync(file, 'utf8')) as { permissions: string[] };
    packed.permissions = ['activeTab', 'storage'];
    fs.writeFileSync(file, `${JSON.stringify(packed)}\n`);
    const ctx = context(project.workspaceDir);
    ctx.manifest.projectId = projectId;
    await assert.rejects(ports.export(ctx, 'mv3-zip'), (error: unknown) => error instanceof BuildMenuError && error.status === 409);
    const grant = await post(`/api/build-menu/projects/${projectId}/grants`, {
      expectedRevision: 1,
      planSha256: 'b'.repeat(64),
      operation: { action: 'package', format: 'mv3-zip' },
    });
    assert.equal(grant.status, 200, JSON.stringify(grant.json));
    assert.equal(approvedExtensionDigest(project.workspaceDir), extensionPermissionDigest(packed));
    assert.equal((await ports.export(ctx, 'mv3-zip')).bytes > 0, true);
    packed.permissions = ['debugger'];
    fs.writeFileSync(file, `${JSON.stringify(packed)}\n`);
    const refused = await post(`/api/build-menu/projects/${projectId}/grants`, {
      expectedRevision: 1,
      planSha256: 'c'.repeat(64),
      operation: { action: 'package', format: 'mv3-zip' },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error, 'permission_requires_review');
    assert.equal(approvedExtensionDigest(project.workspaceDir), extensionPermissionDigest({ ...packed, permissions: ['activeTab', 'storage'] }));
  } finally {
    configureBuildMenu(false);
    resetGrants();
    resetDb();
    if (previousData === undefined) delete process.env.LOAM_DATA_DIR;
    else process.env.LOAM_DATA_DIR = previousData;
    if (previousWorkspace === undefined) delete process.env.LOAM_WORKSPACE;
    else process.env.LOAM_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a chrome preview serves its local script and does not read outside the page', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-ext-preview-'));
  const outside = path.join(path.dirname(root), 'outside-script.js');
  fs.writeFileSync(outside, 'OUTSIDE_SCRIPT');
  const ports = createChromePorts({ leases: new ProcessLeaseRegistry(200), chromeExecutable: null });
  const ctx = context(root);
  try {
    await ports.scaffold(ctx);
    const preview = await ports.preview(ctx);
    assert.equal(preview.kind, 'http');
    if (preview.kind !== 'http') return;
    const note = chromePreviewSummary(root, preview.url);
    assert.match(note, /لم تُفتح نافذة Chrome/);
    assert.match(note, /Load unpacked/);
    assert.match(note, /لا تعطّل حماية المتصفح/);
    assert.equal(note.includes('هذه نافذة'), false);
    assert.equal(note.includes(preview.url), false);
    const page = await (await fetch(preview.url)).text();
    assert.match(page, /src="popup\.js"/);
    const script = await fetch(new URL('popup.js', preview.url));
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /javascript/);
    const source = await script.text();
    assert.match(source, /missing_chrome/);
    assert.equal(/https?:\/\//i.test(source), false);
    assert.equal((await (await fetch(new URL('outside-script.js', preview.url))).text()).includes('OUTSIDE_SCRIPT'), false);
    fs.writeFileSync(path.join(root, 'app', 'brief.txt'), 'BRIEF_SECRET');
    const brief = await fetch(new URL('brief.txt', preview.url));
    assert.equal(brief.status, 404);
    assert.equal((await brief.text()).includes('BRIEF_SECRET'), false);
    fs.writeFileSync(path.join(root, 'app', 'evil.js'), 'https://evil.test/a.js');
    const blocked = await fetch(new URL('evil.js', preview.url));
    assert.equal(blocked.status, 400);
    assert.equal((await blocked.text()).includes('evil.test'), false);
    const scriptPath = path.join(root, 'app', 'popup.js');
    fs.rmSync(scriptPath);
    fs.mkdirSync(scriptPath);
    assert.equal((await fetch(new URL('popup.js', preview.url))).status, 404);
    assert.match(fs.readFileSync(path.join(root, 'app', 'popup.html'), 'utf8'), /src="popup\.js"/);
    await ports.stop(ctx);
    await assert.rejects(fetch(preview.url, { signal: AbortSignal.timeout(1_000) }));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE_SCRIPT');
  } finally {
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'chrome-extension' };
  return {
    workspace,
    jobId: 'job_chrome_permissions',
    operation: { action: 'package', format: 'mv3-zip' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_bcdfghjkmnpq',
      revision: 1,
      selection,
      title: 'ملاحظة',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'e'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

function fakeReq(method: string, body: unknown): http.IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as http.IncomingMessage;
  req.method = method;
  req.headers = { origin: 'app://agent', 'x-loam-local-token': 'token-token' };
  req.url = '/';
  return req;
}

async function post(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = { status: 0, body: '', writeHead(code: number) { this.status = code; }, end(text: string) { this.body = text; } };
  await handleBuildMenuRoutes(fakeReq('POST', body), response as unknown as http.ServerResponse, url);
  return { status: response.status, json: JSON.parse(response.body) as Record<string, unknown> };
}

async function click(script: string, chrome: {
  tabs?: unknown;
  scripting?: unknown;
  storage: { local: { get?: (key: string) => Promise<{ notes?: Record<string, string> }>; set: (value: { lastNote?: string; notes?: Record<string, string> }) => Promise<void> } };
}, namespace: 'chrome' | 'browser' = 'chrome', pressButton = true): Promise<{ note: string; notes: Record<string, string>; text: string; html: string }> {
  const saved = { note: '', notes: {} as Record<string, string>, text: '', html: '' };
  const read = chrome.storage.local.get?.bind(chrome.storage.local);
  chrome.storage.local.set = async (value) => {
    saved.note = value.lastNote ?? '';
    saved.notes = value.notes ?? {};
  };
  if (read) chrome.storage.local.get = read;
  let shown = '';
  const result = {
    get textContent() { return shown; },
    set textContent(value: string) { shown = value; saved.text = value; },
    set innerHTML(value: string) { saved.html = value; },
  };
  let press: () => Promise<void> = async () => undefined;
  const document = {
    querySelector(selector: string) {
      if (selector === '#result') return result;
      return { addEventListener(_event: string, listener: () => Promise<void>) { press = listener; } };
    },
  };
  const apiHost: { browser?: unknown; chrome?: unknown; __ready?: Promise<void> } = namespace === 'browser' ? { browser: chrome } : { chrome };
  vm.runInContext(script, vm.createContext({ document, globalThis: apiHost, Error }));
  await apiHost.__ready;
  if (pressButton) await press();
  return saved;
}
