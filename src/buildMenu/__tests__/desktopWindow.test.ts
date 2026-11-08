import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { createDesktopPorts } from '../desktop/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { findElectron } from '../toolchain.js';

test('a real Electron window opens from the project and closes with the preview', async () => {
  const electron = findElectron();
  if (!electron) {
    assert.fail('electron-absent');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-electron-'));
  const ports = createDesktopPorts({ leases: new ProcessLeaseRegistry(500) });
  const ctx = context(root);
  try {
    await ports.scaffold(ctx);
    const main = fs.readFileSync(path.join(root, 'app', 'electron', 'main.cjs'), 'utf8');
    assert.match(main, /contextIsolation:\s*true/);
    assert.match(main, /nodeIntegration:\s*false/);
    assert.match(main, /sandbox:\s*true/);
    assert.equal(main.includes('setLoginItemSettings'), false);
    const page = fs.readFileSync(path.join(root, 'app', 'dist', 'index.html'), 'utf8');
    assert.match(page, /ملاحظة محلية/);
    assert.equal(/https?:\/\//i.test(page), false);
    fs.writeFileSync(path.join(root, 'app', 'preview-input.txt'), 'تذكرة\n');
    const preview = await ports.preview(ctx);
    assert.equal(preview.kind, 'native');
    const ready = fs.readFileSync(path.join(root, '.loam', 'build-menu', 'window-ready'), 'utf8');
    assert.match(ready, /^[a-f0-9]{32}\n$/);
    assert.equal(fs.existsSync(path.join(root, 'app', '.preview-data')), true);
    assert.equal(fs.existsSync(path.join(root, 'app', 'preview-input.txt')), false);
    const typed = readProbe(root);
    assert.equal(typed.requireType, 'undefined');
    assert.equal(typed.processType, 'undefined');
    assert.equal(typed.note, 'تذكرة');
    assert.equal(typed.dir, 'rtl');
    const pids = electronPids(root);
    assert.equal(pids.length > 0, true);
    await ports.stop(ctx);
    await waitUntilGone(root);
    const restoredPreview = await ports.preview(ctx);
    assert.equal(restoredPreview.kind, 'native');
    const restored = readProbe(root);
    assert.equal(restored.note, 'تذكرة');
    assert.equal(restored.requireType, 'undefined');
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

function readProbe(workspace: string): { requireType: string; processType: string; note: string | null; dir: string | null } {
  return JSON.parse(fs.readFileSync(path.join(workspace, '.loam', 'build-menu', 'window-ready.probe'), 'utf8')) as {
    requireType: string;
    processType: string;
    note: string | null;
    dir: string | null;
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
  const selection: BuildManifest['selection'] = { kind: 'desktop' };
  return {
    workspace,
    jobId: 'job_desktop_window',
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_bcdfghjkmnpq',
      revision: 1,
      selection,
      title: 'ملاحظة',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'b'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}
