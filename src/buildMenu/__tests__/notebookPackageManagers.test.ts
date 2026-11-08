import assert from 'node:assert/strict';
import test from 'node:test';
import { installsPackage } from '../notebooks/installGuard.js';

test('installsPackage refuses npm, pnpm, yarn, and bun installs', () => {
  assert.equal(installsPackage('npm install lodash'), true);
  assert.equal(installsPackage('pnpm add lodash'), true);
  assert.equal(installsPackage('yarn add lodash'), true);
  assert.equal(installsPackage('bun add lodash'), true);
});

test('installsPackage refuses a percent-encoded package-manager command', () => {
  assert.equal(installsPackage('npm%20install'), true);
  assert.equal(installsPackage('pnpm%20add'), true);
  assert.equal(installsPackage('yarn%20add'), true);
  assert.equal(installsPackage('bun%20add'), true);
  assert.equal(installsPackage('npm%2520install'), true);
  assert.equal(installsPackage('pnpm%2520add'), true);
  assert.equal(installsPackage('yarn%2520add'), true);
  assert.equal(installsPackage('bun%2520add'), true);
});

test('installsPackage refuses a quote-split package-manager command', () => {
  assert.equal(installsPackage('"npm"+" install"'), true);
  assert.equal(installsPackage('"pnpm"+" add"'), true);
  assert.equal(installsPackage('"yarn"+" add"'), true);
  assert.equal(installsPackage('"bun"+" add"'), true);
});

test('installsPackage allows a normal code cell and import', () => {
  assert.equal(installsPackage('print("loam")'), false);
  assert.equal(installsPackage('import os'), false);
});
