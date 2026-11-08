import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { BuildJobContext } from '../../../packages/shared/src/buildMenu.js';
import { desktopProfile, desktopBrief } from '../desktop/profile.js';
import { createDesktopPorts } from '../desktop/ports.js';
import { BuildMenuError } from '../grants.js';
import { ProcessLeaseRegistry } from '../processLease.js';

const require = createRequire(import.meta.url);
const { allowNavigation } = require('../../templates/electron-app/electron/navigation.cjs') as {
  allowNavigation: (url: string, appRoot: string, realpath?: (target: string) => string) => boolean;
};
const { userDataDir } = require('../../templates/electron-app/electron/userData.cjs') as {
  userDataDir: (appDir: string, previewReady: string | undefined) => string;
};

test('desktop: fixed capability boundary', () => {
  assert.equal(desktopProfile.kind, 'desktop');
  assert.equal(desktopProfile.preview, 'window');
  assert.equal(desktopProfile.externalEffects, 'approval-required');
  assert.ok(desktopProfile.exports.includes('source-zip'));
  assert.ok(desktopBrief.length > 40);
});

test('a desktop window stays inside the project and does not open another window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-nav-'));
  const page = path.join(root, 'dist', 'index.html');
  fs.mkdirSync(path.dirname(page), { recursive: true });
  fs.writeFileSync(page, '<!doctype html>');
  try {
    assert.equal(allowNavigation(pathToFileURL(page).href, root), true);
    assert.equal(allowNavigation(pathToFileURL(page).href, root, (target) => target === page ? path.join(os.tmpdir(), 'escaped.html') : target), false);
    assert.equal(allowNavigation(pathToFileURL(path.join(os.tmpdir(), 'other.html')).href, root), false);
    assert.equal(allowNavigation('https://example.test/page', root), false);
    assert.equal(allowNavigation('not a url', root), false);
    const main = fs.readFileSync(new URL('../../templates/electron-app/electron/main.cjs', import.meta.url), 'utf8');
    assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
    assert.match(main, /allowNavigation\(url, path\.join\(__dirname, '\.\.'\)\)/);
    assert.equal(userDataDir(root, path.join(root, 'ready')), path.join(root, '.preview-data'));
    assert.equal(userDataDir(root, undefined), path.join(root, '.app-data'));
    assert.equal(userDataDir(root, 'relative'), path.join(root, '.app-data'));
    assert.equal(main.includes("app.getPath('appData')"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function exeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...exeFiles(absolute));
    else if (item.isFile() && item.name.toLowerCase().endsWith('.exe')) found.push(absolute);
  }
  return found;
}

test('desktop export of portable-exe rejects with missing_requirement and writes no exe', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-desktop-portable-'));
  const ports = createDesktopPorts({ leases: new ProcessLeaseRegistry(500), electronExecutable: null });
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: 'job_desktop_package',
    operation: { action: 'package', format: 'portable-exe' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection: { kind: 'desktop' },
      title: 'مكتب',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
  try {
    await ports.scaffold(ctx);
    await assert.rejects(
      ports.export(ctx, 'portable-exe'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement' && error.status === 400,
    );
    assert.deepEqual(exeFiles(root), []);
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'artifacts')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
