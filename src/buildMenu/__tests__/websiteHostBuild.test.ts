import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { materialize } from '../materialize.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { configureWebsiteHostRunner, configureWebsiteLock, type WebsiteHostCommand } from '../websites/hostCommand.js';
import { createWebsitesPorts } from '../websites/ports.js';

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'website', subtype: 'landing' };
  return {
    workspace,
    jobId: 'job_website_host_build',
    operation: { action: 'package', format: 'web-zip' },
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

test('an approved website lock builds through the host runner and a failure keeps the previous zip', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-web-approved-'));
  const previousToken = process.env.NPM_TOKEN;
  process.env.NPM_TOKEN = 'should-not-pass';
  const calls: WebsiteHostCommand[] = [];
  let fail = false;
  let failTypecheck = false;
  const ports = createWebsitesPorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace: root, title: 'هبوط' });
    const overlay = await ports.export(context(root), 'web-zip');
    assert.equal(calls.length, 0);
    assert.match(unzip(fs.readFileSync(path.join(root, overlay.relativePath))).get('index.html')?.toString('utf8') ?? '', /هبوط/);
    fs.rmSync(path.join(root, 'app', 'dist'), { recursive: true, force: true });
    const lock = '{"name":"fixture","lockfileVersion":3}\n';
    fs.writeFileSync(path.join(root, 'app', 'package-lock.json'), lock);
    configureWebsiteLock(createHash('sha256').update(lock).digest('hex'));
    configureWebsiteHostRunner(async (command) => {
      calls.push(command);
      assert.equal(command.shell, false);
      assert.equal(command.env.NPM_TOKEN, undefined);
      if (failTypecheck && command.args.includes('typecheck')) return 1;
      if (fail) return 1;
      if (command.args.includes('build')) {
        fs.mkdirSync(path.join(root, 'app', 'dist'), { recursive: true });
        fs.writeFileSync(path.join(root, 'app', 'dist', 'index.html'), '<p>vite-dist</p>');
      }
      return 0;
    });
    const built = await ports.export(context(root), 'web-zip');
    assert.deepEqual(calls.map((command) => command.args), [
      ['ci', '--ignore-scripts'],
      ['--ignore-scripts', 'run', 'typecheck'],
      ['ci', '--ignore-scripts'],
      ['--ignore-scripts', 'run', 'build'],
    ]);
    const builtBytes = fs.readFileSync(path.join(root, built.relativePath));
    assert.match(unzip(builtBytes).get('index.html')?.toString('utf8') ?? '', /vite-dist/);
    const beforeTypecheck = calls.length;
    failTypecheck = true;
    await assert.rejects(
      ports.export(context(root), 'web-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'tool_failed',
    );
    assert.deepEqual(calls.slice(beforeTypecheck).map((command) => command.args), [
      ['ci', '--ignore-scripts'],
      ['--ignore-scripts', 'run', 'typecheck'],
    ]);
    assert.equal(fs.readFileSync(path.join(root, built.relativePath)).equals(builtBytes), true);
    failTypecheck = false;
    fail = true;
    await assert.rejects(
      ports.export(context(root), 'web-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'tool_failed',
    );
    assert.equal(fs.readFileSync(path.join(root, built.relativePath)).equals(builtBytes), true);
    const logPath = path.join(root, '.loam', 'build-menu', 'build.log');
    const once = fs.readFileSync(logPath, 'utf8');
    assert.match(once, /فشل بناء القالب/);
    assert.match(once, /لم يُستخدم نشر سحابي/);
    assert.equal(once.includes('should-not-pass'), false);
    assert.match(fs.readFileSync(path.join(root, 'app', 'dist', 'index.html'), 'utf8'), /vite-dist/);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await assert.rejects(ports.export(context(root), 'web-zip'), (error: unknown) => error instanceof BuildMenuError && error.message === 'tool_failed');
    }
    const log = fs.readFileSync(logPath, 'utf8');
    assert.equal(log.length <= 2_000, true);
    assert.match(log, /فشل بناء القالب/);
    assert.equal(calls.every((command) => command.args.includes('build') || command.args.includes('typecheck') || command.args[0] === 'ci'), true);
    assert.equal(fs.readFileSync(path.join(root, built.relativePath)).equals(builtBytes), true);
  } finally {
    configureWebsiteLock(null);
    configureWebsiteHostRunner(null);
    if (previousToken === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = previousToken;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
