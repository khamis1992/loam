import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { materialize } from '../materialize.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { currentConversion } from '../safari/platform.js';
import { createSafariPorts } from '../safari/ports.js';

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'safari-extension' };
  return {
    workspace,
    jobId: 'job_safari_handoff',
    operation: { action: 'package', format: 'source-zip' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'ملاحظة',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'b'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

test('a safari source zip cannot claim the extension was tested', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-safari-handoff-'));
  const ports = createSafariPorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'safari-extension' }, workspace: root, title: 'ملاحظة' });
    const first = await ports.export(context(root), 'source-zip');
    const bytes = fs.readFileSync(path.join(root, first.relativePath));
    const file = path.join(root, 'app', 'conversion.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { conversion: string; safariTested: boolean };
    stored.safariTested = true;
    fs.writeFileSync(file, `${JSON.stringify(stored)}\n`);
    await assert.rejects(
      ports.export(context(root), 'source-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request' && error.status === 400,
    );
    stored.safariTested = false;
    stored.conversion = 'convertible';
    fs.writeFileSync(file, `${JSON.stringify(stored)}\n`);
    if (process.platform !== 'darwin') {
      await assert.rejects(
        ports.export(context(root), 'source-zip'),
        (error: unknown) => error instanceof BuildMenuError && error.message === 'unsupported_platform' && error.status === 400,
      );
    }
    assert.equal(fs.readFileSync(path.join(root, first.relativePath)).equals(bytes), true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).safariTested, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a safari source zip cannot claim Xcode ran or replace the shared script', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-safari-claim-'));
  const ports = createSafariPorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'safari-extension' }, workspace: root, title: 'ملاحظة' });
    const first = await ports.export(context(root), 'source-zip');
    const zipPath = path.join(root, first.relativePath);
    const bytes = fs.readFileSync(zipPath);
    const file = path.join(root, 'app', 'conversion.json');
    const original = fs.readFileSync(file, 'utf8');
    const stored = JSON.parse(original) as { conversion: string; platform: string; safariTested: boolean; xcodeRan?: boolean };
    assert.equal(stored.safariTested, false);
    assert.equal(stored.conversion, currentConversion());
    if (process.platform !== 'darwin') assert.equal(stored.conversion, 'source-only');
    stored.xcodeRan = true;
    fs.writeFileSync(file, `${JSON.stringify(stored)}\n`);
    await assert.rejects(
      ports.export(context(root), 'source-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request' && error.status === 400,
    );
    assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
    fs.writeFileSync(file, original);
    const script = path.join(root, 'app', 'popup.js');
    const shared = fs.readFileSync(script, 'utf8');
    fs.writeFileSync(script, "document.querySelector('#result').textContent = 'تم اختبار Safari';\n");
    await assert.rejects(
      ports.export(context(root), 'source-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request' && error.status === 400,
    );
    assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
    fs.writeFileSync(script, shared);
    if (process.platform !== 'darwin') {
      await assert.rejects(
        ports.export(context(root), 'xcode-source'),
        (error: unknown) => error instanceof BuildMenuError && error.message === 'unsupported_platform' && error.status === 400,
      );
    }
    const again = JSON.parse(fs.readFileSync(file, 'utf8')) as { conversion: string; safariTested: boolean };
    assert.equal(again.safariTested, false);
    assert.equal(again.conversion, currentConversion());
    assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a safari source zip refuses a popup.html directory before reading it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-safari-popup-dir-'));
  const ports = createSafariPorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'safari-extension' }, workspace: root, title: 'ملاحظة' });
    const first = await ports.export(context(root), 'source-zip');
    const zipPath = path.join(root, first.relativePath);
    const bytes = fs.readFileSync(zipPath);
    const file = path.join(root, 'app', 'conversion.json');
    const original = fs.readFileSync(file);
    const stored = JSON.parse(original.toString('utf8')) as { conversion: string; platform: string; safariTested: boolean };
    assert.equal(stored.safariTested, false);
    assert.equal(stored.conversion, currentConversion());
    if (process.platform !== 'darwin') assert.equal(stored.conversion, 'source-only');
    const popup = path.join(root, 'app', 'popup.html');
    fs.rmSync(popup);
    fs.mkdirSync(popup);
    const marker = path.join(popup, 'marker.txt');
    const markerBytes = Buffer.from('marker');
    fs.writeFileSync(marker, markerBytes);
    await assert.rejects(
      ports.export(context(root), 'source-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.lstatSync(popup).isDirectory(), true);
    assert.equal(fs.lstatSync(popup).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(marker).equals(markerBytes), true);
    assert.equal(fs.readFileSync(file).equals(original), true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).safariTested, false);
    assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
