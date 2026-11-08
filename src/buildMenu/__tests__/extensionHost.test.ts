import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertExtensionManifest, extensionPermissionDigest, recordApprovedExtension } from '../chrome/permissions.js';
import { extensionFiles } from '../extensions/source.js';

const pagePolicy = "script-src 'self'; object-src 'self'";

function generated(): Record<string, unknown> {
  const file = extensionFiles('ملاحظة').find((entry) => entry.path === 'manifest.json');
  return JSON.parse(file?.content ?? '{}') as Record<string, unknown>;
}

test('the generated manifest with a local page policy still passes', () => {
  const manifest = generated();
  assert.deepEqual(manifest.content_security_policy, { extension_pages: pagePolicy });
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assertExtensionManifest(manifest);
  const digest = extensionPermissionDigest(manifest);
  assert.equal(extensionPermissionDigest(structuredClone(manifest)), digest);
  assert.equal(
    extensionPermissionDigest({ ...manifest, permissions: ['storage', 'scripting', 'activeTab'] }),
    extensionPermissionDigest({ ...manifest, permissions: ['activeTab', 'scripting', 'storage'] }),
  );
});

test('omitted optional host keys stay allowed', () => {
  const manifest = {
    permissions: ['activeTab', 'scripting', 'storage'],
    content_security_policy: { extension_pages: pagePolicy },
  };
  assertExtensionManifest(manifest);
  assertExtensionManifest({ ...manifest, optional_permissions: [], optional_host_permissions: [] });
  assert.equal(
    extensionPermissionDigest(manifest),
    extensionPermissionDigest({ ...manifest, optional_permissions: [], optional_host_permissions: [] }),
  );
  assertExtensionManifest({ ...manifest, content_scripts: [{ js: ['popup.js'] }] });
  assertExtensionManifest({ ...manifest, content_scripts: [{ matches: ['popup.html'], js: ['popup.js'] }] });
  assertExtensionManifest({ ...manifest, content_scripts: [{ matches: ['a.html', 'b.html'] }] });
});

test('external connect, optional hosts, web matches, and url permissions are refused', () => {
  const manifest = generated();
  const clean = extensionPermissionDigest(manifest);
  assert.throws(
    () => assertExtensionManifest({ ...manifest, externally_connectable: { matches: ['https://example.test/*'] } }),
    /permission_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...manifest, externally_connectable: { matches: ['popup.html'] } }),
    /permission_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...manifest, optional_host_permissions: ['<all_urls>'] }),
    /host_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...manifest, optional_host_permissions: ['https://example.test/*'] }),
    /host_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...manifest, optional_host_permissions: ['popup.html'] }),
    /host_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...manifest, content_scripts: [{ matches: ['https://example.test/*'] }] }),
    /host_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...manifest, content_scripts: [{ matches: ['<all_urls>'] }] }),
    /host_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...manifest, content_scripts: [{ matches: ['*://*/*'] }] }),
    /host_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...manifest, content_scripts: [{ matches: ['chrome-extension://abcdefghijklmnop/popup.html'] }] }),
    /host_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...manifest, content_scripts: [{ matches: ['popup.js'] }] }),
    /host_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...manifest, content_scripts: [{ matches: ['popup.html', 'https://example.test/*'] }] }),
    /host_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...manifest, permissions: ['activeTab', 'https://example.test/*'] }),
    /permission_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...manifest, permissions: ['*://*/*'] }),
    /permission_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...manifest, permissions: ['<all_urls>'] }),
    /permission_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...manifest, optional_permissions: ['http://127.0.0.1/*'] }),
    /permission_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...manifest, content_scripts: [{ matches: ['popup.html'], js: ['https://example.test/a.js'] }] }),
    /permission_requires_review/,
  );
  const refused = [
    { ...manifest, externally_connectable: { ids: ['*'] } },
    { ...manifest, optional_host_permissions: ['*://*/*'] },
    { ...manifest, content_scripts: [{ matches: ['https://example.test/*'], js: ['popup.js'] }] },
    { ...manifest, permissions: ['activeTab', 'scripting', 'storage', 'https://example.test/*'] },
  ];
  for (const broken of refused) {
    assert.throws(() => extensionPermissionDigest(broken), /permission_requires_review|host_requires_review/);
  }
  const localScripts = extensionPermissionDigest({
    ...manifest,
    content_scripts: [{ matches: ['b.html', 'a.html'], js: ['popup.js'] }],
  });
  assert.notEqual(localScripts, clean);
  assert.equal(
    localScripts,
    extensionPermissionDigest({
      ...manifest,
      content_scripts: [{ matches: ['a.html', 'b.html'], js: ['popup.js'] }],
    }),
  );
  assert.notEqual(
    localScripts,
    extensionPermissionDigest({
      ...manifest,
      content_scripts: [{ matches: ['popup.html'], js: ['popup.js'] }],
    }),
  );
});

test('a generated manifest that asks for a host or all_urls fails before a digest', () => {
  const manifest = generated();
  const clean = extensionPermissionDigest(manifest);
  assert.match(clean, /^[a-f0-9]{64}$/);
  assert.throws(() => extensionPermissionDigest({ ...manifest, permissions: ['<all_urls>'] }), /permission_requires_review/);
  assert.throws(() => extensionPermissionDigest({ ...manifest, host_permissions: ['<all_urls>'] }), /host_requires_review/);
  assert.throws(() => extensionPermissionDigest({ ...manifest, host_permissions: ['https://example.test/*'] }), /host_requires_review/);
  const asking = [
    { ...manifest, content_scripts: [{ matches: ['popup.html'], exclude_matches: ['<all_urls>'], js: ['popup.js'] }] },
    { ...manifest, content_scripts: [{ exclude_matches: ['https://example.test/*'], js: ['popup.js'] }] },
    { ...manifest, content_scripts: [{ matches: ['popup.html'], include_globs: ['https://*/*'], js: ['popup.js'] }] },
    { ...manifest, content_scripts: [{ matches: ['popup.html'], exclude_globs: ['*://*/*'], js: ['popup.js'] }] },
    { ...manifest, web_accessible_resources: [{ resources: ['popup.js'], extension_ids: ['<all_urls>'] }] },
    { ...manifest, web_accessible_resources: [{ resources: ['popup.js'], extension_ids: ['*'] }] },
    { ...manifest, update_url: 'https://example.test/updates.xml' },
    { ...manifest, update_url: 'updates.xml' },
    { ...manifest, chrome_settings_overrides: { homepage: 'https://example.test/' } },
    { ...manifest, chrome_settings_overrides: { startup_pages: ['<all_urls>'] } },
    { ...manifest, protocol_handlers: [{ protocol: 'web+loam', default_url: 'https://example.test/?u=%s' }] },
    { ...manifest, browser_specific_settings: { gecko: { update_url: 'https://example.test/updates.json' } } },
    { ...manifest, action: { default_popup: 'https://example.test/popup.html' } },
    { ...manifest, action: { default_popup: '<all_urls>' } },
    { ...manifest, options_ui: { page: 'https://example.test/options.html' } },
    { ...manifest, options_page: '<all_urls>' },
    { ...manifest, side_panel: { default_path: 'https://example.test/side.html' } },
    { ...manifest, description: '<all_urls>' },
  ];
  for (const broken of asking) {
    let digest: string | undefined;
    assert.throws(() => {
      digest = extensionPermissionDigest(broken);
    }, /host_requires_review/);
    assert.equal(digest, undefined);
  }
  const local = extensionPermissionDigest({
    ...manifest,
    action: { default_popup: 'popup.html' },
    options_ui: { page: 'options.html' },
    content_scripts: [{ matches: ['b.html', 'a.html'], exclude_matches: ['c.html'], js: ['popup.js'] }],
    web_accessible_resources: [{ resources: ['popup.js'], matches: [], extension_ids: [] }],
  });
  assert.match(local, /^[a-f0-9]{64}$/);
  assert.notEqual(local, clean);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-chrome-host-'));
  try {
    fs.mkdirSync(path.join(root, 'app'));
    const hostile = { ...manifest, content_scripts: [{ matches: ['<all_urls>'], js: ['popup.js'] }] };
    fs.writeFileSync(path.join(root, 'app', 'manifest.json'), `${JSON.stringify(hostile)}\n`);
    assert.throws(() => recordApprovedExtension(root), /host_requires_review/);
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'approved-extension.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('main world and blank-origin content scripts are refused before approval', () => {
  const manifest = generated();
  const limited = {
    permissions: ['activeTab', 'scripting', 'storage'],
    action: { default_popup: 'popup.html' },
    content_security_policy: { extension_pages: pagePolicy },
  };
  const digest = extensionPermissionDigest(limited);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(extensionPermissionDigest(manifest), extensionPermissionDigest({ ...limited, manifest_version: 3, name: manifest.name, version: manifest.version }));
  const local = {
    ...limited,
    content_scripts: [{ matches: ['popup.html'], js: ['popup.js'], world: 'ISOLATED', match_about_blank: false, match_origin_as_fallback: false }],
  };
  assert.match(extensionPermissionDigest(local), /^[a-f0-9]{64}$/);
  const refused = [
    { ...limited, content_scripts: [{ matches: ['popup.html'], js: ['popup.js'], world: 'MAIN' }] },
    { ...limited, content_scripts: [{ matches: ['popup.html'], js: ['popup.js'], match_about_blank: true }] },
    { ...limited, content_scripts: [{ matches: ['popup.html'], js: ['popup.js'], match_origin_as_fallback: true }] },
    { ...limited, content_scripts: [{ world: 'MAIN', match_about_blank: true, match_origin_as_fallback: true }] },
  ];
  for (const broken of refused) {
    let approved: string | undefined;
    assert.throws(() => {
      approved = extensionPermissionDigest(broken);
    }, /permission_requires_review/);
    assert.equal(approved, undefined);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-chrome-world-'));
  const approval = path.join(root, '.loam', 'build-menu', 'approved-extension.json');
  try {
    fs.mkdirSync(path.join(root, 'app'));
    for (const hostile of refused) {
      fs.writeFileSync(path.join(root, 'app', 'manifest.json'), `${JSON.stringify(hostile)}\n`);
      assert.throws(() => recordApprovedExtension(root), /permission_requires_review/);
      assert.equal(fs.existsSync(approval), false);
    }
    fs.writeFileSync(path.join(root, 'app', 'manifest.json'), `${JSON.stringify(limited)}\n`);
    const recorded = recordApprovedExtension(root);
    assert.equal(recorded, digest);
    assert.equal(fs.existsSync(approval), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
