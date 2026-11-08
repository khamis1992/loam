import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { materialize } from '../materialize.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import {
  configureWebsiteDevStarter,
  configureWebsiteHostRunner,
  configureWebsiteLock,
  currentWebsiteDevStarter,
  currentWebsiteHostRunner,
  websiteHostReady,
} from '../websites/hostCommand.js';
import { createWebsitesPorts } from '../websites/ports.js';

type SpawnOptions = { file?: string };
type SpawnMethod = (this: ChildProcess, options: SpawnOptions) => unknown;

function isNpm(file: string): boolean {
  const base = path.basename(file).toLowerCase();
  return base === 'npm' || base === 'npm.cmd' || base === 'npm.exe' || base === 'npm.ps1';
}

function watchSpawns(): { files: string[]; restore: () => void } {
  const files: string[] = [];
  const proto = ChildProcess.prototype as unknown as { spawn: SpawnMethod };
  const original = proto.spawn;
  proto.spawn = function (this: ChildProcess, options: SpawnOptions): unknown {
    files.push(options?.file ?? '');
    return original.call(this, options);
  };
  return {
    files,
    restore() {
      proto.spawn = original;
    },
  };
}

function context(workspace: string, jobId: string, operation: BuildJobContext['operation']): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'website', subtype: 'landing' };
  return {
    workspace,
    jobId,
    operation,
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

test('a null production host runner previews and packages without spawning npm', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-web-port-host-'));
  const ports = createWebsitesPorts({ leases: new ProcessLeaseRegistry(200) });
  const previewJob = context(root, 'job_website_port_preview', { action: 'preview' });
  const packageJob = context(root, 'job_website_port_package', { action: 'package', format: 'web-zip' });
  const cellJob = context(root, 'job_website_port_cell', { action: 'kernel-execute', cellId: 'cell-1' });
  const watch = watchSpawns();
  try {
    configureWebsiteHostRunner(null);
    configureWebsiteDevStarter(null);
    configureWebsiteLock(null);
    assert.equal(currentWebsiteHostRunner(), null);
    assert.equal(currentWebsiteDevStarter(), null);
    assert.equal(websiteHostReady(), false);

    materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace: root, title: 'هبوط' });
    const preview = await ports.preview(previewJob);
    if (preview.kind !== 'http') throw new Error('preview_not_http');
    assert.match(await (await fetch(preview.url)).text(), /هبوط/);

    const artifact = await ports.export(packageJob, 'web-zip');
    assert.ok(artifact.bytes > 0);
    assert.match(fs.readFileSync(path.join(root, 'app', 'dist', 'index.html'), 'utf8'), /src="\.\/page\.js"/);
    assert.equal(fs.existsSync(path.join(root, 'app', 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'npm-cache')), false);

    await assert.rejects(
      ports.executeCell(cellJob, 'cell-1'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsupported_operation' && error.status === 400,
    );

    await ports.stop(previewJob);
    const nodePath = path.resolve(process.execPath).toLowerCase();
    assert.equal(watch.files.some((file) => path.resolve(file).toLowerCase() === nodePath), true);
    assert.equal(watch.files.some((file) => isNpm(file)), false);
    assert.equal(currentWebsiteHostRunner(), null);
    assert.equal(currentWebsiteDevStarter(), null);
  } finally {
    watch.restore();
    await ports.stop(previewJob).catch(() => undefined);
    configureWebsiteHostRunner(null);
    configureWebsiteDevStarter(null);
    configureWebsiteLock(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
