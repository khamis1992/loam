import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { buildWebsiteBundle, unsafeWebsitePreview } from '../websites/bundle.js';
import { configureWebsiteLock } from '../websites/hostCommand.js';
import { websiteDocument } from '../websites/page.js';
import { createWebsitesPorts } from '../websites/ports.js';

test('a website archive rejects a protocol-relative script and keeps the previous zip', async () => {
  configureWebsiteLock(null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-web-remote-'));
  const ports = createWebsitesPorts({ leases: new ProcessLeaseRegistry(200) });
  const ctx = context(root);
  try {
    for (const subtype of ['landing', 'store', 'booking', 'chatbot'] as const) {
      assert.equal(unsafeWebsitePreview(websiteDocument('متجر', subtype)), false);
    }
    await ports.scaffold(ctx);
    const artifact = await ports.export(ctx, 'web-zip');
    const zipPath = path.join(root, artifact.relativePath);
    const bytes = fs.readFileSync(zipPath);
    const indexPath = path.join(root, 'app', 'dist', 'index.html');
    assert.equal(fs.readFileSync(indexPath, 'utf8').includes('src="//'), false);
    fs.writeFileSync(indexPath, '<script src="//evil.example/a.js"></script><script src="./page.js"></script>');
    await assert.rejects(ports.export(ctx, 'web-zip'), (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path');
    assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
    fs.rmSync(path.join(root, 'app', 'dist'), { recursive: true, force: true });
    fs.appendFileSync(path.join(root, 'app', 'preview.html'), '<script src="//evil.example/a.js"></script>');
    await assert.rejects(ports.export(ctx, 'web-zip'), (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path');
    assert.equal(fs.existsSync(indexPath), false);
    assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
  } finally {
    configureWebsiteLock(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a website bundle refuses a dist file or a page.js directory', async () => {
  configureWebsiteLock(null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-web-dist-type-'));
  const ports = createWebsitesPorts({ leases: new ProcessLeaseRegistry(200) });
  const ctx = context(root);
  try {
    await ports.scaffold(ctx);
    buildWebsiteBundle(root);
    assert.equal(fs.statSync(path.join(root, 'app', 'dist', 'page.js')).isFile(), true);
    assert.equal(fs.statSync(path.join(root, 'app', 'dist', 'index.html')).isFile(), true);
    const dist = path.join(root, 'app', 'dist');
    fs.rmSync(dist, { recursive: true, force: true });
    const kept = Buffer.from('keep-dist');
    fs.writeFileSync(dist, kept);
    assert.throws(
      () => buildWebsiteBundle(root),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.readFileSync(dist).equals(kept), true);
    fs.rmSync(dist);
    const pageJs = path.join(dist, 'page.js');
    fs.mkdirSync(pageJs, { recursive: true });
    const marker = path.join(pageJs, 'marker.txt');
    const markerBytes = Buffer.from('marker');
    fs.writeFileSync(marker, markerBytes);
    assert.throws(
      () => buildWebsiteBundle(root),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.existsSync(path.join(dist, 'index.html')), false);
    assert.equal(fs.readFileSync(marker).equals(markerBytes), true);
  } finally {
    configureWebsiteLock(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'website', subtype: 'store' };
  return {
    workspace,
    jobId: 'job_website_remote',
    operation: { action: 'package', format: 'web-zip' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_bcdfghjkmnpq',
      revision: 3,
      selection,
      title: 'متجر',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'e'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}
