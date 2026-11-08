import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachPreviewNonce } from '../previewNonce.js';

test('a preview url keeps the lease nonce and a local page does not', () => {
  const nonce = 'ab'.repeat(16);
  const withUrl = attachPreviewNonce({ summary: 'http://127.0.0.1:9/', previewUrl: 'http://127.0.0.1:9/' }, nonce);
  assert.equal(withUrl.previewNonce, nonce);
  assert.throws(() => attachPreviewNonce({ previewUrl: 'http://127.0.0.1:9/' }, 'spawn'), /invalid_request/);
  const local = attachPreviewNonce({ summary: 'page', previewHtml: '<p></p>' }, nonce);
  assert.equal(local.previewNonce, undefined);
  const server = fs.readFileSync(new URL('../serverPorts.ts', import.meta.url), 'utf8');
  assert.match(server, /attachPreviewNonce\(\{ summary: chromePreviewSummary\([\s\S]*\}, lease\.messageNonce\)/);
  assert.match(server, /return attachPreviewNonce\(\{ summary: lease\.url, previewUrl: lease\.url \}, lease\.messageNonce\)/);
  const lease = fs.readFileSync(new URL('../processLease.ts', import.meta.url), 'utf8');
  assert.match(lease, /startedAt: Date\.now\(\)/);
  assert.match(lease, /messageNonce: randomBytes\(16\)\.toString\('hex'\)/);
  assert.equal(lease.includes('input.pid'), false);
  const legacy = fs.readFileSync(new URL('../../mobile/export.ts', import.meta.url), 'utf8');
  assert.match(legacy, /loam-mobile-sandbox/);
  assert.match(legacy, /parent\.postMessage\([\s\S]*'\*'\)/);
  const bridge = fs.readFileSync(new URL('../../../packages/web/src/components/build/previewBridge.ts', import.meta.url), 'utf8');
  assert.equal(/postMessage\([\s\S]*['"]\*['"]\)/.test(bridge), false);
  assert.equal(bridge.includes('loam-mobile-sandbox'), false);
  assert.equal(bridge.includes('exportMobile'), false);
});
