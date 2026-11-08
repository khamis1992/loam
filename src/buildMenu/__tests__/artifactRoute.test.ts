import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { getAppProject } from '../../appbuilder/store.js';
import { configureBuildMenu, handleBuildMenuRoutes } from '../../server/routes/buildMenu.js';
import { resetDb } from '../../server/sqliteStore.js';
import { resetGrants } from '../grants.js';
import { resetJobs } from '../jobs.js';

const planSha256 = 'b'.repeat(64);

function fakeReq(method: string, body?: unknown): http.IncomingMessage {
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(raw) as http.IncomingMessage;
  req.method = method;
  req.headers = { origin: 'app://agent', 'x-loam-local-token': 'token-token' };
  req.url = '/';
  return req;
}

function fakeRes() {
  return {
    status: 0,
    body: '' as string | Buffer,
    writeHead(code: number) { this.status = code; },
    end(text?: string | Buffer) { this.body = text ?? ''; },
  };
}

function responseText(body: string | Buffer): string {
  return typeof body === 'string' ? body : body.toString('utf8');
}

async function post(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = fakeRes();
  await handleBuildMenuRoutes(fakeReq('POST', body), response as unknown as http.ServerResponse, url);
  return { status: response.status, json: JSON.parse(responseText(response.body)) as Record<string, unknown> };
}

async function get(url: string): Promise<{ status: number; body: string | Buffer; json: Record<string, unknown> | null }> {
  const response = fakeRes();
  await handleBuildMenuRoutes(fakeReq('GET'), response as unknown as http.ServerResponse, url);
  const text = responseText(response.body);
  const json = text.startsWith('{') ? JSON.parse(text) as Record<string, unknown> : null;
  return { status: response.status, body: response.body, json };
}

test('an unknown artifact is 404, a stale revision is 409, and the closed download stays', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-artifact-route-'));
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
      title: 'هبوط',
      brief: 'صفحة هبوط محلية على هذا الجهاز',
      selection: { kind: 'website', subtype: 'landing' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const projectId = created.json.projectId as string;
    const generatedGrant = await post(`/api/build-menu/projects/${projectId}/grants`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
    });
    const generated = await post(`/api/build-menu/projects/${projectId}/jobs`, {
      expectedRevision: 1,
      planSha256,
      operation: { action: 'generate' },
      grantId: generatedGrant.json.grantId,
      idempotencyKey: 'site-generate',
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.json));
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
      idempotencyKey: 'site-source',
    });
    assert.equal(packed.status, 200, JSON.stringify(packed.json));
    const artifactId = packed.json.artifactId as string;
    const project = getAppProject(projectId);
    assert.ok(project);
    const artifactDir = path.join(project.workspaceDir, '.loam', 'build-menu', 'artifacts');
    const namesBefore = fs.readdirSync(artifactDir).sort();
    const first = await get(`/api/build-menu/projects/${projectId}/artifacts/${artifactId}`);
    assert.equal(first.status, 200);
    const firstBytes = Buffer.isBuffer(first.body) ? first.body : Buffer.from(first.body);
    const preview = path.join(project.workspaceDir, 'app', 'preview.html');
    fs.writeFileSync(preview, `${fs.readFileSync(preview, 'utf8')}\n<p>بعد</p>\n`);
    const again = await get(`/api/build-menu/projects/${projectId}/artifacts/${artifactId}`);
    const againBytes = Buffer.isBuffer(again.body) ? again.body : Buffer.from(again.body);
    assert.equal(again.status, 200);
    assert.equal(againBytes.equals(firstBytes), true);
    assert.equal(createHash('sha256').update(againBytes).digest('hex'), createHash('sha256').update(firstBytes).digest('hex'));
    assert.equal(againBytes.includes(Buffer.from('بعد')), false);

    const missing = await get(`/api/build-menu/projects/${projectId}/artifacts/art_00000000-0000-4000-8000-000000000000`);
    assert.equal(missing.status, 404);
    assert.equal(missing.json?.message, 'not_found');
    assert.deepEqual(fs.readdirSync(artifactDir).sort(), namesBefore);

    const stale = await post(`/api/build-menu/projects/${projectId}/grants`, {
      expectedRevision: 2,
      planSha256,
      operation: { action: 'package', format: 'source-zip' },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.message, 'stale_revision');
    const kept = await get(`/api/build-menu/projects/${projectId}/artifacts/${artifactId}`);
    const keptBytes = Buffer.isBuffer(kept.body) ? kept.body : Buffer.from(kept.body);
    assert.equal(kept.status, 200);
    assert.equal(keptBytes.equals(firstBytes), true);
    assert.deepEqual(fs.readdirSync(artifactDir).sort(), namesBefore);
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
