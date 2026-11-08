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

const REUSED_PID = 424242;
const IMAGE_PID = 626262;
const LIVE_PID = 525252;
const REUSED_IDENTITY = '638400000000000001';
const LIVE_IDENTITY = '638400000000000002';
const IMAGE_IDENTITY = '638400000000000003';

function writeManifest(workspace: string): void {
  const file = path.join(workspace, '.loam', 'build-menu', 'manifest.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    selection: { kind: 'widget' },
    consent: { autostart: false, publish: false },
  })}\n`);
}

test('planWidgetQuit drops a start identity the reader does not confirm', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-quit-id-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-quit-app-'));
  try {
    const nonce = 'd'.repeat(32);
    writeManifest(workspace);
    writeWidgetNonce(workspace, nonce);
    rememberWidget(dataDir, { pid: REUSED_PID, nonce, workspace, identity: REUSED_IDENTITY });
    rememberWidget(dataDir, { pid: IMAGE_PID, nonce, workspace, identity: IMAGE_IDENTITY });
    rememberWidget(dataDir, { pid: LIVE_PID, nonce, workspace, identity: LIVE_IDENTITY });

    const reader = (pid: number): string | null => {
      if (pid === REUSED_PID) return '638400000000000099';
      if (pid === IMAGE_PID) return 'loam-widget.exe';
      if (pid === LIVE_PID) return LIVE_IDENTITY;
      return null;
    };
    const plan = planWidgetQuit(dataDir, reader);

    assert.equal(plan.ask, true);
    assert.deepEqual(plan.pids, [LIVE_PID]);
    assert.equal(plan.pids.includes(REUSED_PID), false);
    assert.equal(plan.pids.includes(IMAGE_PID), false);

    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'build-menu-widgets.json'), 'utf8')) as Array<{
      pid: number;
      identity: string;
    }>;
    assert.deepEqual(saved.map((row) => row.pid), [LIVE_PID]);
    assert.equal(saved[0]?.identity, LIVE_IDENTITY);
    assert.match(saved[0]?.identity ?? '', /^\d{1,32}$/);

    const args = ownedStopArgs(LIVE_PID);
    assert.deepEqual(args, ['/PID', String(LIVE_PID), '/T', '/F']);
    assert.equal(args.includes('/IM'), false);

    const manifest = JSON.parse(fs.readFileSync(path.join(workspace, '.loam', 'build-menu', 'manifest.json'), 'utf8')) as {
      consent: { autostart: boolean };
    };
    assert.equal(manifest.consent.autostart, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
