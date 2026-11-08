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
import { recordPreview } from '../automations/run.js';
import { configureOpenRoutines } from '../automations/open.js';

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

test('activation is explicit, refused before three previews, and disable removes the open pointer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-routine-route-'));
  const previousData = process.env.LOAM_DATA_DIR;
  const previousWorkspace = process.env.LOAM_WORKSPACE;
  process.env.LOAM_DATA_DIR = path.join(root, 'data');
  process.env.LOAM_WORKSPACE = path.join(root, 'workspace');
  resetDb();
  configureOpenRoutines(path.join(root, 'registry'));
  configureBuildMenu(true);
  try {
    const created = fakeRes();
    await handleBuildMenuRoutes(fakeReq('POST', {
      title: 'تقرير محلي',
      brief: 'dry-run local report only',
      selection: { kind: 'automation' },
    }), created as unknown as http.ServerResponse, '/api/build-menu/projects');
    assert.equal(created.status, 200, created.body);
    const projectId = JSON.parse(created.body).projectId as string;
    const project = getAppProject(projectId);
    assert.ok(project);
    fs.mkdirSync(path.join(project.workspaceDir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(project.workspaceDir, 'app', 'automation.json'), `${JSON.stringify({
      cron: '0 9 * * 1',
      timezone: 'Asia/Qatar',
      dryRun: true,
      enabled: false,
      send: false,
      previewCount: 0,
    })}\n`);

    const early = fakeRes();
    await handleBuildMenuRoutes(
      fakeReq('POST', {}),
      early as unknown as http.ServerResponse,
      `/api/build-menu/projects/${projectId}/routines/activate`,
    );
    assert.equal(early.status, 403);
    assert.equal(JSON.parse(fs.readFileSync(path.join(project.workspaceDir, 'app', 'automation.json'), 'utf8')).enabled, false);
    assert.equal(fs.existsSync(path.join(root, 'registry', `${projectId}.json`)), false);

    const website = fakeRes();
    await handleBuildMenuRoutes(fakeReq('POST', {
      title: 'صفحة',
      brief: 'صفحة هبوط محلية على هذا الجهاز',
      selection: { kind: 'website', subtype: 'landing' },
    }), website as unknown as http.ServerResponse, '/api/build-menu/projects');
    assert.equal(website.status, 200, website.body);
    const websiteId = JSON.parse(website.body).projectId as string;
    const refused = fakeRes();
    await handleBuildMenuRoutes(
      fakeReq('POST', {}),
      refused as unknown as http.ServerResponse,
      `/api/build-menu/projects/${websiteId}/routines/activate`,
    );
    assert.equal(refused.status, 400);

    recordPreview(project.workspaceDir);
    recordPreview(project.workspaceDir);
    recordPreview(project.workspaceDir);
    const activated = fakeRes();
    await handleBuildMenuRoutes(
      fakeReq('POST', {}),
      activated as unknown as http.ServerResponse,
      `/api/build-menu/projects/${projectId}/routines/activate`,
    );
    assert.equal(activated.status, 200, activated.body);
    assert.equal(JSON.parse(activated.body).enabled, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(project.workspaceDir, 'app', 'automation.json'), 'utf8')).enabled, true);
    assert.equal(fs.existsSync(path.join(project.workspaceDir, 'app', 'local-report.txt')), false);
    const pointer = JSON.parse(fs.readFileSync(path.join(root, 'registry', `${projectId}.json`), 'utf8')) as { workspace: string };
    assert.equal(pointer.workspace, project.workspaceDir);

    const paused = fakeRes();
    await handleBuildMenuRoutes(
      fakeReq('POST', {}),
      paused as unknown as http.ServerResponse,
      `/api/build-menu/projects/${projectId}/routines/pause`,
    );
    assert.equal(paused.status, 200, paused.body);
    assert.equal(JSON.parse(paused.body).paused, true);
    assert.equal(JSON.parse(paused.body).enabled, true);
    const pausedSpec = JSON.parse(fs.readFileSync(path.join(project.workspaceDir, 'app', 'automation.json'), 'utf8')) as { paused: boolean; enabled: boolean };
    assert.equal(pausedSpec.paused, true);
    assert.equal(pausedSpec.enabled, true);
    assert.equal(fs.existsSync(path.join(root, 'registry', `${projectId}.json`)), true);

    const resumed = fakeRes();
    await handleBuildMenuRoutes(
      fakeReq('POST', {}),
      resumed as unknown as http.ServerResponse,
      `/api/build-menu/projects/${projectId}/routines/resume`,
    );
    assert.equal(resumed.status, 200, resumed.body);
    assert.equal(JSON.parse(resumed.body).paused, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(project.workspaceDir, 'app', 'automation.json'), 'utf8')).paused, false);

    const disabled = fakeRes();
    await handleBuildMenuRoutes(
      fakeReq('POST', {}),
      disabled as unknown as http.ServerResponse,
      `/api/build-menu/projects/${projectId}/routines/disable`,
    );
    assert.equal(disabled.status, 200, disabled.body);
    assert.equal(JSON.parse(disabled.body).enabled, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(project.workspaceDir, 'app', 'automation.json'), 'utf8')).enabled, false);
    assert.equal(fs.existsSync(path.join(root, 'registry', `${projectId}.json`)), false);

    const missing = fakeRes();
    await handleBuildMenuRoutes(
      fakeReq('POST', {}),
      missing as unknown as http.ServerResponse,
      '/api/build-menu/projects/app_bcdfghjkmnpq/routines/activate',
    );
    assert.equal(missing.status, 404);
  } finally {
    configureBuildMenu(false);
    configureOpenRoutines(null);
    resetDb();
    if (previousData === undefined) delete process.env.LOAM_DATA_DIR;
    else process.env.LOAM_DATA_DIR = previousData;
    if (previousWorkspace === undefined) delete process.env.LOAM_WORKSPACE;
    else process.env.LOAM_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
