import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ownedStopArgs } = require('../widget/quitPlan.cjs') as {
  ownedStopArgs(pid: number): string[];
};

const productMain = fileURLToPath(new URL('../../../electron/main.cjs', import.meta.url));

function beforeQuitRegion(source: string): string {
  const start = source.indexOf('app.on("before-quit"');
  assert.ok(start >= 0, 'product electron/main.cjs has a before-quit handler');
  return source.slice(start);
}

function dialogLiteral(region: string): string {
  const start = region.indexOf('dialog.showMessageBoxSync({');
  assert.ok(start >= 0, 'before-quit asks with showMessageBoxSync');
  const end = region.indexOf('});', start);
  assert.ok(end > start, 'before-quit dialog literal is closed');
  return region.slice(start, end);
}

test('product before-quit asks in Arabic and stops Windows widgets by pid', () => {
  const parts = productMain.split(path.sep);
  assert.equal(parts.at(-1), 'main.cjs');
  assert.equal(parts.at(-2), 'electron');
  assert.equal(parts.includes('templates'), false);

  const source = fs.readFileSync(productMain, 'utf8');
  const region = beforeQuitRegion(source);
  const dialog = dialogLiteral(region);

  assert.match(dialog, /type:\s*"question"/);
  assert.match(dialog, /buttons:\s*\["اترك الويدجت يعمل", "أنهِ الويدجت"\]/);
  assert.match(dialog, /cancelId:\s*0/);
  assert.match(dialog, /defaultId:\s*0/);
  assert.equal(dialog.match(/message:\s*"([^"]*)"/)?.[1], 'ويدجت مستقل ما زال يعمل.');

  const stop = region.slice(region.indexOf('if (answer === 1)'));
  assert.match(stop, /process\.platform === "win32"/);
  assert.match(stop, /spawn\(killer, ownedStopArgs\(pid\), \{ shell: false/);
  assert.equal(stop.includes('/IM'), false);
  assert.equal(stop.includes('chrome.exe'), false);

  const pid = 424242;
  const args = ownedStopArgs(pid);
  assert.deepEqual(args, ['/PID', String(pid), '/T', '/F']);
  assert.equal(args.join(' '), `/PID ${pid} /T /F`);
});
