import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPreviewNonce } from '../previewNonce.js';

const nonce = 'ab'.repeat(16);
const loopback = 'http://127.0.0.1:9/';

test('attachPreviewNonce leaves a result unchanged, rejects a bad nonce, and attaches only with a preview url', () => {
  const bare = { summary: 'page', previewHtml: '<p></p>' };
  assert.equal(attachPreviewNonce(bare, nonce), bare);
  assert.equal(attachPreviewNonce(bare, 'spawn'), bare);
  assert.deepEqual(bare, { summary: 'page', previewHtml: '<p></p>' });
  assert.equal('previewUrl' in bare, false);
  assert.equal('previewNonce' in bare, false);

  const blank = { summary: 'page', previewUrl: '' };
  assert.equal(attachPreviewNonce(blank, nonce), blank);

  const preview = { summary: 'loopback', previewUrl: loopback };
  const rejected = ['spawn', 'AB'.repeat(16), 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), `${nonce} `, ` ${nonce}`];
  for (const bad of rejected) {
    assert.throws(() => attachPreviewNonce(preview, bad), /invalid_request/, bad);
  }
  assert.deepEqual(preview, { summary: 'loopback', previewUrl: loopback });
  assert.equal('previewNonce' in preview, false);

  const attached = attachPreviewNonce(preview, nonce);
  assert.deepEqual(attached, { summary: 'loopback', previewUrl: loopback, previewNonce: nonce });
  assert.equal(attached.previewUrl, loopback);
  assert.equal(JSON.stringify(attached).includes('https://'), false);
  assert.equal(JSON.stringify(bare).includes('http'), false);
});
