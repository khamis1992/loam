import assert from 'node:assert/strict';
import test from 'node:test';
import { installsPackage } from '../notebooks/installGuard.js';

test('installsPackage still refuses pip, conda, and uv installs', () => {
  assert.equal(installsPackage('pip install requests'), true);
  assert.equal(installsPackage('conda install numpy'), true);
  assert.equal(installsPackage('uv add ruff'), true);
});

test('installsPackage refuses a percent-encoded install command', () => {
  assert.equal(installsPackage('pip%20install'), true);
  assert.equal(installsPackage('pip%2520install'), true);
});

test('installsPackage refuses a quote-split install command', () => {
  assert.equal(installsPackage('"pip"+" install"'), true);
});

test('installsPackage allows a normal code cell', () => {
  assert.equal(installsPackage('print("loam")'), false);
});
