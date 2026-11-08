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

function context(workspace: string, jobId: string, signal = new AbortController().signal): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'website', subtype: 'landing' };
  return {
    workspace,
    jobId,
    operation: { action: 'preview' },
    signal,
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

test('website preview stays static until an approved lock starts the dev command', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-web-dev-'));
  const previousToken = process.env.NPM_TOKEN;
  process.env.NPM_TOKEN = 'should-not-pass';
  const calls: WebsiteHostCommand[] = [];
  let failInstall = false;
  let listens = 0;
  const ports = createWebsitesPorts({ leases: new ProcessLeaseRegistry(200) });
  const jobs: BuildJobContext[] = [];
  try {
    materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace: root, title: 'هبوط' });
    configureWebsiteHostRunner(async (command) => {
      calls.push(command);
      assert.equal(command.shell, false);
      assert.equal(command.env.NPM_TOKEN, undefined);
      if (failInstall && command.args[0] === 'ci') return 1;
      return 0;
    });
    const plain = context(root, 'job_website_static');
    jobs.push(plain);
    const staticLease = await ports.preview(plain);
    assert.equal(staticLease.kind, 'http');
    if (staticLease.kind !== 'http') return;
    assert.equal(calls.length, 0);
    assert.match(await (await fetch(staticLease.url)).text(), /هبوط/);
    await ports.stop(plain);

    const lock = '{"name":"fixture","lockfileVersion":3}\n';
    fs.writeFileSync(path.join(root, 'app', 'package-lock.json'), lock);
    configureWebsiteLock(createHash('sha256').update(lock).digest('hex'));
    await assert.rejects(
      ports.preview(context(root, 'job_website_unready')),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement',
    );
    assert.equal(calls.length, 0);

    configureWebsiteDevStarter(async (command) => {
      calls.push(command);
      listens += 1;
      assert.equal(command.shell, false);
      assert.equal(command.env.NPM_TOKEN, undefined);
      const index = command.args.indexOf('--port');
      const port = Number(command.args[index + 1]);
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
    const live = context(root, 'job_website_dev');
    jobs.push(live);
    const lease = await ports.preview(live);
    assert.equal(lease.kind, 'http');
    if (lease.kind !== 'http') return;
    const port = new URL(lease.url).port;
    assert.deepEqual(calls.map((command) => command.args), [
      ['ci', '--ignore-scripts'],
      ['--ignore-scripts', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', port, '--strictPort'],
    ]);
    assert.equal(lease.url.includes('token'), false);
    assert.match(await (await fetch(lease.url)).text(), /هبوط/);
    await ports.stop(live);
    await assert.rejects(fetch(lease.url), (error: unknown) => error instanceof Error);

    const before = listens;
    failInstall = true;
    await assert.rejects(
      ports.preview(context(root, 'job_website_dev_fail')),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'tool_failed',
    );
    assert.equal(listens, before);
  } finally {
    for (const job of jobs) await ports.stop(job).catch(() => undefined);
    configureWebsiteLock(null);
    configureWebsiteHostRunner(null);
    configureWebsiteDevStarter(null);
    if (previousToken === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = previousToken;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cancelling a website dev preview leaves no listener and stopping one preview leaves the other', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-web-cancel-'));
  const calls: WebsiteHostCommand[] = [];
  let listens = 0;
  let hold = false;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ports = createWebsitesPorts({ leases: new ProcessLeaseRegistry(200) });
  const jobs: BuildJobContext[] = [];
  try {
    materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace: root, title: 'هبوط' });
    const lock = '{"name":"fixture","lockfileVersion":3}\n';
    fs.writeFileSync(path.join(root, 'app', 'package-lock.json'), lock);
    configureWebsiteLock(createHash('sha256').update(lock).digest('hex'));
    configureWebsiteHostRunner(async (command) => {
      calls.push(command);
      if (hold) await gate;
      return 0;
    });
    configureWebsiteDevStarter(async (command) => {
      listens += 1;
      const index = command.args.indexOf('--port');
      const port = Number(command.args[index + 1]);
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

    const early = new AbortController();
    early.abort();
    await assert.rejects(
      ports.preview(context(root, 'job_website_cancel_early', early.signal)),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'cancelled' && error.status === 409,
    );
    assert.equal(calls.length, 0);
    assert.equal(listens, 0);

    hold = true;
    const during = new AbortController();
    const pending = ports.preview(context(root, 'job_website_cancel_during', during.signal));
    const deadline = Date.now() + 2_000;
    while (calls.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, ['ci', '--ignore-scripts']);
    during.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof BuildMenuError && error.message === 'cancelled' && error.status === 409,
    );
    assert.equal(listens, 0);
    release();

    hold = false;
    const first = context(root, 'job_website_keep');
    const second = context(root, 'job_website_stop');
    jobs.push(first, second);
    const kept = await ports.preview(first);
    const stopped = await ports.preview(second);
    assert.equal(kept.kind, 'http');
    assert.equal(stopped.kind, 'http');
    if (kept.kind !== 'http' || stopped.kind !== 'http') return;
    await ports.stop(second);
    assert.match(await (await fetch(kept.url)).text(), /هبوط/);
    await assert.rejects(fetch(stopped.url), (error: unknown) => error instanceof Error);
    await ports.stop(first);
  } finally {
    release();
    for (const job of jobs) await ports.stop(job).catch(() => undefined);
    configureWebsiteLock(null);
    configureWebsiteHostRunner(null);
    configureWebsiteDevStarter(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
