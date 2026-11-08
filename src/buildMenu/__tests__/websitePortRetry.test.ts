import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { materialize } from '../materialize.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { configureWebsiteDevStarter, configureWebsiteHostRunner, configureWebsiteLock, type WebsiteHostCommand } from '../websites/hostCommand.js';
import { createWebsitesPorts } from '../websites/ports.js';

function context(workspace: string, jobId: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'website', subtype: 'landing' };
  return {
    workspace,
    jobId,
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'هبوط',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

function occupy(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('صاحب المنفذ');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('port'));
        return;
      }
      resolve({ port: address.port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

test('a busy website dev port is left alone and the next leased port is used', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-web-port-'));
  const calls: WebsiteHostCommand[] = [];
  const owners: Array<{ port: number; close: () => Promise<void> }> = [];
  let conflicts = 0;
  const ports = createWebsitesPorts({ leases: new ProcessLeaseRegistry(200) });
  const job = context(root, 'job_website_port_retry');
  try {
    materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace: root, title: 'هبوط' });
    const lock = '{"name":"fixture","lockfileVersion":3}\n';
    fs.writeFileSync(path.join(root, 'app', 'package-lock.json'), lock);
    configureWebsiteLock(createHash('sha256').update(lock).digest('hex'));
    configureWebsiteHostRunner(async (command) => {
      calls.push(command);
      return 0;
    });
    configureWebsiteDevStarter(async (command) => {
      calls.push(command);
      const index = command.args.indexOf('--port');
      const port = Number(command.args[index + 1]);
      if (conflicts < 2) {
        conflicts += 1;
        const owner = await occupy();
        owners.push(owner);
        const taken = Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' });
        throw taken;
      }
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<p>هبوط</p>');
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
      });
      return { stop: () => new Promise((resolve) => server.close(() => resolve())) };
    });
    const lease = await ports.preview(job);
    assert.equal(lease.kind, 'http');
    if (lease.kind !== 'http') return;
    const devPorts = calls.filter((command) => command.args[0] !== 'ci').map((command) => command.args[command.args.indexOf('--port') + 1]);
    assert.equal(calls.filter((command) => command.args[0] === 'ci').length, 1);
    assert.equal(devPorts.length, 3);
    assert.equal(new Set(devPorts).size, 3);
    assert.equal(new URL(lease.url).port, devPorts[2]);
    assert.match(await (await fetch(lease.url)).text(), /هبوط/);
    for (const owner of owners) assert.equal(await (await fetch(`http://127.0.0.1:${owner.port}/`)).text(), 'صاحب المنفذ');
    await ports.stop(job);
    for (const owner of owners) await owner.close();
    owners.length = 0;

    conflicts = 0;
    calls.length = 0;
    configureWebsiteDevStarter(async () => {
      conflicts += 1;
      const owner = await occupy();
      owners.push(owner);
      throw Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' });
    });
    await assert.rejects(
      ports.preview(context(root, 'job_website_ports_full')),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'port_exhausted' && error.status === 503,
    );
    assert.equal(conflicts, 3);
    assert.equal(calls.filter((command) => command.args[0] === 'ci').length, 1);
    for (const owner of owners) assert.equal(await (await fetch(`http://127.0.0.1:${owner.port}/`)).text(), 'صاحب المنفذ');
  } finally {
    await ports.stop(job).catch(() => undefined);
    for (const owner of owners) await owner.close().catch(() => undefined);
    configureWebsiteLock(null);
    configureWebsiteHostRunner(null);
    configureWebsiteDevStarter(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
