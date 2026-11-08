import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { createWebsitesPorts } from '../websites/ports.js';
import { assertFrozenWebsiteTemplate } from '../websites/templateLock.js';

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'website', subtype: 'landing' };
  return {
    workspace,
    jobId: 'job_website_lock',
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'موقع',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

test('a changed website package script or vite config is refused before a process starts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-web-lock-'));
  const ports = createWebsitesPorts({ leases: new ProcessLeaseRegistry(200) });
  const ctx = context(root);
  try {
    await ports.scaffold(ctx);
    assertFrozenWebsiteTemplate(root);
    const pkgPath = path.join(root, 'app', 'package.json');
    const original = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(original) as { scripts: Record<string, string> };
    parsed.scripts.preinstall = 'node evil.js';
    fs.writeFileSync(pkgPath, JSON.stringify(parsed));
    await assert.rejects(
      ports.preview(ctx),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request',
    );
    await assert.rejects(
      ports.export(ctx, 'web-zip'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request',
    );
    assert.equal(fs.existsSync(path.join(root, 'app', 'dist', 'index.html')), false);
    fs.writeFileSync(pkgPath, original);
    fs.appendFileSync(path.join(root, 'app', 'vite.config.ts'), '\n');
    await assert.rejects(
      ports.preview(ctx),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request',
    );
  } finally {
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
