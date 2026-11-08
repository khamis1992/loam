import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import {
  configureWebsiteDevStarter,
  configureWebsiteHostRunner,
  configureWebsiteLock,
  currentWebsiteDevStarter,
  currentWebsiteHostRunner,
  deliverWebsiteHostCommand,
  runWebsiteHost,
  startApprovedWebsiteDev,
  websiteHostCommands,
  websiteHostReady,
  type WebsiteHostCommand,
} from '../websites/hostCommand.js';
import { createWebsitesPorts } from '../websites/ports.js';

const REMOTE = [
  'https://evil.example/a.js',
  'http://evil.example/a.js',
  'HTTPS://evil.example/a',
  'HTTP://evil.example/a',
  '//evil.example/a.js',
  'https%3A%2F%2Fevil.example/a',
  'http%3A%2F%2Fevil.example/a',
  'https%253A%252F%252Fevil.example/a',
  'http%253A%252F%252Fevil.example/a',
  '"https"+"://evil.example/a"',
  '"http" + "://evil.example/a"',
];

const MAIL = [
  'mailto:user@example.com',
  'MAILTO:user@example.com',
  'mailto :user@example.com',
  'mailto%3Auser@example.com',
  'mailto%253Auser@example.com',
  '"mailto"+":"',
];

const LIFECYCLE = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'publish',
  'postpublish',
  'prepack',
  'postpack',
  'preuninstall',
  'uninstall',
  'postuninstall',
  'prebuild',
  'postbuild',
  'predev',
  'postdev',
];

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'website', subtype: 'landing' };
  return {
    workspace,
    jobId: 'job_website_host_scheme',
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

function hostCommand(args: readonly string[]): WebsiteHostCommand {
  return {
    executable: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
    cwd: 'app',
    shell: false,
    env: { npm_config_ignore_scripts: 'true' },
  };
}

function project(): { root: string; digest: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-web-scheme-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  const template = path.resolve('templates', 'web-app');
  fs.copyFileSync(path.join(template, 'package.json'), path.join(app, 'package.json'));
  fs.copyFileSync(path.join(template, 'vite.config.ts'), path.join(app, 'vite.config.ts'));
  const lockPath = path.join(app, 'package-lock.json');
  fs.writeFileSync(lockPath, '{"name":"loam-web-app","lockfileVersion":3,"packages":{}}\n');
  return { root, digest: createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex') };
}

function refused(error: unknown): boolean {
  return error instanceof BuildMenuError && (error.message === 'missing_requirement' || error.message === 'invalid_request' || error.message === 'unsafe_path') && error.status === 400;
}

async function rejectsBeforeRunner(args: readonly string[]): Promise<void> {
  let calls = 0;
  await assert.rejects(
    () => deliverWebsiteHostCommand(hostCommand(args), () => {
      calls += 1;
      return Promise.resolve(0);
    }),
    (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request' && error.status === 400,
    args.join(' '),
  );
  assert.equal(calls, 0, args.join(' '));
}

test('a null lock is not ready and a null runner does not build or start dev', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-web-scheme-null-'));
  const ports = createWebsitesPorts({ leases: new ProcessLeaseRegistry(200) });
  let calls = 0;
  const spawnImpl = (): Promise<number> => {
    calls += 1;
    return Promise.resolve(0);
  };
  const listenImpl = (): Promise<{ stop: () => Promise<void> }> => {
    calls += 1;
    return Promise.resolve({ stop: () => Promise.resolve() });
  };
  try {
    configureWebsiteLock(null);
    assert.equal(websiteHostReady(), false);
    assert.equal(currentWebsiteHostRunner(), null);
    assert.equal(currentWebsiteDevStarter(), null);

    await assert.rejects(
      () => runWebsiteHost({ workspace: root, script: 'build', spawnImpl }),
      refused,
    );
    await assert.rejects(
      () => startApprovedWebsiteDev({
        workspace: root,
        ports: [43123],
        signal: new AbortController().signal,
        installImpl: spawnImpl,
        listenImpl,
      }),
      refused,
    );
    assert.equal(calls, 0);

    configureWebsiteLock('a'.repeat(64));
    assert.equal(websiteHostReady(), true);
    assert.equal(currentWebsiteHostRunner(), null);
    assert.equal(currentWebsiteDevStarter(), null);
    const built = context(root);
    const started = { ...built, jobId: 'job_website_host_scheme_dev', operation: { action: 'preview' as const } };
    await assert.rejects(() => ports.export(built, 'web-zip'), refused);
    await assert.rejects(() => ports.preview(started), refused);
    assert.equal(calls, 0);
    assert.equal(currentWebsiteHostRunner(), null);
  } finally {
    configureWebsiteLock(null);
    configureWebsiteHostRunner(null);
    configureWebsiteDevStarter(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(websiteHostReady(), false);
  assert.equal(currentWebsiteHostRunner(), null);
  assert.equal(currentWebsiteDevStarter(), null);
});

test('a remote url, mailto, or lifecycle script is not passed to a website host runner', async () => {
  const made = project();
  let calls = 0;
  try {
    assert.equal(currentWebsiteHostRunner(), null);
    for (const arg of [...REMOTE, ...MAIL, ...LIFECYCLE]) {
      await rejectsBeforeRunner([arg]);
      await rejectsBeforeRunner(['--ignore-scripts', 'run', arg]);
    }
    await rejectsBeforeRunner(['https:', '//evil.example/a.js']);
    await rejectsBeforeRunner(['ci', 'https://registry.npmjs.org/left-pad']);

    const safe = [
      ['ci', '--ignore-scripts'],
      ['--ignore-scripts', 'run', 'typecheck'],
      ['--ignore-scripts', 'run', 'build'],
      ['--ignore-scripts', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '43123', '--strictPort'],
    ];
    for (const args of safe) {
      const code = await deliverWebsiteHostCommand(hostCommand(args), () => {
        calls += 1;
        return Promise.resolve(0);
      });
      assert.equal(code, 0);
    }
    assert.equal(calls, safe.length);

    configureWebsiteLock(made.digest);
    const seen: WebsiteHostCommand[] = [];
    await runWebsiteHost({
      workspace: made.root,
      script: 'build',
      spawnImpl: (command) => {
        seen.push(command);
        return Promise.resolve(0);
      },
    });
    const started = await startApprovedWebsiteDev({
      workspace: made.root,
      ports: [43123],
      signal: new AbortController().signal,
      installImpl: (command) => {
        seen.push(command);
        return Promise.resolve(0);
      },
      listenImpl: (command) => {
        seen.push(command);
        return Promise.resolve({ stop: () => Promise.resolve() });
      },
    });
    assert.equal(started.port, 43123);
    assert.deepEqual(seen.map((command) => command.args), [
      ['ci', '--ignore-scripts'],
      ['--ignore-scripts', 'run', 'build'],
      ['ci', '--ignore-scripts'],
      ['--ignore-scripts', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '43123', '--strictPort'],
    ]);
    assert.deepEqual(websiteHostCommands(made.root, 'typecheck').map((command) => command.args), [
      ['ci', '--ignore-scripts'],
      ['--ignore-scripts', 'run', 'typecheck'],
    ]);
    assert.equal(currentWebsiteHostRunner(), null);
    assert.equal(currentWebsiteDevStarter(), null);
  } finally {
    configureWebsiteLock(null);
    configureWebsiteHostRunner(null);
    configureWebsiteDevStarter(null);
    fs.rmSync(made.root, { recursive: true, force: true });
  }
  assert.equal(websiteHostReady(), false);
  assert.equal(currentWebsiteHostRunner(), null);
});
