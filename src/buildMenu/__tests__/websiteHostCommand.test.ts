import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildMenuError } from '../grants.js';
import { configureWebsiteLock, runWebsiteHost, type WebsiteHostCommand } from '../websites/hostCommand.js';

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-web-host-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  const template = path.resolve('templates', 'web-app');
  fs.copyFileSync(path.join(template, 'package.json'), path.join(app, 'package.json'));
  fs.copyFileSync(path.join(template, 'vite.config.ts'), path.join(app, 'vite.config.ts'));
  return root;
}

test('website host commands stay unspawned until an approved lock matches', async () => {
  const root = project();
  const calls: WebsiteHostCommand[] = [];
  const spawnImpl = (command: WebsiteHostCommand): Promise<number> => {
    calls.push(command);
    return Promise.resolve(0);
  };
  const previous = process.env.NPM_TOKEN;
  process.env.NPM_TOKEN = 'secret-token';
  try {
    configureWebsiteLock(null);
    await assert.rejects(
      () => runWebsiteHost({ workspace: root, script: 'dev', port: 43123, spawnImpl }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement',
    );
    const lock = path.join(root, 'app', 'package-lock.json');
    fs.writeFileSync(lock, '{"name":"loam-web-app","lockfileVersion":3,"packages":{}}\n');
    await assert.rejects(
      () => runWebsiteHost({ workspace: root, script: 'build', spawnImpl }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement',
    );
    assert.equal(calls.length, 0);
    const digest = createHash('sha256').update(fs.readFileSync(lock)).digest('hex');
    configureWebsiteLock(digest);
    await runWebsiteHost({ workspace: root, script: 'dev', port: 43123, spawnImpl });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.shell, false);
    assert.deepEqual(calls[0]?.args, ['ci', '--ignore-scripts']);
    assert.deepEqual(calls[1]?.args, ['--ignore-scripts', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '43123', '--strictPort']);
    assert.equal(calls[0]?.executable, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    assert.equal(calls[0]?.env.NPM_TOKEN, undefined);
    assert.equal(calls[0]?.args.includes('install'), false);
    assert.equal(calls[1]?.args.includes('install'), false);
    calls.length = 0;
    const pkg = path.join(root, 'app', 'package.json');
    const original = fs.readFileSync(pkg, 'utf8');
    const parsed = JSON.parse(original) as { scripts: Record<string, string> };
    parsed.scripts.preinstall = 'node evil.js';
    fs.writeFileSync(pkg, JSON.stringify(parsed));
    await assert.rejects(
      () => runWebsiteHost({ workspace: root, script: 'typecheck', spawnImpl }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request',
    );
    assert.equal(calls.length, 0);
    fs.writeFileSync(pkg, original);
    await assert.rejects(
      () => runWebsiteHost({ workspace: root, script: 'dev', port: '43123;calc' as unknown as number, spawnImpl }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request',
    );
    const failing = (): Promise<number> => Promise.resolve(1);
    await assert.rejects(
      () => runWebsiteHost({ workspace: root, script: 'build', spawnImpl: failing }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'tool_failed',
    );
  } finally {
    if (previous === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = previous;
    configureWebsiteLock(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
