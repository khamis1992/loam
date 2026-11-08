import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import type { DesktopPackOptions } from '../../packs/desktop/tools.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-desktop-routes-'));
process.env.MANUS_LOCAL_DATA_DIR = tmp;

const { createDesktopProject, desktopMetadataPath } = await import('../../packs/desktop/project.js');
const { handleDesktopRoutes } = await import('../routes/desktop.js');
const { createTask } = await import('../db.js');
const { ensureTaskWorkspace } = await import('../taskWorkspace.js');

interface Captured { status: number; body: unknown }

function fakeReq(method: string, url: string, body?: unknown): http.IncomingMessage {
  const req = new Readable({ read() {} }) as unknown as http.IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {};
  process.nextTick(() => {
    if (body !== undefined) req.push(Buffer.from(JSON.stringify(body)));
    req.push(null);
  });
  return req;
}

function fakeRes(): { res: http.ServerResponse; captured: Promise<Captured> } {
  const writable = new Writable({ write(_chunk, _encoding, callback) { callback(); } }) as unknown as http.ServerResponse;
  let status = 0;
  const chunks: string[] = [];
  (writable as unknown as { writeHead: (status: number) => void }).writeHead = (value: number) => { status = value; return writable; };
  (writable as unknown as { end: (body?: string | Buffer) => void }).end = (body?: string | Buffer) => {
    chunks.push(typeof body === 'string' ? body : (body ?? '').toString());
    writable.emit('close');
  };
  const captured = new Promise<Captured>((resolve) => writable.on('close', () => resolve({ status, body: chunks.length ? JSON.parse(chunks.join('')) : null })));
  return { res: writable, captured };
}

async function call(method: string, target: string, body?: unknown, options: DesktopPackOptions = {}): Promise<Captured> {
  const { res, captured } = fakeRes();
  const url = new URL(target, 'http://127.0.0.1');
  const handled = await handleDesktopRoutes(fakeReq(method, target, body), res, url.pathname, options);
  assert.equal(handled, true);
  return captured;
}

test('desktop routes load metadata by task id and enforce build verification before launch', async () => {
  const project = createDesktopProject({ title: 'Route file organizer', baseWorkspace: tmp });
  const parent = createTask('Desktop resource owner', 'Route test');
  const parentWorkspace = ensureTaskWorkspace(parent.id, tmp);
  const metadataPath = desktopMetadataPath(project, parentWorkspace);
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({ projectId: project.id, kind: project.kind, title: project.title }));

  const missingId = await call('GET', '/api/desktop/metadata');
  assert.equal(missingId.status, 400);
  assert.deepEqual(missingId.body, { error: 'projectId_required' });
  const invalidPath = await call('GET', `/api/desktop/metadata?taskId=${parent.id}&path=app/package.json`);
  assert.equal(invalidPath.status, 400);
  assert.deepEqual(invalidPath.body, { error: 'desktop_metadata_path_invalid' });

  const metadata = await call('GET', `/api/desktop/metadata?taskId=${parent.id}&path=uploads/${path.basename(metadataPath)}`);
  assert.equal(metadata.status, 200, JSON.stringify(metadata.body));
  assert.equal((metadata.body as { verified: boolean }).verified, false);
  assert.equal((metadata.body as { project: { id: string } }).project.id, project.id);

  let launches = 0;
  let stops = 0;
  const options: DesktopPackOptions = {
    verify: async () => ({ ok: true, output: 'passed' }),
    snapshot: async () => ({ number: 1 }),
    launch: async (current) => {
      launches += 1;
      return { pid: 8765, projectId: current.id, workspaceDir: current.workspaceDir, logPath: 'runtime.log', debugPort: 20002 };
    },
    stop: async () => { stops += 1; },
  };
  const earlyLaunch = await call('POST', `/api/desktop/launch?projectId=${project.id}`, {}, options);
  assert.equal(earlyLaunch.status, 400);
  assert.deepEqual(earlyLaunch.body, { error: 'desktop_verification_required' });
  assert.equal(launches, 0);

  fs.mkdirSync(path.join(project.workspaceDir, 'app', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(project.workspaceDir, 'app', 'dist', 'index.html'), '<!doctype html><title>Loam</title>');
  const verified = await call('POST', `/api/desktop/verify?projectId=${project.id}`, {}, options);
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  const current = await call('GET', `/api/desktop?projectId=${project.id}`);
  assert.equal((current.body as { verified: boolean }).verified, true);

  const launched = await call('POST', `/api/desktop/launch?projectId=${project.id}`, {}, options);
  assert.equal(launched.status, 200, JSON.stringify(launched.body));
  assert.equal(launches, 1);
  const stopped = await call('POST', `/api/desktop/stop?projectId=${project.id}`, {}, options);
  assert.equal(stopped.status, 200);
  assert.equal(stops, 1);
});

test('desktop metadata refuses a resource owned by another project', async () => {
  const project = createDesktopProject({ title: 'Metadata owner', baseWorkspace: tmp });
  const file = desktopMetadataPath(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ projectId: 'app_other' }));
  const mismatch = await call('GET', `/api/desktop/metadata?projectId=${project.id}&path=uploads/${path.basename(file)}`);
  assert.equal(mismatch.status, 409);
  assert.deepEqual(mismatch.body, { error: 'desktop_metadata_project_mismatch' });
  const { res } = fakeRes();
  assert.equal(await handleDesktopRoutes(fakeReq('GET', '/api/other'), res, '/api/other'), false);
});
