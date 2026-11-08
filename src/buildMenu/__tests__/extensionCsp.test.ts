import test from 'node:test';
import assert from 'node:assert/strict';
import { assertExtensionManifest } from '../chrome/permissions.js';

const manifest = {
  permissions: ['activeTab', 'storage'],
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
};

test('an extension page policy cannot add a remote script or eval', () => {
  assertExtensionManifest(manifest);
  assertExtensionManifest({ permissions: manifest.permissions });
  assert.throws(
    () => assertExtensionManifest({
      ...manifest,
      content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval' https://evil.example; object-src 'self'" },
    }),
    /permission_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({
      ...manifest,
      content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'", sandbox: 'allow-scripts' },
    }),
    /permission_requires_review/,
  );
});
