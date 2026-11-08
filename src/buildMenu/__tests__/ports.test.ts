import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { createAutomationsPorts } from '../automations/ports.js';
import { androidEnvironment } from '../../mobile/android/build.js';
import { createChromePorts } from '../chrome/ports.js';
import { createDesktopPorts } from '../desktop/ports.js';
import { createGamesPorts } from '../games/ports.js';
import { BuildMenuError } from '../grants.js';
import { createMobilePorts } from '../mobile/ports.js';
import { createNotebooksPorts } from '../notebooks/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { createSafariPorts } from '../safari/ports.js';
import { createWidgetPorts } from '../widget/ports.js';
import { findElectron } from '../toolchain.js';
import { createWebsitesPorts } from '../websites/ports.js';

function rootDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loam-ports-'));
}

function context(workspace: string, selection: BuildManifest['selection'], title = 'تجربة'): BuildJobContext {
  return {
    workspace,
    jobId: `job_${selection.kind}`,
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title,
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

test('website preview is the store page, and a missing dist is not a web zip', async () => {
  const root = rootDir();
  const leases = new ProcessLeaseRegistry(500);
  const ports = createWebsitesPorts({ leases });
  const ctx = context(root, { kind: 'website', subtype: 'store' });
  try {
    await ports.scaffold(ctx);
    const preview = await ports.preview(ctx);
    assert.equal(preview.kind, 'http');
    if (preview.kind !== 'http') return;
    assert.match(await (await fetch(preview.url)).text(), /متجر/);
    const artifact = await ports.export(ctx, 'source-zip');
    assert.ok(artifact.bytes > 0);
    const previewPage = path.join(root, 'app', 'preview.html');
    const previewBytes = fs.readFileSync(previewPage);
    fs.rmSync(previewPage);
    await assert.rejects(ports.export(ctx, 'web-zip'), (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement');
    assert.equal(fs.existsSync(path.join(root, 'app', 'dist', 'index.html')), false);
    const buildLog = fs.readFileSync(path.join(root, '.loam', 'build-menu', 'build.log'), 'utf8');
    assert.match(buildLog, /لم يبدأ بناء القالب/);
    assert.equal(/https?:\/\//i.test(buildLog), false);
    assert.equal(buildLog.includes(root), false);
    fs.writeFileSync(previewPage, previewBytes);
    const web = await ports.export(ctx, 'web-zip');
    assert.ok(web.bytes > 0);
    const built = fs.readFileSync(path.join(root, 'app', 'dist', 'index.html'), 'utf8');
    assert.match(built, /src="\.\/page\.js"/);
    assert.equal(built.includes('<script>'), false);
    assert.equal(/https?:\/\//i.test(built), false);
    await assert.rejects(ports.executeCell(ctx, 'cell-1'), /unsupported_operation/);
    await ports.stop(ctx);
    await assert.rejects(fetch(preview.url, { signal: AbortSignal.timeout(1_000) }));
  } finally {
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('automation dry-run starts no listener and refuses a send step', async () => {
  const root = rootDir();
  const leases = new ProcessLeaseRegistry(200);
  const ports = createAutomationsPorts({ leases });
  const ctx = context(root, { kind: 'automation' });
  try {
    await ports.scaffold(ctx);
    assert.deepEqual(await ports.preview(ctx), { kind: 'none' });
    assert.equal(leases.liveCount(), 0);
    const card = fs.readFileSync(path.join(root, 'app', 'preview.html'), 'utf8');
    assert.match(card, /ماذا: تقرير محلي/);
    assert.match(card, /الصلاحيات: تقرير محلي فقط/);
    assert.equal(card.includes('<script'), false);
    fs.writeFileSync(path.join(root, 'app', 'automation.json'), `${JSON.stringify({ send: true })}\n`);
    await assert.rejects(ports.preview(ctx), /tool_failed/);
    await ports.stop(ctx);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('desktop preview needs Electron, and a changed main starts no process', async () => {
  const root = rootDir();
  const leases = new ProcessLeaseRegistry(500);
  const ctx = context(root, { kind: 'desktop' });
  const missing = createDesktopPorts({ leases, electronExecutable: null });
  await missing.scaffold(ctx);
  await assert.rejects(missing.preview(ctx), (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement');
  assert.equal(leases.liveCount(), 0);
  if (findElectron() === null) {
    await assert.rejects(createDesktopPorts({ leases }).preview(ctx), /missing_requirement/);
  }
  const ports = createDesktopPorts({ leases, electronExecutable: process.execPath });
  const stub = 'const fs=require("node:fs");fs.writeFileSync(process.env.LOAM_PREVIEW_READY,String(process.pid));setInterval(()=>{},1000);\n';
  fs.writeFileSync(path.join(root, 'app', 'electron', 'main.cjs'), stub);
  try {
    await assert.rejects(ports.preview(ctx), (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request');
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'window-ready')), false);
    assert.equal(leases.liveCount(), 0);
  } finally {
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('notebook export is the notebook, and a cell does not run on the host', async () => {
  const root = rootDir();
  const leases = new ProcessLeaseRegistry(500);
  const ports = createNotebooksPorts({ leases });
  const ctx = context(root, { kind: 'notebook' });
  try {
    await ports.scaffold(ctx);
    const cell = { ...ctx, operation: { action: 'kernel-execute' as const, cellId: 'cell-1' } };
    await assert.rejects(ports.executeCell(cell, 'cell-1'), /missing_requirement/);
    assert.equal(leases.liveCount(), 0);
    const preview = await ports.preview(ctx);
    assert.equal(preview.kind, 'http');
    if (preview.kind !== 'http') return;
    assert.match(await (await fetch(preview.url)).text(), /nbformat/);
    const artifact = await ports.export(ctx, 'ipynb');
    assert.equal(artifact.format, 'ipynb');
    assert.match(fs.readFileSync(path.join(root, artifact.relativePath), 'utf8'), /nbformat/);
    await ports.stop(ctx);
  } finally {
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function containsExe(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (containsExe(child)) return true;
    } else if (item.name.toLowerCase().endsWith('.exe')) return true;
  }
  return false;
}

test('widget preview needs Electron, refuses another format, and writes no portable executable', async () => {
  const root = rootDir();
  const leases = new ProcessLeaseRegistry(500);
  const ctx = context(root, { kind: 'widget' });
  const missing = createWidgetPorts({ leases, electronExecutable: null });
  try {
    await missing.scaffold(ctx);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'app', 'desktop-app.json'), 'utf8')) as { surface?: string };
    assert.equal(config.surface, 'widget');
    const page = fs.readFileSync(path.join(root, 'app', 'dist', 'index.html'), 'utf8');
    assert.match(page, /id="countdown"/);
    assert.match(page, />300</);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'electron', 'main.cjs'), 'utf8').includes('setLoginItemSettings'), false);
    fs.mkdirSync(path.join(root, 'app', '.preview-data'));
    fs.writeFileSync(path.join(root, 'app', '.preview-data', 'secret.txt'), 'WIDGET_PREVIEW_SECRET');
    const artifact = await missing.export(ctx, 'source-zip');
    assert.ok(artifact.bytes > 0);
    const zip = fs.readFileSync(path.join(root, artifact.relativePath));
    assert.equal(zip.includes('WIDGET_PREVIEW_SECRET'), false);
    await assert.rejects(missing.export(ctx, 'web-zip'), (error: unknown) => error instanceof BuildMenuError && error.message === 'unsupported_format' && error.status === 400);
    await assert.rejects(missing.export(ctx, 'portable-exe'), (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement' && error.status === 400);
    assert.equal(containsExe(root), false);
    await assert.rejects(missing.preview(ctx), (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement');
    assert.equal(leases.liveCount(), 0);
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'window-ready')), false);
    fs.writeFileSync(path.join(root, 'app', 'electron', 'main.cjs'), 'process.exit(0)\n');
    const changed = createWidgetPorts({ leases, electronExecutable: process.execPath });
    await assert.rejects(changed.preview(ctx), (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request');
    assert.equal(leases.liveCount(), 0);
    await assert.rejects(missing.executeCell(ctx, 'cell-1'), /unsupported_operation/);
    await missing.stop(ctx);
    await missing.stop(ctx);
  } finally {
    await missing.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('game, mobile, chrome, and safari stay inside their real outputs', async () => {
  const leases = new ProcessLeaseRegistry(500);
  const gameRoot = rootDir();
  const mobileRoot = rootDir();
  const chromeRoot = rootDir();
  const safariRoot = rootDir();
  const game = createGamesPorts({ leases });
  const mobile = createMobilePorts({ leases });
  const chrome = createChromePorts({ leases, chromeExecutable: null });
  const safari = createSafariPorts({ leases });
  const gameCtx = context(gameRoot, { kind: 'game' });
  const mobileCtx = context(mobileRoot, { kind: 'mobile' });
  const chromeCtx = context(chromeRoot, { kind: 'chrome-extension' }, 'ملحق');
  const safariCtx = context(safariRoot, { kind: 'safari-extension' });
  try {
    await game.scaffold(gameCtx);
    const played = await game.preview(gameCtx);
    assert.equal(played.kind, 'http');
    if (played.kind === 'http') assert.match(await (await fetch(played.url)).text(), /<canvas/);
    assert.ok((await game.export(gameCtx, 'web-zip')).bytes > 0);
    await mobile.scaffold(mobileCtx);
    const frame = await mobile.preview(mobileCtx);
    assert.equal(frame.kind, 'http');
    if (frame.kind === 'http') assert.match(await (await fetch(frame.url)).text(), /دفتر/);
    if (!androidEnvironment().ready) await assert.rejects(mobile.export(mobileCtx, 'apk-debug'), /missing_requirement/);
    await chrome.scaffold(chromeCtx);
    const popup = await chrome.preview(chromeCtx);
    assert.equal(popup.kind, 'http');
    if (popup.kind === 'http') assert.match(await (await fetch(popup.url)).text(), /ملحق/);
    assert.ok((await chrome.export(chromeCtx, 'mv3-zip')).bytes > 0);
    await safari.scaffold(safariCtx);
    const expected = process.platform === 'darwin' ? /missing_requirement/ : /unsupported_platform/;
    await assert.rejects(safari.export(safariCtx, 'xcode-source'), expected);
  } finally {
    await game.stop(gameCtx).catch(() => undefined);
    await mobile.stop(mobileCtx).catch(() => undefined);
    await chrome.stop(chromeCtx).catch(() => undefined);
    await safari.stop(safariCtx).catch(() => undefined);
    for (const dir of [gameRoot, mobileRoot, chromeRoot, safariRoot]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
