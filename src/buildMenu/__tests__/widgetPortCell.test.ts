import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { createWidgetPorts } from '../widget/ports.js';

const STARTUP_MARKERS = [
  'setLoginItemSettings',
  'openAtLogin',
  'shell:startup',
  'CurrentVersion\\Run',
  'reg add',
] as const;

function context(workspace: string): BuildJobContext {
  return {
    workspace,
    jobId: 'job_widget_cell',
    operation: { action: 'kernel-execute', cellId: 'cell-1' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection: { kind: 'widget' },
      title: 'ويدجت',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...listFiles(absolute));
    else if (item.isFile()) found.push(absolute);
  }
  return found.sort();
}

function textFilesContain(dir: string, phrase: string): boolean {
  for (const file of listFiles(dir)) {
    const stat = fs.statSync(file);
    if (stat.size > 1_000_000) continue;
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) continue;
    if (bytes.toString('utf8').includes(phrase)) return true;
  }
  return false;
}

test('widget executeCell is unsupported and portable-exe writes no exe or autostart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-port-cell-'));
  const ports = createWidgetPorts({ leases: new ProcessLeaseRegistry(200), electronExecutable: null });
  const ctx = context(root);
  const manifestPath = path.join(root, '.loam', 'build-menu', 'manifest.json');
  try {
    await ports.scaffold(ctx);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify({ consent: { autostart: false, publish: false } })}\n`);
    const before = listFiles(root);

    await assert.rejects(
      ports.executeCell(ctx, 'cell-1'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsupported_operation' && error.status === 400,
    );
    await assert.rejects(
      ports.executeCell({ ...ctx, operation: { action: 'preview' } }, 'cell-1'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsupported_operation' && error.status === 400,
    );

    const packaged: BuildJobContext = {
      ...ctx,
      operation: { action: 'package', format: 'portable-exe' },
    };
    await assert.rejects(
      ports.export(packaged, 'portable-exe'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement' && error.status === 400,
    );

    assert.deepEqual(listFiles(root), before);
    assert.equal(listFiles(root).some((file) => file.toLowerCase().endsWith('.exe')), false);
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'artifacts')), false);
    assert.equal(ctx.manifest.consent.autostart, false);
    assert.equal(packaged.manifest.consent.autostart, false);
    const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { consent: { autostart: boolean } };
    assert.equal(saved.consent.autostart, false);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'app', 'desktop-app.json'), 'utf8')) as {
      autostart?: unknown;
      openAtLogin?: unknown;
    };
    assert.equal(config.autostart, undefined);
    assert.equal(config.openAtLogin, undefined);
    const html = fs.readFileSync(path.join(root, 'app', 'dist', 'index.html'), 'utf8');
    assert.match(html, /id="autostart-toggle"[^>]*disabled/);
    for (const phrase of STARTUP_MARKERS) {
      assert.equal(textFilesContain(root, phrase), false, phrase);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
