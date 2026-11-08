import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { rememberWidget, planWidgetQuit, ownedStopArgs, writeWidgetNonce, readWidgetStartIdentity } = require('../widget/quitPlan.cjs') as {
  rememberWidget(dataDir: string, record: { pid: number; nonce: string; workspace: string; identity: string }): void;
  planWidgetQuit(dataDir: string, lookup: (pid: number) => string | null): { ask: boolean; pids: number[] };
  ownedStopArgs(pid: number): string[];
  writeWidgetNonce(workspace: string, nonce: string): void;
  readWidgetStartIdentity(pid: number): string | null;
};

function writeManifest(workspace: string, kind: string): void {
  const file = path.join(workspace, '.loam', 'build-menu', 'manifest.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const selection = kind === 'website' ? { kind, subtype: 'landing' } : { kind };
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    selection,
    consent: { autostart: false, publish: false },
  })}\n`);
}

test('closing asks only for a live widget with the same nonce and start identity', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-quit-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-app-'));
  const desktop = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-desktop-'));
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-missing-'));
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-widget-broken-'));
  try {
    const nonce = 'a'.repeat(32);
    writeManifest(workspace, 'widget');
    writeManifest(desktop, 'desktop');
    writeWidgetNonce(workspace, nonce);
    writeWidgetNonce(desktop, nonce);
    writeWidgetNonce(missing, nonce);
    writeWidgetNonce(broken, nonce);
    fs.mkdirSync(path.join(broken, '.loam', 'build-menu'), { recursive: true });
    fs.writeFileSync(path.join(broken, '.loam', 'build-menu', 'manifest.json'), '{');
    rememberWidget(dataDir, { pid: 4242, nonce, workspace, identity: '100' });
    rememberWidget(dataDir, { pid: 5252, nonce: 'b'.repeat(32), workspace, identity: '200' });
    rememberWidget(dataDir, { pid: 6262, nonce, workspace: desktop, identity: '300' });
    rememberWidget(dataDir, { pid: 7272, nonce, workspace: missing, identity: '400' });
    rememberWidget(dataDir, { pid: 8282, nonce, workspace: broken, identity: '500' });
    assert.throws(
      () => rememberWidget(dataDir, { pid: 9292, nonce, workspace, identity: 'reuse' }),
      /invalid_request/,
    );
    const same = (pid: number): string | null => {
      if (pid === 4242) return '100';
      if (pid === 5252) return '200';
      if (pid === 6262) return '300';
      if (pid === 7272) return '400';
      if (pid === 8282) return '500';
      return null;
    };
    const live = planWidgetQuit(dataDir, same);
    assert.equal(live.ask, true);
    assert.deepEqual(live.pids, [4242]);
    const again = planWidgetQuit(dataDir, same);
    assert.equal(again.ask, true);
    assert.deepEqual(again.pids, [4242]);
    const args = ownedStopArgs(4242);
    assert.deepEqual(args, ['/PID', '4242', '/T', '/F']);
    assert.equal(args.includes('/IM'), false);
    const saved = JSON.parse(fs.readFileSync(path.join(workspace, '.loam', 'build-menu', 'manifest.json'), 'utf8')) as {
      consent: { autostart: boolean };
    };
    assert.equal(saved.consent.autostart, false);
    writeWidgetNonce(workspace, 'c'.repeat(32));
    const foreign = planWidgetQuit(dataDir, () => '100');
    assert.equal(foreign.ask, false);
    assert.deepEqual(foreign.pids, []);
    writeWidgetNonce(workspace, nonce);
    rememberWidget(dataDir, { pid: 4242, nonce, workspace, identity: '100' });
    const reused = planWidgetQuit(dataDir, () => '999');
    assert.equal(reused.ask, false);
    assert.deepEqual(reused.pids, []);
    rememberWidget(dataDir, { pid: 4242, nonce, workspace, identity: '100' });
    const gone = planWidgetQuit(dataDir, () => null);
    assert.equal(gone.ask, false);
    assert.deepEqual(gone.pids, []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(desktop, { recursive: true, force: true });
    fs.rmSync(missing, { recursive: true, force: true });
    fs.rmSync(broken, { recursive: true, force: true });
  }
});

test('widget start identity is the live process start tick', () => {
  const first = readWidgetStartIdentity(process.pid);
  const second = readWidgetStartIdentity(process.pid);
  assert.equal(typeof first, 'string');
  assert.match(first ?? '', /^\d{1,32}$/);
  assert.equal(second, first);
  assert.equal(readWidgetStartIdentity(0), null);
});
