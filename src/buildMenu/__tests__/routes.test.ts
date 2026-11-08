import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type http from 'node:http';
import { getAppProject } from '../../appbuilder/projects.js';
import { database, resetDb } from '../../server/sqliteStore.js';
import { configureBuildMenu, handleBuildMenuRoutes } from '../../server/routes/buildMenu.js';
import { readManifest } from '../manifest.js';

function fakeReq(method: string, headers: http.IncomingHttpHeaders, body?: unknown): http.IncomingMessage {
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(raw) as http.IncomingMessage;
  req.method = method;
  req.headers = headers;
  return req;
}

function fakeRes() {
  return {
    status: 0,
    body: '',
    writeHead(code: number) { this.status = code; },
    end(text: string) { this.body = text; },
  };
}

function pinOf(bytes: Buffer): { revision: string; lockSha256: string } {
  const revision = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
  return { revision, lockSha256: createHash('sha256').update(bytes).digest('hex') };
}

test('capabilities stay off and closed routes reject a missing session or foreign origin', async () => {
  configureBuildMenu(false);
  const capabilities = fakeRes();
  await handleBuildMenuRoutes(fakeReq('GET', {}), capabilities as unknown as http.ServerResponse, '/api/build-menu/capabilities');
  const body = JSON.parse(capabilities.body) as {
    enabled: boolean;
    safariExport: string;
    safariTested: boolean;
    portableExe: { built: boolean; signed: boolean };
    chrome: { extensionLoaded: boolean; browserTestRan: boolean };
    notebookImage: { status: string; digest: string | null };
  };
  assert.equal(body.enabled, false);
  assert.equal(body.safariExport, 'source-complete');
  assert.equal(body.safariTested, false);
  assert.equal(body.portableExe.built, false);
  assert.equal(body.portableExe.signed, false);
  assert.equal(body.chrome.extensionLoaded, false);
  assert.equal(body.chrome.browserTestRan, false);
  assert.equal(body.notebookImage.status, 'unresolved');
  assert.equal(body.notebookImage.digest, null);

  const missing = fakeRes();
  await handleBuildMenuRoutes(fakeReq('POST', { origin: 'app://agent' }), missing as unknown as http.ServerResponse, '/api/build-menu/projects');
  assert.equal(missing.status, 403);

  const hostile = fakeRes();
  await handleBuildMenuRoutes(
    fakeReq('POST', { origin: 'https://evil.example', 'x-loam-local-token': 'token-token' }),
    hostile as unknown as http.ServerResponse,
    '/api/build-menu/projects',
  );
  assert.equal(hostile.status, 403);

  const unsigned = fakeRes();
  await handleBuildMenuRoutes(
    fakeReq('POST', { origin: 'app://agent' }),
    unsigned as unknown as http.ServerResponse,
    '/api/build-menu/projects/app_bcdfghjkmnpq/routines/activate',
  );
  assert.equal(unsigned.status, 403);
});

test('a guessed artifact location is a bad request', async () => {
  configureBuildMenu(true);
  const req = fakeReq('GET', { origin: 'app://agent', 'x-loam-local-token': 'token-token' });
  req.url = '/api/build-menu/projects/app_abcdefghijkl/artifacts/../secret?path=outside';
  const res = fakeRes();
  await handleBuildMenuRoutes(
    req,
    res as unknown as http.ServerResponse,
    '/api/build-menu/projects/app_abcdefghijkl/artifacts/../secret',
  );
  assert.equal(res.status, 400);
  configureBuildMenu(false);
});

test('publish has no API and does not open a project', async () => {
  configureBuildMenu(true);
  try {
    for (const path of ['/api/build-menu/publish', '/api/build-menu/projects/app_bcdfghjkmnpq/publish']) {
      const res = fakeRes();
      const handled = await handleBuildMenuRoutes(
        fakeReq('POST', { origin: 'app://agent', 'x-loam-local-token': 'token-token' }),
        res as unknown as http.ServerResponse,
        path,
      );
      assert.equal(handled, true);
      assert.equal(res.status, 404);
      assert.match(res.body, /local handoff only/);
    }
  } finally {
    configureBuildMenu(false);
  }
});

test('a project body over 64KB is refused before a project is created', async () => {
  configureBuildMenu(true);
  try {
    const oversized = Readable.from([Buffer.alloc(64 * 1024 + 1, 0x61)]) as http.IncomingMessage;
    oversized.method = 'POST';
    oversized.headers = { origin: 'app://agent', 'x-loam-local-token': 'token-token' };
    const res = fakeRes();
    const handled = await handleBuildMenuRoutes(oversized, res as unknown as http.ServerResponse, '/api/build-menu/projects');
    assert.equal(handled, true);
    assert.equal(res.status, 400);
    assert.match(res.body, /invalid_request/);
    assert.equal(oversized.destroyed, true);

    const exact = Readable.from([Buffer.alloc(64 * 1024, 0x61)]) as http.IncomingMessage;
    exact.method = 'POST';
    exact.headers = { origin: 'app://agent', 'x-loam-local-token': 'token-token' };
    const exactRes = fakeRes();
    await handleBuildMenuRoutes(exact, exactRes as unknown as http.ServerResponse, '/api/build-menu/projects');
    assert.equal(exactRes.status, 400);
    const exactBody = JSON.parse(exactRes.body) as { error: string };
    assert.notEqual(exactBody.error, 'invalid_request');
  } finally {
    configureBuildMenu(false);
  }
});

test('a model plan is refused before a project is opened', async () => {
  configureBuildMenu(true);
  try {
    const res = fakeRes();
    const handled = await handleBuildMenuRoutes(
      fakeReq('POST', { origin: 'app://agent', 'x-loam-local-token': 'token-token' }),
      res as unknown as http.ServerResponse,
      '/api/build-menu/projects/app_bcdfghjkmnpq/plan',
    );
    assert.equal(handled, true);
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body) as { error: string; message: string };
    assert.equal(body.error, 'missing_requirement');
    assert.equal(body.message, 'generation needs a model provider');
  } finally {
    configureBuildMenu(false);
  }
});

test('a created project pins a real file digest and not the selection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-template-pin-'));
  const previousData = process.env.LOAM_DATA_DIR;
  const previousWorkspace = process.env.LOAM_WORKSPACE;
  process.env.LOAM_DATA_DIR = path.join(root, 'data');
  process.env.LOAM_WORKSPACE = path.join(root, 'workspace');
  resetDb();
  configureBuildMenu(true);
  const websitePin = pinOf(fs.readFileSync(fileURLToPath(new URL('../../../templates/web-app/package.json', import.meta.url))));
  const emptyPin = pinOf(Buffer.alloc(0));
  try {
    const landing = { kind: 'website' as const, subtype: 'landing' as const };
    const store = { kind: 'website' as const, subtype: 'store' as const };
    const invented = createHash('sha256').update(JSON.stringify(landing)).digest('hex');
    const headers = { origin: 'app://agent', 'x-loam-local-token': 'token-token' };
    for (const selection of [landing, store]) {
      const res = fakeRes();
      await handleBuildMenuRoutes(
        fakeReq('POST', headers, { title: 'موقع تجريبي', brief: 'صفحة هبوط محلية على هذا الجهاز', selection }),
        res as unknown as http.ServerResponse,
        '/api/build-menu/projects',
      );
      assert.equal(res.status, 200, res.body);
      const projectId = JSON.parse(res.body).projectId as string;
      const project = getAppProject(projectId);
      assert.ok(project);
      const manifest = readManifest(project.workspaceDir);
      assert.ok(manifest);
      assert.equal(manifest.template.revision, websitePin.revision);
      assert.equal(manifest.template.lockSha256, websitePin.lockSha256);
      assert.notEqual(manifest.template.revision, 'latest');
      assert.notEqual(manifest.template.revision, '1');
      assert.notEqual(manifest.template.lockSha256, invented);
      assert.equal(res.body.includes(project.workspaceDir), false);
    }

    const desktopRes = fakeRes();
    const desktopSelection = { kind: 'desktop' as const };
    await handleBuildMenuRoutes(
      fakeReq('POST', headers, { title: 'سطح المكتب', brief: 'تطبيق سطح مكتب محلي', selection: desktopSelection }),
      desktopRes as unknown as http.ServerResponse,
      '/api/build-menu/projects',
    );
    assert.equal(desktopRes.status, 200, desktopRes.body);
    const desktop = getAppProject(JSON.parse(desktopRes.body).projectId as string);
    assert.ok(desktop);
    const desktopManifest = readManifest(desktop.workspaceDir);
    const desktopPin = pinOf(fs.readFileSync(path.join(desktop.workspaceDir, 'app', 'package.json')));
    assert.equal(desktopManifest?.template.lockSha256, desktopPin.lockSha256);
    assert.equal(desktopManifest?.template.revision, desktopPin.revision);
    assert.notEqual(desktopManifest?.template.lockSha256, createHash('sha256').update(JSON.stringify(desktopSelection)).digest('hex'));

    const automationRes = fakeRes();
    const automationSelection = { kind: 'automation' as const };
    await handleBuildMenuRoutes(
      fakeReq('POST', headers, { title: 'روتين محلي', brief: 'روتين محلي على هذا الجهاز', selection: automationSelection }),
      automationRes as unknown as http.ServerResponse,
      '/api/build-menu/projects',
    );
    assert.equal(automationRes.status, 200, automationRes.body);
    const automation = getAppProject(JSON.parse(automationRes.body).projectId as string);
    assert.ok(automation);
    const automationManifest = readManifest(automation.workspaceDir);
    assert.equal(automationManifest?.template.lockSha256, emptyPin.lockSha256);
    assert.equal(automationManifest?.template.revision, emptyPin.revision);
    assert.notEqual(automationManifest?.template.lockSha256, createHash('sha256').update(JSON.stringify(automationSelection)).digest('hex'));
    assert.equal(fs.existsSync(path.join(automation.workspaceDir, 'app', 'package-lock.json')), false);
  } finally {
    configureBuildMenu(false);
    resetDb();
    if (previousData === undefined) delete process.env.LOAM_DATA_DIR;
    else process.env.LOAM_DATA_DIR = previousData;
    if (previousWorkspace === undefined) delete process.env.LOAM_WORKSPACE;
    else process.env.LOAM_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a brief of nine characters is refused and creates no project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-brief-'));
  const previousData = process.env.LOAM_DATA_DIR;
  const previousWorkspace = process.env.LOAM_WORKSPACE;
  process.env.LOAM_DATA_DIR = path.join(root, 'data');
  process.env.LOAM_WORKSPACE = path.join(root, 'workspace');
  resetDb();
  configureBuildMenu(true);
  try {
    const brief = '123456789';
    assert.equal(brief.length, 9);
    const res = fakeRes();
    const handled = await handleBuildMenuRoutes(
      fakeReq('POST', { origin: 'app://agent', 'x-loam-local-token': 'token-token' }, {
        title: 'مختصر',
        brief,
        selection: { kind: 'website', subtype: 'landing' },
      }),
      res as unknown as http.ServerResponse,
      '/api/build-menu/projects',
    );
    assert.equal(handled, true);
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body) as { error: string };
    assert.equal(body.error, 'invalid_request');
    const table = database().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_projects'").get() as { name: string } | undefined;
    const count = table
      ? (database().prepare('SELECT COUNT(*) AS n FROM app_projects').get() as { n: number }).n
      : 0;
    assert.equal(count, 0);
  } finally {
    configureBuildMenu(false);
    resetDb();
    if (previousData === undefined) delete process.env.LOAM_DATA_DIR;
    else process.env.LOAM_DATA_DIR = previousData;
    if (previousWorkspace === undefined) delete process.env.LOAM_WORKSPACE;
    else process.env.LOAM_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
