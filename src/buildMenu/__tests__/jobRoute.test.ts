import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { androidEnvironment } from '../../mobile/android/build.js';
import { listSchedules } from '../../server/db.js';
import { getAppProject } from '../../appbuilder/store.js';
import { configureBuildMenu, handleBuildMenuRoutes } from '../../server/routes/buildMenu.js';
import { resetDb } from '../../server/sqliteStore.js';
import { resetGrants } from '../grants.js';
import { appendJobLog, resetJobs } from '../jobs.js';

const planSha256 = 'b'.repeat(64);

function fakeReq(method: string, body?: unknown, origin = 'app://agent'): http.IncomingMessage {
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(raw) as http.IncomingMessage;
  req.method = method;
  req.headers = { origin, 'x-loam-local-token': 'token-token' };
  req.url = '/';
  return req;
}

function fakeRes() {
  return {
    status: 0,
    body: '' as string | Buffer,
    headers: {} as Record<string, string | number>,
    writeHead(code: number, headers?: Record<string, string | number>) {
      this.status = code;
      if (headers) this.headers = headers;
    },
    end(text?: string | Buffer) { this.body = text ?? ''; },
  };
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

function responseText(body: string | Buffer): string {
  return typeof body === 'string' ? body : body.toString('utf8');
}

async function post(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = fakeRes();
  await handleBuildMenuRoutes(fakeReq('POST', body), response as unknown as http.ServerResponse, url);
  return { status: response.status, json: JSON.parse(responseText(response.body)) as Record<string, unknown> };
}

test('notebook and game exports download through the build menu routes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-export-'));
  const previousData = process.env.LOAM_DATA_DIR;
  const previousWorkspace = process.env.LOAM_WORKSPACE;
  process.env.LOAM_DATA_DIR = path.join(root, 'data');
  process.env.LOAM_WORKSPACE = path.join(root, 'workspace');
  resetDb();
  resetJobs();
  resetGrants();
  configureBuildMenu(true);
  try {
    const notebook = await post('/api/build-menu/projects', {
      title: 'دفتر محلي',
      brief: 'دفتر محلي يطبع ناتجاً على هذا الجهاز',
      selection: { kind: 'notebook' },
    });
    assert.equal(notebook.status, 200, JSON.stringify(notebook.json));
    const notebookId = notebook.json.projectId as string;
    const notebookGrant = await post(`/api/build-menu/projects/${notebookId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
    });
    assert.equal((await post(`/api/build-menu/projects/${notebookId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
      grantId: notebookGrant.json.grantId,
      idempotencyKey: 'notebook-generate',
    })).status, 200);
    const packedGrant = await post(`/api/build-menu/projects/${notebookId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'package', format: 'ipynb' },
    });
    const packed = await post(`/api/build-menu/projects/${notebookId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'package', format: 'ipynb' },
      grantId: packedGrant.json.grantId,
      idempotencyKey: 'notebook-ipynb',
    });
    assert.equal(packed.status, 200, JSON.stringify(packed.json));
    const artifactId = packed.json.artifactId as string;
    assert.match(artifactId, /^art_/);
    const download = fakeRes();
    await handleBuildMenuRoutes(fakeReq('GET'), download as unknown as http.ServerResponse, `/api/build-menu/projects/${notebookId}/artifacts/${artifactId}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers['x-content-type-options'], 'nosniff');
    const notebookText = Buffer.isBuffer(download.body) ? download.body.toString('utf8') : download.body;
    assert.match(notebookText, /nbformat/);
    assert.equal(notebookText.includes('shell_port'), false);
    assert.equal(notebookText.includes('connection_file'), false);

    const game = await post('/api/build-menu/projects', {
      title: 'لعبة محلية',
      brief: 'لعبة محلية بهدف قريب على هذا الجهاز',
      selection: { kind: 'game' },
    });
    assert.equal(game.status, 200, JSON.stringify(game.json));
    const gameId = game.json.projectId as string;
    const gameGrant = await post(`/api/build-menu/projects/${gameId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
    });
    assert.equal((await post(`/api/build-menu/projects/${gameId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
      grantId: gameGrant.json.grantId,
      idempotencyKey: 'game-generate',
    })).status, 200);
    const zipGrant = await post(`/api/build-menu/projects/${gameId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'package', format: 'web-zip' },
    });
    const zipped = await post(`/api/build-menu/projects/${gameId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'package', format: 'web-zip' },
      grantId: zipGrant.json.grantId,
      idempotencyKey: 'game-web-zip',
    });
    assert.equal(zipped.status, 200, JSON.stringify(zipped.json));
    const zipDownload = fakeRes();
    await handleBuildMenuRoutes(fakeReq('GET'), zipDownload as unknown as http.ServerResponse, `/api/build-menu/projects/${gameId}/artifacts/${zipped.json.artifactId as string}`);
    assert.equal(zipDownload.status, 200);
    const bytes = Buffer.isBuffer(zipDownload.body) ? zipDownload.body : Buffer.from(zipDownload.body);
    const page = unzip(bytes).get('index.html')?.toString('utf8') ?? '';
    assert.match(page, /<canvas/);
    assert.equal(/https?:\/\//i.test(page), false);
  } finally {
    configureBuildMenu(false);
    resetJobs();
    resetGrants();
    resetDb();
    if (previousData === undefined) delete process.env.LOAM_DATA_DIR;
    else process.env.LOAM_DATA_DIR = previousData;
    if (previousWorkspace === undefined) delete process.env.LOAM_WORKSPACE;
    else process.env.LOAM_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('chrome extension package downloads and safari xcode stays unavailable here', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-ext-'));
  const previousData = process.env.LOAM_DATA_DIR;
  const previousWorkspace = process.env.LOAM_WORKSPACE;
  process.env.LOAM_DATA_DIR = path.join(root, 'data');
  process.env.LOAM_WORKSPACE = path.join(root, 'workspace');
  resetDb();
  resetJobs();
  resetGrants();
  configureBuildMenu(true);
  try {
    const chrome = await post('/api/build-menu/projects', {
      title: 'إضافة محلية',
      brief: 'ملاحظة محلية على الصفحة الحالية',
      selection: { kind: 'chrome-extension' },
    });
    assert.equal(chrome.status, 200, JSON.stringify(chrome.json));
    const chromeId = chrome.json.projectId as string;
    const chromeGrant = await post(`/api/build-menu/projects/${chromeId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
    });
    assert.equal((await post(`/api/build-menu/projects/${chromeId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
      grantId: chromeGrant.json.grantId,
      idempotencyKey: 'chrome-generate',
    })).status, 200);
    const packedGrant = await post(`/api/build-menu/projects/${chromeId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'package', format: 'mv3-zip' },
    });
    const packed = await post(`/api/build-menu/projects/${chromeId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'package', format: 'mv3-zip' },
      grantId: packedGrant.json.grantId,
      idempotencyKey: 'chrome-mv3',
    });
    assert.equal(packed.status, 200, JSON.stringify(packed.json));
    const download = fakeRes();
    await handleBuildMenuRoutes(fakeReq('GET'), download as unknown as http.ServerResponse, `/api/build-menu/projects/${chromeId}/artifacts/${packed.json.artifactId as string}`);
    assert.equal(download.status, 200);
    const bytes = Buffer.isBuffer(download.body) ? download.body : Buffer.from(download.body);
    const manifest = JSON.parse(unzip(bytes).get('manifest.json')?.toString('utf8') ?? '') as { permissions?: string[]; host_permissions?: string[] };
    assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(bytes.includes(Buffer.from('all_urls')), false);

    const safari = await post('/api/build-menu/projects', {
      title: 'سفاري محلي',
      brief: 'ملاحظة محلية لمتصفح سفاري على هذا الجهاز',
      selection: { kind: 'safari-extension' },
    });
    assert.equal(safari.status, 200, JSON.stringify(safari.json));
    const safariId = safari.json.projectId as string;
    const safariGrant = await post(`/api/build-menu/projects/${safariId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
    });
    assert.equal((await post(`/api/build-menu/projects/${safariId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
      grantId: safariGrant.json.grantId,
      idempotencyKey: 'safari-generate',
    })).status, 200);
    const xcodeGrant = await post(`/api/build-menu/projects/${safariId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'package', format: 'xcode-source' },
    });
    const xcode = await post(`/api/build-menu/projects/${safariId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'package', format: 'xcode-source' },
      grantId: xcodeGrant.json.grantId,
      idempotencyKey: 'safari-xcode',
    });
    const expected = process.platform === 'darwin' ? 'missing_requirement' : 'unsupported_platform';
    assert.equal(xcode.status, 400, JSON.stringify(xcode.json));
    assert.equal(xcode.json.code, expected);
    assert.equal(xcode.json.artifactId, undefined);
  } finally {
    configureBuildMenu(false);
    resetJobs();
    resetGrants();
    resetDb();
    if (previousData === undefined) delete process.env.LOAM_DATA_DIR;
    else process.env.LOAM_DATA_DIR = previousData;
    if (previousWorkspace === undefined) delete process.env.LOAM_WORKSPACE;
    else process.env.LOAM_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reading a job returns its log and hides a secret', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-route-'));
  const previousData = process.env.LOAM_DATA_DIR;
  const previousWorkspace = process.env.LOAM_WORKSPACE;
  process.env.LOAM_DATA_DIR = path.join(root, 'data');
  process.env.LOAM_WORKSPACE = path.join(root, 'workspace');
  resetDb();
  resetJobs();
  resetGrants();
  configureBuildMenu(true);
  try {
    const foreign = await post('/api/build-menu/projects/app_bcdfghjkmnpq/jobs', {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'preview', cwd: 'C:\\Windows', pid: 4, url: 'https://example.test' },
      grantId: 'c'.repeat(64),
      idempotencyKey: 'no-foreign-preview',
    });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.json.error, 'invalid_request');
    const created = await post('/api/build-menu/projects', {
      title: 'صفحة محلية',
      brief: 'local landing page',
      selection: { kind: 'website', subtype: 'landing' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const projectId = created.json.projectId as string;
    const grant = await post(`/api/build-menu/projects/${projectId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
    });
    assert.equal(grant.status, 200, JSON.stringify(grant.json));
    const started = await post(`/api/build-menu/projects/${projectId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
      grantId: grant.json.grantId,
      idempotencyKey: 'job-log-route',
    });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const jobId = started.json.jobId as string;
    assert.match(jobId, /^job_[0-9a-f-]{36}$/);

    appendJobLog(jobId, 'api_key=sk-testsecretvalue');
    const read = fakeRes();
    await handleBuildMenuRoutes(fakeReq('GET'), read as unknown as http.ServerResponse, `/api/build-menu/projects/${projectId}/jobs/${jobId}`);
    assert.equal(read.status, 200, responseText(read.body));
    const body = JSON.parse(responseText(read.body)) as { jobId: string; phase: string; log: string[] };
    assert.equal(body.jobId, jobId);
    assert.ok(body.phase === 'running' || body.phase === 'completed');
    assert.equal(body.log.includes('landing'), true);
    assert.equal(body.log.includes('[redacted]'), true);
    assert.equal(responseText(read.body).includes('sk-testsecretvalue'), false);
    assert.equal(responseText(read.body).includes(root), false);

    const missing = fakeRes();
    await handleBuildMenuRoutes(
      fakeReq('GET'),
      missing as unknown as http.ServerResponse,
      `/api/build-menu/projects/${projectId}/jobs/job_00000000-0000-4000-8000-000000000000`,
    );
    assert.equal(missing.status, 404);

    const hostile = fakeRes();
    await handleBuildMenuRoutes(
      fakeReq('GET', undefined, 'https://evil.test'),
      hostile as unknown as http.ServerResponse,
      `/api/build-menu/projects/${projectId}/jobs/${jobId}`,
    );
    assert.equal(hostile.status, 403);
    assert.equal(hostile.body.includes('landing'), false);

    configureBuildMenu(false);
    const disabled = fakeRes();
    await handleBuildMenuRoutes(fakeReq('GET'), disabled as unknown as http.ServerResponse, `/api/build-menu/projects/${projectId}/jobs/${jobId}`);
    assert.equal(disabled.status, 404);
    assert.equal(disabled.body.includes('landing'), false);
    assert.equal(disabled.body.includes('[redacted]'), false);
  } finally {
    configureBuildMenu(false);
    resetJobs();
    resetGrants();
    resetDb();
    if (previousData === undefined) delete process.env.LOAM_DATA_DIR;
    else process.env.LOAM_DATA_DIR = previousData;
    if (previousWorkspace === undefined) delete process.env.LOAM_WORKSPACE;
    else process.env.LOAM_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function filesNamed(dir: string, name: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesNamed(full, name));
    else if (entry.isFile() && entry.name === name) found.push(full);
  }
  return found;
}

test('desktop and widget generate return a page without weakening the window file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-window-'));
  const previousData = process.env.LOAM_DATA_DIR;
  const previousWorkspace = process.env.LOAM_WORKSPACE;
  process.env.LOAM_DATA_DIR = path.join(root, 'data');
  process.env.LOAM_WORKSPACE = path.join(root, 'workspace');
  resetDb();
  resetJobs();
  resetGrants();
  configureBuildMenu(true);
  try {
    for (const kind of ['desktop', 'widget'] as const) {
      const created = await post('/api/build-menu/projects', {
        title: kind === 'widget' ? 'ويدجت' : 'مكتب',
        brief: 'ملاحظة محلية على هذا الجهاز',
        selection: { kind },
      });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      const projectId = created.json.projectId as string;
      const grant = await post(`/api/build-menu/projects/${projectId}/grants`, {
        expectedRevision: 1,
        planSha256,
        operation: { action: 'generate' },
      });
      const started = await post(`/api/build-menu/projects/${projectId}/jobs`, {
        expectedRevision: 1,
        planSha256,
        operation: { action: 'generate' },
        grantId: grant.json.grantId,
        idempotencyKey: `${kind}-generate-page`,
      });
      assert.equal(started.status, 200, JSON.stringify(started.json));
      const preview = String(started.json.previewHtml ?? '');
      assert.match(preview, /لا توجد ملاحظة بعد/);
      assert.equal(preview.includes('src="./preview.js"'), false);
      assert.equal(/https?:\/\//i.test(preview), false);
      if (kind === 'widget') assert.match(preview, /id="countdown"/);
      else assert.equal(preview.includes('id="countdown"'), false);
    }
    const pages = filesNamed(root, 'index.html')
      .filter((file) => file.includes(`${path.sep}dist${path.sep}`))
      .map((file) => fs.readFileSync(file, 'utf8'));
    assert.equal(pages.length, 2);
    for (const page of pages) {
      assert.match(page, /script-src 'self'/);
      assert.match(page, /src="\.\/preview\.js"/);
      assert.equal(page.includes('unsafe-inline'), false);
    }
  } finally {
    configureBuildMenu(false);
    resetJobs();
    resetGrants();
    resetDb();
    if (previousData === undefined) delete process.env.LOAM_DATA_DIR;
    else process.env.LOAM_DATA_DIR = previousData;
    if (previousWorkspace === undefined) delete process.env.LOAM_WORKSPACE;
    else process.env.LOAM_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a website package stays refused until a build folder exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-site-'));
  const previousData = process.env.LOAM_DATA_DIR;
  const previousWorkspace = process.env.LOAM_WORKSPACE;
  process.env.LOAM_DATA_DIR = path.join(root, 'data');
  process.env.LOAM_WORKSPACE = path.join(root, 'workspace');
  resetDb();
  resetJobs();
  resetGrants();
  configureBuildMenu(true);
  try {
    const created = await post('/api/build-menu/projects', {
      title: 'متجر',
      brief: 'متجر محلي على هذا الجهاز',
      selection: { kind: 'website', subtype: 'store' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const projectId = created.json.projectId as string;
    const prepared = await post(`/api/build-menu/projects/${projectId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
    });
    const generated = await post(`/api/build-menu/projects/${projectId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
      grantId: prepared.json.grantId,
      idempotencyKey: 'site-generate',
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.json));
    assert.match(String(generated.json.previewHtml ?? ''), /متجر/);
    const previewPages = filesNamed(root, 'preview.html');
    assert.equal(previewPages.length, 1);
    const previewBytes = fs.readFileSync(previewPages[0]!);
    fs.rmSync(previewPages[0]!);
    const refusedGrant = await post(`/api/build-menu/projects/${projectId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'package', format: 'web-zip' },
    });
    const refused = await post(`/api/build-menu/projects/${projectId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'package', format: 'web-zip' },
      grantId: refusedGrant.json.grantId,
      idempotencyKey: 'site-web-zip-refused',
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.json));
    assert.equal(refused.json.code, 'missing_requirement');
    assert.equal(refused.json.artifactId, undefined);
    assert.equal(filesNamed(root, 'index.html').some((file) => file.includes(`${path.sep}dist${path.sep}`)), false);
    const logs = filesNamed(root, 'build.log').map((file) => fs.readFileSync(file, 'utf8'));
    assert.match(logs[0] ?? '', /لم يبدأ بناء القالب/);
    assert.equal((logs[0] ?? '').includes(root), false);
    fs.writeFileSync(previewPages[0]!, previewBytes);
    const packedGrant = await post(`/api/build-menu/projects/${projectId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'package', format: 'web-zip' },
    });
    const packed = await post(`/api/build-menu/projects/${projectId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'package', format: 'web-zip' },
      grantId: packedGrant.json.grantId,
      idempotencyKey: 'site-web-zip',
    });
    assert.equal(packed.status, 200, JSON.stringify(packed.json));
    const artifactId = packed.json.artifactId as string;
    assert.match(artifactId, /^art_/);
    const download = fakeRes();
    await handleBuildMenuRoutes(fakeReq('GET'), download as unknown as http.ServerResponse, `/api/build-menu/projects/${projectId}/artifacts/${artifactId}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers['x-content-type-options'], 'nosniff');
    const zip = Buffer.isBuffer(download.body) ? download.body : Buffer.from(download.body);
    const files = unzip(zip);
    assert.deepEqual([...files.keys()].sort(), ['index.html', 'page.js']);
    const index = files.get('index.html')?.toString('utf8') ?? '';
    const script = files.get('page.js')?.toString('utf8') ?? '';
    assert.match(index, /src="\.\/page\.js"/);
    assert.match(index, /دفتر/);
    assert.equal(index.includes('<script>'), false);
    assert.equal(/https?:\/\//i.test(index), false);
    assert.equal(/https?:\/\//i.test(script), false);
    assert.match(script, /data-sku/);
  } finally {
    configureBuildMenu(false);
    resetJobs();
    resetGrants();
    resetDb();
    if (previousData === undefined) delete process.env.LOAM_DATA_DIR;
    else process.env.LOAM_DATA_DIR = previousData;
    if (previousWorkspace === undefined) delete process.env.LOAM_WORKSPACE;
    else process.env.LOAM_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a mobile generate returns the simulation and the source archive is not an apk', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-mobile-'));
  const previousData = process.env.LOAM_DATA_DIR;
  const previousWorkspace = process.env.LOAM_WORKSPACE;
  process.env.LOAM_DATA_DIR = path.join(root, 'data');
  process.env.LOAM_WORKSPACE = path.join(root, 'workspace');
  resetDb();
  resetJobs();
  resetGrants();
  configureBuildMenu(true);
  try {
    const created = await post('/api/build-menu/projects', {
      title: 'جوال',
      brief: 'تطبيق جوال محلي على هذا الجهاز',
      selection: { kind: 'mobile' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const projectId = created.json.projectId as string;
    const prepared = await post(`/api/build-menu/projects/${projectId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
    });
    const generated = await post(`/api/build-menu/projects/${projectId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
      grantId: prepared.json.grantId,
      idempotencyKey: 'mobile-generate',
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.json));
    const preview = String(generated.json.previewHtml ?? '');
    assert.match(preview, /محاكاة الويب — ليست محاكياً أصلياً/);
    assert.match(preview, /جوال/);
    assert.equal(preview.includes('classes.dex'), false);
    const packedGrant = await post(`/api/build-menu/projects/${projectId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'package', format: 'source-zip' },
    });
    const packed = await post(`/api/build-menu/projects/${projectId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'package', format: 'source-zip' },
      grantId: packedGrant.json.grantId,
      idempotencyKey: 'mobile-source',
    });
    assert.equal(packed.status, 200, JSON.stringify(packed.json));
    const artifactId = packed.json.artifactId as string;
    const download = fakeRes();
    await handleBuildMenuRoutes(fakeReq('GET'), download as unknown as http.ServerResponse, `/api/build-menu/projects/${projectId}/artifacts/${artifactId}`);
    assert.equal(download.status, 200);
    const zip = Buffer.isBuffer(download.body) ? download.body : Buffer.from(download.body);
    const names = [...unzip(zip).keys()];
    assert.equal(names.some((name) => name.endsWith('.apk') || name.endsWith('classes.dex')), false);
    assert.equal(names.includes('mobile.json'), true);
    if (!androidEnvironment().ready) {
      const apkGrant = await post(`/api/build-menu/projects/${projectId}/grants`, {
        expectedRevision: 1,
        planSha256,
        operation: { action: 'package', format: 'apk-debug' },
      });
      const apk = await post(`/api/build-menu/projects/${projectId}/jobs`, {
        expectedRevision: 1,
        planSha256,
        operation: { action: 'package', format: 'apk-debug' },
        grantId: apkGrant.json.grantId,
        idempotencyKey: 'mobile-apk',
      });
      assert.equal(apk.status, 400, JSON.stringify(apk.json));
      assert.equal(apk.json.code, 'missing_requirement');
      assert.equal(apk.json.artifactId, undefined);
    }
  } finally {
    configureBuildMenu(false);
    resetJobs();
    resetGrants();
    resetDb();
    if (previousData === undefined) delete process.env.LOAM_DATA_DIR;
    else process.env.LOAM_DATA_DIR = previousData;
    if (previousWorkspace === undefined) delete process.env.LOAM_WORKSPACE;
    else process.env.LOAM_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an automation preview through the menu stays local and does not send', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-auto-'));
  const previousData = process.env.LOAM_DATA_DIR;
  const previousWorkspace = process.env.LOAM_WORKSPACE;
  process.env.LOAM_DATA_DIR = path.join(root, 'data');
  process.env.LOAM_WORKSPACE = path.join(root, 'workspace');
  resetDb();
  resetJobs();
  resetGrants();
  configureBuildMenu(true);
  try {
    assert.equal(listSchedules().length, 0);
    const created = await post('/api/build-menu/projects', {
      title: 'تقرير',
      brief: 'تقرير محلي كل أسبوع على هذا الجهاز',
      selection: { kind: 'automation' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const projectId = created.json.projectId as string;
    const prepared = await post(`/api/build-menu/projects/${projectId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
    });
    const generated = await post(`/api/build-menu/projects/${projectId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
      grantId: prepared.json.grantId,
      idempotencyKey: 'auto-generate',
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.json));
    for (const key of ['auto-preview-1', 'auto-preview-2']) {
      const grant = await post(`/api/build-menu/projects/${projectId}/grants`, {
        expectedRevision: 1,
        planSha256,
        operation: { action: 'preview' },
      });
      const preview = await post(`/api/build-menu/projects/${projectId}/jobs`, {
        expectedRevision: 1,
        planSha256,
        operation: { action: 'preview' },
        grantId: grant.json.grantId,
        idempotencyKey: key,
      });
      assert.equal(preview.status, 200, JSON.stringify(preview.json));
      const page = String(preview.json.previewHtml ?? '');
      assert.match(page, /09:00 Asia\/Qatar/);
      assert.match(page, /تقرير محلي/);
      assert.equal(page.includes('<script'), false);
      assert.equal(/https?:\/\//i.test(page), false);
      assert.equal(listSchedules().length, 0);
    }
    const specs = filesNamed(root, 'automation.json').map((file) => JSON.parse(fs.readFileSync(file, 'utf8')) as { scheduleId?: string; enabled?: boolean; send?: boolean });
    assert.equal(specs.length, 1);
    assert.match(specs[0]?.scheduleId ?? '', /^local_[a-f0-9]{12}$/);
    assert.equal(specs[0]?.enabled, false);
    assert.equal(specs[0]?.send, false);
  } finally {
    configureBuildMenu(false);
    resetJobs();
    resetGrants();
    resetDb();
    if (previousData === undefined) delete process.env.LOAM_DATA_DIR;
    else process.env.LOAM_DATA_DIR = previousData;
    if (previousWorkspace === undefined) delete process.env.LOAM_WORKSPACE;
    else process.env.LOAM_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('game and notebook previews open on this computer and then stop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-live-'));
  const previousData = process.env.LOAM_DATA_DIR;
  const previousWorkspace = process.env.LOAM_WORKSPACE;
  process.env.LOAM_DATA_DIR = path.join(root, 'data');
  process.env.LOAM_WORKSPACE = path.join(root, 'workspace');
  resetDb();
  resetJobs();
  resetGrants();
  configureBuildMenu(true);
  const open: { projectId: string; jobId: string; url: string }[] = [];
  try {
    const kinds = [
      { kind: 'game' as const, title: 'لعبة', brief: 'لعبة محلية بهدف قريب على هذا الجهاز', marker: /<canvas/ },
      { kind: 'notebook' as const, title: 'دفتر', brief: 'دفتر محلي يطبع ناتجاً على هذا الجهاز', marker: /nbformat/ },
    ];
    for (const item of kinds) {
      const created = await post('/api/build-menu/projects', {
        title: item.title,
        brief: item.brief,
        selection: { kind: item.kind },
      });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      const projectId = created.json.projectId as string;
      const prepared = await post(`/api/build-menu/projects/${projectId}/grants`, {
        expectedRevision: 1,
        planSha256,
        operation: { action: 'generate' },
      });
      assert.equal((await post(`/api/build-menu/projects/${projectId}/jobs`, {
        expectedRevision: 1,
        planSha256,
        operation: { action: 'generate' },
        grantId: prepared.json.grantId,
        idempotencyKey: `${item.kind}-generate-live`,
      })).status, 200);
      const grant = await post(`/api/build-menu/projects/${projectId}/grants`, {
        expectedRevision: 1,
        planSha256,
        operation: { action: 'preview' },
      });
      const preview = await post(`/api/build-menu/projects/${projectId}/jobs`, {
        expectedRevision: 1,
        planSha256,
        operation: { action: 'preview' },
        grantId: grant.json.grantId,
        idempotencyKey: `${item.kind}-preview-live`,
      });
      assert.equal(preview.status, 200, JSON.stringify(preview.json));
      const url = String(preview.json.previewUrl ?? '');
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      open.push({ projectId, jobId: String(preview.json.jobId), url });
      const body = await (await fetch(url)).text();
      assert.match(body, item.marker);
      assert.equal(/https?:\/\//i.test(body), false);
      const stopped = await post(`/api/build-menu/projects/${projectId}/jobs/${String(preview.json.jobId)}/cancel`, {});
      assert.equal(stopped.status, 200, JSON.stringify(stopped.json));
      await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1_000) }));
    }
  } finally {
    for (const item of open) {
      await post(`/api/build-menu/projects/${item.projectId}/jobs/${item.jobId}/cancel`, {}).catch(() => undefined);
    }
    configureBuildMenu(false);
    resetJobs();
    resetGrants();
    resetDb();
    if (previousData === undefined) delete process.env.LOAM_DATA_DIR;
    else process.env.LOAM_DATA_DIR = previousData;
    if (previousWorkspace === undefined) delete process.env.LOAM_WORKSPACE;
    else process.env.LOAM_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a kernel grant refuses a cell edited after approval and does not run it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-job-cell-'));
  const previousData = process.env.LOAM_DATA_DIR;
  const previousWorkspace = process.env.LOAM_WORKSPACE;
  process.env.LOAM_DATA_DIR = path.join(root, 'data');
  process.env.LOAM_WORKSPACE = path.join(root, 'workspace');
  resetDb();
  resetJobs();
  resetGrants();
  configureBuildMenu(true);
  try {
    const created = await post('/api/build-menu/projects', {
      title: 'دفتر محلي',
      brief: 'دفتر محلي يطبع ناتجاً على هذا الجهاز',
      selection: { kind: 'notebook' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const projectId = created.json.projectId as string;
    const generated = await post(`/api/build-menu/projects/${projectId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
    });
    assert.equal((await post(`/api/build-menu/projects/${projectId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
      grantId: generated.json.grantId,
      idempotencyKey: 'cell-generate',
    })).status, 200);
    const approved = await post(`/api/build-menu/projects/${projectId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'kernel-execute', cellId: 'cell-1' },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    const project = getAppProject(projectId);
    assert.ok(project);
    const file = path.join(project.workspaceDir, 'app', 'notebook.ipynb');
    const notebook = JSON.parse(fs.readFileSync(file, 'utf8')) as { cells: { id: string; source: string[]; outputs: unknown[] }[] };
    assert.equal(notebook.cells[0]?.source.join(''), 'print("loam")\n');
    notebook.cells[0]!.source = ['print("edited")\n'];
    fs.writeFileSync(file, JSON.stringify(notebook));
    const body = {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'kernel-execute', cellId: 'cell-1' },
      grantId: approved.json.grantId,
      idempotencyKey: 'cell-run',
    };
    const refused = await post(`/api/build-menu/projects/${projectId}/jobs`, body);
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.equal(refused.json.message, 'stale_revision');
    const again = await post(`/api/build-menu/projects/${projectId}/jobs`, { ...body, idempotencyKey: 'cell-run-again' });
    assert.equal(again.status, 409, JSON.stringify(again.json));
    assert.equal(again.json.message, 'stale_revision');
    const kept = JSON.parse(fs.readFileSync(file, 'utf8')) as { cells: { source: string[]; outputs: unknown[] }[] };
    assert.equal(kept.cells[0]?.source.join(''), 'print("edited")\n');
    assert.equal(kept.cells[0]?.outputs.length, 0);
  } finally {
    configureBuildMenu(false);
    resetJobs();
    resetGrants();
    resetDb();
    if (previousData === undefined) delete process.env.LOAM_DATA_DIR;
    else process.env.LOAM_DATA_DIR = previousData;
    if (previousWorkspace === undefined) delete process.env.LOAM_WORKSPACE;
    else process.env.LOAM_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
