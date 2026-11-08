import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  approvedExtensionDigest,
  assertExtensionManifest,
  assertMinimalPermissions,
  extensionPermissionDigest,
  recordApprovedExtension,
} from '../chrome/permissions.js';

const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'chrome', 'permissions.ts');
const pagePolicy = "script-src 'self'; object-src 'self'";

function base(): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: 'ملاحظة',
    version: '0.1.0',
    action: { default_popup: 'popup.html' },
    permissions: ['activeTab', 'scripting', 'storage'],
    content_security_policy: { extension_pages: pagePolicy },
  };
}

function claimsProven(value: unknown): boolean {
  if (value === 'proven') return true;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => claimsProven(item));
  const record = value as Record<string, unknown>;
  if (record.storageLocalRealProfile === 'proven') return true;
  return Object.values(record).some((item) => claimsProven(item));
}

function refused(manifest: Record<string, unknown>, code: RegExp): void {
  let digest: string | undefined;
  assert.throws(() => {
    digest = extensionPermissionDigest(manifest);
  }, code);
  assert.equal(digest, undefined);
  assert.throws(() => assertExtensionManifest(manifest), code);
}

test('storage.local in a real profile stays unproven', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.equal(/['"]proven['"]/.test(source), false);
  assert.equal(/child_process|spawn\(|execFile|chrome\.exe|openIsolatedChrome|--load-extension/i.test(source), false);

  const manifest = base();
  assert.equal(assertMinimalPermissions(['activeTab', 'scripting', 'storage'], []), undefined);
  assert.equal(assertExtensionManifest(manifest), undefined);
  const digest = extensionPermissionDigest(manifest);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(claimsProven(digest), false);
  assert.equal(digest.includes('proven'), false);

  const hostile = { ...manifest, storageLocalRealProfile: 'proven' };
  const hostileDigest = extensionPermissionDigest(hostile);
  assert.match(hostileDigest, /^[a-f0-9]{64}$/);
  assert.equal(claimsProven(hostileDigest), false);
  assert.equal(hostileDigest.includes('proven'), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-chrome-storage-'));
  try {
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app', 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    const recorded = recordApprovedExtension(root);
    assert.equal(recorded, digest);
    assert.equal(claimsProven(recorded), false);
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'approved-extension.json'), 'utf8')) as unknown;
    assert.equal(claimsProven(saved), false);
    const approved = approvedExtensionDigest(root);
    assert.equal(approved, recorded);
    assert.equal(claimsProven(approved), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('host permissions, all_urls, externally_connectable, and injection flags stay refused', () => {
  const manifest = base();
  refused({ ...manifest, host_permissions: ['https://example.test/*'] }, /host_requires_review/);
  refused({ ...manifest, host_permissions: ['<all_urls>'] }, /host_requires_review/);
  refused({ ...manifest, optional_host_permissions: ['<all_urls>'] }, /host_requires_review/);
  refused({ ...manifest, permissions: ['<all_urls>'] }, /permission_requires_review/);
  refused({ ...manifest, permissions: ['activeTab', 'scripting', 'storage', '<all_urls>'] }, /permission_requires_review/);
  refused({ ...manifest, externally_connectable: { matches: ['https://example.test/*'] } }, /permission_requires_review/);
  refused({ ...manifest, externally_connectable: { matches: ['popup.html'] } }, /permission_requires_review/);
  refused({ ...manifest, externally_connectable: {} }, /permission_requires_review/);
  refused(
    { ...manifest, content_scripts: [{ matches: ['popup.html'], js: ['popup.js'], world: 'MAIN' }] },
    /permission_requires_review/,
  );
  refused(
    { ...manifest, content_scripts: [{ matches: ['popup.html'], js: ['popup.js'], match_about_blank: true }] },
    /permission_requires_review/,
  );
  refused(
    { ...manifest, content_scripts: [{ matches: ['popup.html'], js: ['popup.js'], match_origin_as_fallback: true }] },
    /permission_requires_review/,
  );
  refused(
    {
      ...manifest,
      content_scripts: [{
        matches: ['popup.html'],
        js: ['popup.js'],
        world: 'MAIN',
        match_about_blank: true,
        match_origin_as_fallback: true,
      }],
    },
    /permission_requires_review/,
  );
});
