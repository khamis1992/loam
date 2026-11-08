import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { getAppProject } from '../../appbuilder/projects.js';
import { configureBuildMenu, handleBuildMenuRoutes } from '../../server/routes/buildMenu.js';
import { resetDb } from '../../server/sqliteStore.js';

const headers = { origin: 'app://agent', 'x-loam-local-token': 'token-token' };

function fakeReq(method: string, body?: unknown): http.IncomingMessage {
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(raw) as http.IncomingMessage;
  req.method = method;
  req.headers = headers;
  req.url = '/';
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

test('reading a project returns its kind and hides the workspace path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-project-read-'));
  const previousData = process.env.LOAM_DATA_DIR;
  const previousWorkspace = process.env.LOAM_WORKSPACE;
  process.env.LOAM_DATA_DIR = path.join(root, 'data');
  process.env.LOAM_WORKSPACE = path.join(root, 'workspace');
  resetDb();
  configureBuildMenu(true);
  try {
    const created = fakeRes();
    await handleBuildMenuRoutes(fakeReq('POST', {
      title: 'C:\\Users\\khamis\\secret',
      brief: 'صفحة هبوط محلية على هذا الجهاز',
      selection: { kind: 'website', subtype: 'landing' },
    }), created as unknown as http.ServerResponse, '/api/build-menu/projects');
    assert.equal(created.status, 200, created.body);
    const projectId = JSON.parse(created.body).projectId as string;
    const project = getAppProject(projectId);
    assert.ok(project);

    const read = fakeRes();
    await handleBuildMenuRoutes(fakeReq('GET'), read as unknown as http.ServerResponse, `/api/build-menu/projects/${projectId}`);
    assert.equal(read.status, 200, read.body);
    const body = JSON.parse(read.body) as {
      projectId: string;
      revision: number;
      engine: string;
      title: string;
      capabilities: { preview: string; exports: string[]; safariTested: boolean };
    };
    assert.equal(body.projectId, projectId);
    assert.equal(body.revision, 1);
    assert.equal(body.engine, 'loam-build');
    assert.equal(body.title, '[path]');
    assert.equal(body.capabilities.preview, 'web');
    assert.deepEqual(body.capabilities.exports, ['source-zip', 'web-zip']);
    assert.equal(body.capabilities.safariTested, false);
    assert.equal(read.body.includes(project.workspaceDir), false);
    assert.equal(read.body.includes('secret'), false);

    const missing = fakeRes();
    await handleBuildMenuRoutes(fakeReq('GET'), missing as unknown as http.ServerResponse, '/api/build-menu/projects/app_bcdfghjkmnpq');
    assert.equal(missing.status, 404);

    configureBuildMenu(false);
    const disabled = fakeRes();
    await handleBuildMenuRoutes(fakeReq('GET'), disabled as unknown as http.ServerResponse, `/api/build-menu/projects/${projectId}`);
    assert.equal(disabled.status, 404);
    assert.match(disabled.body, /build menu disabled/);
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
