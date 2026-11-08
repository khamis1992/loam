import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  configureWebsiteDevStarter,
  configureWebsiteHostRunner,
  configureWebsiteLock,
  currentWebsiteDevStarter,
  currentWebsiteHostRunner,
  websiteHostReady,
} from '../websites/hostCommand.js';

const APPROVED = 'a'.repeat(64);

test('approved website host runner and dev starter start null and a null lock keeps them', () => {
  assert.equal(currentWebsiteHostRunner(), null);
  assert.equal(currentWebsiteDevStarter(), null);
  assert.equal(websiteHostReady(), false);

  const source = fs.readFileSync(path.join('src', 'buildMenu', 'websites', 'hostCommand.ts'), 'utf8');
  assert.equal(source.includes('node:child_process'), false);
  assert.equal(source.includes('child_process'), false);
  assert.equal(source.includes('spawn('), false);
  assert.equal(source.includes('execFile'), false);
  assert.equal(source.includes('spawnSync'), false);

  let hostCalls = 0;
  let devCalls = 0;
  const runner = (): Promise<number> => {
    hostCalls += 1;
    return Promise.resolve(0);
  };
  const starter = (): Promise<{ stop: () => Promise<void> }> => {
    devCalls += 1;
    return Promise.resolve({ stop: () => Promise.resolve() });
  };

  try {
    configureWebsiteHostRunner(runner);
    configureWebsiteDevStarter(starter);
    configureWebsiteLock(null);
    assert.equal(currentWebsiteHostRunner(), runner);
    assert.equal(currentWebsiteDevStarter(), starter);
    assert.equal(websiteHostReady(), false);

    configureWebsiteLock(APPROVED);
    assert.equal(websiteHostReady(), true);
    configureWebsiteLock(null);
    assert.equal(websiteHostReady(), false);
    assert.equal(currentWebsiteHostRunner(), runner);
    assert.equal(currentWebsiteDevStarter(), starter);
    assert.equal(hostCalls, 0);
    assert.equal(devCalls, 0);
  } finally {
    configureWebsiteHostRunner(null);
    configureWebsiteDevStarter(null);
    configureWebsiteLock(null);
  }
});
