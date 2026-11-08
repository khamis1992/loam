import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { findElectron } from '../toolchain.js';
import { clampPosition } from '../widget/geometry.js';
import { createWidgetPorts } from '../widget/ports.js';

test('a real widget window hides on close and the preview stop ends it', async () => {
  const electron = findElectron();
  if (!electron) assert.fail('electron-absent');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-'));
  const ports = createWidgetPorts({ leases: new ProcessLeaseRegistry(500) });
  const ctx = context(root);
  try {
    await ports.scaffold(ctx);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'app', 'desktop-app.json'), 'utf8')) as { surface?: string };
    assert.equal(config.surface, 'widget');
    const main = fs.readFileSync(path.join(root, 'app', 'electron', 'main.cjs'), 'utf8');
    assert.equal(main.includes('setLoginItemSettings'), false);
    assert.match(main, /event\.preventDefault\(\)/);
    fs.writeFileSync(path.join(root, 'app', 'preview-close.txt'), 'close\n');
    const preview = await ports.preview(ctx);
    assert.equal(preview.kind, 'native');
    const probe = JSON.parse(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'window-ready.probe'), 'utf8')) as {
      width: number;
      height: number;
      alwaysOnTop: boolean;
      visible: boolean;
      visibleAfterClose: boolean;
      destroyed: boolean;
      requireType: string;
    };
    assert.equal(probe.width, 320);
    assert.equal(probe.height, 220);
    assert.equal(probe.alwaysOnTop, true);
    assert.equal(probe.visible, true);
    assert.equal(probe.visibleAfterClose, false);
    assert.equal(probe.destroyed, false);
    assert.equal(probe.requireType, 'undefined');
    assert.equal(fs.existsSync(path.join(root, 'app', 'preview-close.txt')), false);
    assert.equal(electronPids(root).length > 0, true);
    await ports.stop(ctx);
    await waitUntilGone(root);
  } finally {
    await ports.stop(ctx).catch(() => undefined);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
});

test('an expanded widget grows and the next launch keeps that size', async () => {
  const electron = findElectron();
  if (!electron) assert.fail('electron-absent');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-'));
  const ports = createWidgetPorts({ leases: new ProcessLeaseRegistry(500) });
  const ctx = context(root);
  try {
    await ports.scaffold(ctx);
    fs.writeFileSync(path.join(root, 'app', 'preview-expand.txt'), 'expand\n');
    await ports.preview(ctx);
    const probe = JSON.parse(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'window-ready.probe'), 'utf8')) as { width: number; height: number };
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'app', 'widget-window.json'), 'utf8')) as { expanded?: boolean };
    assert.equal(probe.width, 480);
    assert.equal(probe.height, 360);
    assert.equal(saved.expanded, true);
    assert.equal(fs.existsSync(path.join(root, 'app', 'preview-expand.txt')), false);
    await ports.stop(ctx);
    await waitUntilGone(root);
    await ports.preview(ctx);
    const restored = JSON.parse(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'window-ready.probe'), 'utf8')) as { width: number; height: number };
    assert.equal(restored.width, 480);
    assert.equal(restored.height, 360);
    await ports.stop(ctx);
    await waitUntilGone(root);
  } finally {
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a compact widget returns to the small frame and the next launch stays there', async () => {
  const electron = findElectron();
  if (!electron) assert.fail('electron-absent');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-'));
  const ports = createWidgetPorts({ leases: new ProcessLeaseRegistry(500) });
  const ctx = context(root);
  try {
    await ports.scaffold(ctx);
    fs.writeFileSync(path.join(root, 'app', 'preview-expand.txt'), 'expand\n');
    await ports.preview(ctx);
    const expanded = JSON.parse(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'window-ready.probe'), 'utf8')) as { width: number; height: number };
    assert.equal(expanded.width, 480);
    assert.equal(expanded.height, 360);
    await ports.stop(ctx);
    await waitUntilGone(root);
    fs.writeFileSync(path.join(root, 'app', 'preview-compact.txt'), 'compact\n');
    await ports.preview(ctx);
    const compact = JSON.parse(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'window-ready.probe'), 'utf8')) as { width: number; height: number };
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'app', 'widget-window.json'), 'utf8')) as { expanded?: boolean };
    assert.equal(compact.width, 320);
    assert.equal(compact.height, 220);
    assert.equal(saved.expanded, undefined);
    assert.equal(fs.existsSync(path.join(root, 'app', 'preview-compact.txt')), false);
    await ports.stop(ctx);
    await waitUntilGone(root);
    await ports.preview(ctx);
    const restored = JSON.parse(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'window-ready.probe'), 'utf8')) as { width: number; height: number };
    assert.equal(restored.width, 320);
    assert.equal(restored.height, 220);
    await ports.stop(ctx);
    await waitUntilGone(root);
  } finally {
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt widget position falls back, and the next launch keeps the clamped move', async () => {
  const electron = findElectron();
  if (!electron) assert.fail('electron-absent');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-'));
  const ports = createWidgetPorts({ leases: new ProcessLeaseRegistry(500) });
  const ctx = context(root);
  try {
    await ports.scaffold(ctx);
    fs.writeFileSync(path.join(root, 'app', 'widget-window.json'), '{');
    await ports.preview(ctx);
    const opened = readProbe(root);
    assert.equal(opened.x, opened.workArea.x);
    assert.equal(opened.y, opened.workArea.y);
    assert.equal(opened.saved, null);
    await ports.stop(ctx);
    await waitUntilGone(root);

    fs.writeFileSync(path.join(root, 'app', 'preview-move.txt'), `${JSON.stringify({ x: 3000, y: -200 })}\n`);
    fs.writeFileSync(path.join(root, 'app', 'preview-close.txt'), 'close\n');
    fs.writeFileSync(path.join(root, 'app', 'preview-show.txt'), 'show\n');
    await ports.preview(ctx);
    const moved = readProbe(root);
    const expected = clampPosition({ x: 3000, y: -200 }, moved.workArea);
    assert.deepEqual(moved.saved, expected);
    assert.equal(moved.visible, true);
    assert.equal(moved.visibleAfterClose, false);
    assert.equal(moved.visibleAfterShow, true);
    assert.equal(moved.destroyed, false);
    assert.equal(electronPids(root).length > 0, true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'app', 'widget-window.json'), 'utf8')) as { x: number; y: number };
    assert.deepEqual(onDisk, expected);
    await ports.stop(ctx);
    await waitUntilGone(root);

    await ports.preview(ctx);
    const restored = readProbe(root);
    assert.equal(restored.x, expected.x);
    assert.equal(restored.y, expected.y);
    assert.deepEqual(restored.saved, expected);
    await ports.stop(ctx);
    await waitUntilGone(root);
  } finally {
    await ports.stop(ctx).catch(() => undefined);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
});

function readProbe(workspace: string): {
  x: number;
  y: number;
  saved: { x: number; y: number } | null;
  workArea: { x: number; y: number; width: number; height: number };
  visible: boolean;
  visibleAfterClose: boolean;
  visibleAfterShow: boolean | null;
  destroyed: boolean;
} {
  return JSON.parse(fs.readFileSync(path.join(workspace, '.loam', 'build-menu', 'window-ready.probe'), 'utf8')) as {
    x: number;
    y: number;
    saved: { x: number; y: number } | null;
    workArea: { x: number; y: number; width: number; height: number };
    visible: boolean;
    visibleAfterClose: boolean;
    visibleAfterShow: boolean | null;
    destroyed: boolean;
  };
}

async function waitUntilGone(workspace: string): Promise<void> {
  let remaining = electronPids(workspace);
  for (let attempt = 0; attempt < 20 && remaining.length > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    remaining = electronPids(workspace);
  }
  assert.deepEqual(remaining, []);
}

function electronPids(workspace: string): number[] {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:LOAM_TEST_DIR) } | Select-Object -ExpandProperty ProcessId"], {
    env: { ...process.env, LOAM_TEST_DIR: workspace },
    encoding: 'utf8',
  });
  return output.split(/\s+/).map((item) => Number(item)).filter((pid) => Number.isInteger(pid) && pid > 0);
}

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'widget' };
  return {
    workspace,
    jobId: 'job_widget_window',
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_bcdfghjkmnpq',
      revision: 1,
      selection,
      title: 'تركيز',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'c'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}
