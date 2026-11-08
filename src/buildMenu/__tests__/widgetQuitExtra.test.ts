import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { rememberWidget, planWidgetQuit, ownedStopArgs, writeWidgetNonce } = require('../widget/quitPlan.cjs') as {
  rememberWidget(dataDir: string, record: { pid: number; nonce: string; workspace: string; identity: string }): void;
  planWidgetQuit(dataDir: string, lookup: (pid: number) => string | null): { ask: boolean; pids: number[] };
  ownedStopArgs(pid: number): string[];
  writeWidgetNonce(workspace: string, nonce: string): void;
};

const QUIT_IDENTITY = /^\d{1,32}$/;
const LIVE_PID = 525301;
const IMAGE_PID = 525302;
const EMPTY_PID = 525303;
const LONG_PID = 525304;
const PLANTED_IMAGE_PID = 525305;
const PLANTED_EMPTY_PID = 525306;
const PLANTED_LONG_PID = 525307;
const LIVE_IDENTITY = '6'.repeat(32);
const IMAGE_NAME = 'chrome.exe';
const EMPTY_IDENTITY = '';
const LONG_IDENTITY = '8'.repeat(33);

function writeManifest(workspace: string): void {
  const file = path.join(workspace, '.loam', 'build-menu', 'manifest.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    selection: { kind: 'widget' },
    consent: { autostart: false, publish: false },
  })}\n`);
}

test('planWidgetQuit drops chrome.exe, empty, and 33-digit quit identities', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-quit-extra-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-quit-extra-app-'));
  try {
    const nonce = 'e'.repeat(32);
    writeManifest(workspace);
    writeWidgetNonce(workspace, nonce);
    assert.match(LIVE_IDENTITY, QUIT_IDENTITY);
    assert.equal(QUIT_IDENTITY.test(IMAGE_NAME), false);
    assert.equal(QUIT_IDENTITY.test(EMPTY_IDENTITY), false);
    assert.equal(QUIT_IDENTITY.test(LONG_IDENTITY), false);

    for (const identity of [IMAGE_NAME, EMPTY_IDENTITY, LONG_IDENTITY]) {
      assert.throws(
        () => rememberWidget(dataDir, { pid: 525399, nonce, workspace, identity }),
        /invalid_request/,
      );
    }

    rememberWidget(dataDir, { pid: LIVE_PID, nonce, workspace, identity: LIVE_IDENTITY });
    rememberWidget(dataDir, { pid: IMAGE_PID, nonce, workspace, identity: '2'.repeat(32) });
    rememberWidget(dataDir, { pid: EMPTY_PID, nonce, workspace, identity: '3'.repeat(32) });
    rememberWidget(dataDir, { pid: LONG_PID, nonce, workspace, identity: '4'.repeat(32) });

    const registry = path.join(dataDir, 'build-menu-widgets.json');
    const planted = JSON.parse(fs.readFileSync(registry, 'utf8')) as Array<{
      pid: number;
      nonce: string;
      workspace: string;
      identity: string;
    }>;
    planted.push(
      { pid: PLANTED_IMAGE_PID, nonce, workspace, identity: IMAGE_NAME },
      { pid: PLANTED_EMPTY_PID, nonce, workspace, identity: EMPTY_IDENTITY },
      { pid: PLANTED_LONG_PID, nonce, workspace, identity: LONG_IDENTITY },
    );
    fs.writeFileSync(registry, `${JSON.stringify(planted)}\n`);

    const reader = (pid: number): string | null => {
      if (pid === IMAGE_PID || pid === PLANTED_IMAGE_PID) return IMAGE_NAME;
      if (pid === EMPTY_PID || pid === PLANTED_EMPTY_PID) return EMPTY_IDENTITY;
      if (pid === LONG_PID || pid === PLANTED_LONG_PID) return LONG_IDENTITY;
      if (pid === LIVE_PID) return LIVE_IDENTITY;
      return null;
    };
    const plan = planWidgetQuit(dataDir, reader);
    const dropped = [IMAGE_PID, EMPTY_PID, LONG_PID, PLANTED_IMAGE_PID, PLANTED_EMPTY_PID, PLANTED_LONG_PID];

    assert.equal(plan.ask, true);
    assert.deepEqual(plan.pids, [LIVE_PID]);
    for (const pid of dropped) {
      assert.equal(plan.pids.includes(pid), false);
    }

    const saved = JSON.parse(fs.readFileSync(registry, 'utf8')) as Array<{
      pid: number;
      identity: string;
    }>;
    assert.deepEqual(saved.map((row) => row.pid), [LIVE_PID]);
    assert.equal(saved[0]?.identity, LIVE_IDENTITY);
    assert.match(saved[0]?.identity ?? '', QUIT_IDENTITY);
    for (const row of saved) {
      assert.match(row.identity, QUIT_IDENTITY);
    }

    const args = ownedStopArgs(LIVE_PID);
    assert.deepEqual(args, ['/PID', String(LIVE_PID), '/T', '/F']);
    assert.equal(args.includes('/IM'), false);
    assert.equal(args.includes(IMAGE_NAME), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
