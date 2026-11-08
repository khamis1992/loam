import test from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP_READY_MS, jobBudget, KERNEL_TIMEOUT_MS, PACKAGE_TIMEOUT_MS, previewReadyMs, WEB_READY_MS } from '../deadlines.js';

const PACKAGE_DEADLINE_MS = 15 * 60 * 1000;

test('web ready stays 30000', () => {
  assert.equal(WEB_READY_MS, 30_000);
  assert.equal(previewReadyMs('website'), WEB_READY_MS);
  assert.equal(jobBudget('website', 'preview'), WEB_READY_MS);
});

test('desktop ready stays 60000', () => {
  assert.equal(DESKTOP_READY_MS, 60_000);
  assert.equal(previewReadyMs('desktop'), DESKTOP_READY_MS);
  assert.equal(previewReadyMs('widget'), DESKTOP_READY_MS);
  assert.equal(jobBudget('desktop', 'preview'), DESKTOP_READY_MS);
});

test('package deadline stays 15 minutes', () => {
  assert.equal(PACKAGE_TIMEOUT_MS, PACKAGE_DEADLINE_MS);
  assert.equal(jobBudget('website', 'package'), PACKAGE_TIMEOUT_MS);
});

test('kernel cell deadline stays 30000', () => {
  assert.equal(KERNEL_TIMEOUT_MS, 30_000);
  assert.equal(jobBudget('notebook', 'kernel-execute'), KERNEL_TIMEOUT_MS);
});
