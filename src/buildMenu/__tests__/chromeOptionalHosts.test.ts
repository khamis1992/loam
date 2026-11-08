import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMinimalPermissions, extensionPermissionDigest } from '../chrome/permissions.js';

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

function refused(manifest: Record<string, unknown>, code: RegExp): void {
  let digest: string | undefined;
  assert.throws(() => {
    digest = extensionPermissionDigest(manifest);
  }, code);
  assert.equal(digest, undefined);
}

test('activeTab, scripting, and storage stay the only allowed permissions', () => {
  const manifest = base();
  assert.doesNotThrow(() => assertMinimalPermissions(['activeTab', 'scripting', 'storage'], []));
  assert.doesNotThrow(() => assertMinimalPermissions(['storage'], []));
  assert.throws(() => assertMinimalPermissions(['tabs'], []), /permission_requires_review/);
  assert.throws(() => assertMinimalPermissions(['cookies'], []), /permission_requires_review/);
  assert.throws(() => assertMinimalPermissions(['debugger'], []), /permission_requires_review/);
  assert.throws(() => assertMinimalPermissions(['nativeMessaging'], []), /permission_requires_review/);
  assert.throws(() => assertMinimalPermissions(['webRequest'], []), /permission_requires_review/);
  assert.throws(() => assertMinimalPermissions(['<all_urls>'], []), /permission_requires_review/);
  assert.throws(() => assertMinimalPermissions(['activeTab'], ['https://example.test/*']), /host_requires_review/);
  const digest = extensionPermissionDigest(manifest);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(
    extensionPermissionDigest({ ...manifest, permissions: ['storage', 'scripting', 'activeTab'] }),
    digest,
  );
  const quiet = extensionPermissionDigest({
    ...manifest,
    content_scripts: [{ js: ['popup.js'], css: ['popup.css'], matches: [], world: 'ISOLATED', match_about_blank: false, match_origin_as_fallback: false }],
    web_accessible_resources: [{ resources: ['popup.js'], matches: [], extension_ids: [] }],
  });
  assert.match(quiet, /^[a-f0-9]{64}$/);
  assert.notEqual(quiet, digest);
  for (const permission of ['tabs', 'cookies', 'debugger', 'nativeMessaging', 'webRequest', '<all_urls>', 'https://example.test/*', '*://*/*']) {
    refused({ ...manifest, permissions: [permission] }, /permission_requires_review/);
  }
});

test('host permissions, all_urls, external connect, and injection flags fail before a digest', () => {
  const manifest = base();
  const hosts = [
    ['<all_urls>'],
    ['https://example.test/*'],
    ['http://127.0.0.1/*'],
    ['*://*/*'],
    ['//example.test/*'],
  ];
  for (const host_permissions of hosts) {
    refused({ ...manifest, host_permissions }, /host_requires_review/);
  }
  refused({ ...manifest, permissions: ['<all_urls>'] }, /permission_requires_review/);
  refused({ ...manifest, permissions: ['activeTab', 'scripting', 'storage', 'https://example.test/*'] }, /permission_requires_review/);
  refused({ ...manifest, externally_connectable: { matches: ['https://example.test/*'] } }, /permission_requires_review/);
  refused({ ...manifest, externally_connectable: { matches: ['popup.html'] } }, /permission_requires_review/);
  refused({ ...manifest, externally_connectable: {} }, /permission_requires_review/);
  refused({ ...manifest, content_scripts: [{ js: ['popup.js'], world: 'MAIN' }] }, /permission_requires_review/);
  refused({ ...manifest, content_scripts: [{ js: ['popup.js'], match_about_blank: true }] }, /permission_requires_review/);
  refused({ ...manifest, content_scripts: [{ js: ['popup.js'], match_origin_as_fallback: true }] }, /permission_requires_review/);
  refused(
    { ...manifest, content_scripts: [{ world: 'MAIN', match_about_blank: true, match_origin_as_fallback: true }] },
    /permission_requires_review/,
  );
});

test('optional host permissions fail before a digest', () => {
  const manifest = base();
  const listed = [
    ['<all_urls>'],
    ['https://example.test/*'],
    ['http://example.test/*'],
    ['http://127.0.0.1/*'],
    ['*://*/*'],
    ['//example.test/*'],
    ['popup.html'],
    ['*'],
  ];
  for (const optional_host_permissions of listed) {
    refused({ ...manifest, optional_host_permissions }, /host_requires_review/);
  }
  refused({ ...manifest, optional_host_permissions: 'https://example.test/*' }, /host_requires_review/);
});

test('content script matches that contain a url fail before a digest', () => {
  const manifest = base();
  const listed = [
    ['https://example.test/*'],
    ['http://127.0.0.1/*'],
    ['<all_urls>'],
    ['*://*/*'],
    ['//example.test/*'],
    ['chrome-extension://abcdefghijklmnop/popup.html'],
    ['popup.html', 'https://example.test/*'],
    ['popup.js'],
    [''],
  ];
  for (const matches of listed) {
    refused({ ...manifest, content_scripts: [{ matches, js: ['popup.js'] }] }, /host_requires_review/);
  }
  refused({ ...manifest, content_scripts: [{ matches: 'https://example.test/*' }] }, /host_requires_review/);
  const empty = extensionPermissionDigest({ ...manifest, content_scripts: [{ matches: [], js: ['popup.js'] }] });
  assert.match(empty, /^[a-f0-9]{64}$/);
  const local = extensionPermissionDigest({ ...manifest, content_scripts: [{ matches: ['popup.html', 'a.html'], js: ['popup.js'] }] });
  assert.match(local, /^[a-f0-9]{64}$/);
  const omitted = extensionPermissionDigest({ ...manifest, content_scripts: [{ js: ['popup.js'] }] });
  assert.match(omitted, /^[a-f0-9]{64}$/);
});

test('web accessible resources that use all_urls or a remote match fail before a digest', () => {
  const manifest = base();
  const listed = [
    ['<all_urls>'],
    ['https://example.test/*'],
    ['http://example.test/*'],
    ['http://127.0.0.1/*'],
    ['*://*/*'],
    ['//cdn.example.test/*'],
    ['*'],
  ];
  for (const matches of listed) {
    refused(
      { ...manifest, web_accessible_resources: [{ resources: ['popup.js'], matches }] },
      /host_requires_review/,
    );
  }
  const local = extensionPermissionDigest({
    ...manifest,
    web_accessible_resources: [{ resources: ['popup.js'], matches: [], extension_ids: [] }],
  });
  assert.match(local, /^[a-f0-9]{64}$/);
});
