import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeManualLoad } from '../chrome/manualLoad.js';

const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'chrome', 'manualLoad.ts');

test('chrome handoff keeps load-unpacked manual and does not claim a load', () => {
  const handoff = chromeManualLoad();
  assert.deepEqual(handoff, {
    loadUnpacked: 'manual',
    extensionLoaded: false,
    browserTestRan: false,
    ignoredFlagsMean: 'browser-test-did-not-run',
    storageLocalRealProfile: 'unproven',
    lines: [
      'Load unpacked is manual.',
      'Ignored flags mean the browser test did not run.',
      'storage.local in a real profile is unproven.',
    ],
  });
  assert.equal(chromeManualLoad(), handoff);
  const text = handoff.lines.join('\n');
  assert.match(text, /Load unpacked is manual\./);
  assert.match(text, /Ignored flags mean the browser test did not run\./);
  assert.match(text, /storage\.local in a real profile is unproven\./);
  assert.equal(/extension was loaded|loaded the extension|extension loaded/i.test(text), false);
  assert.equal(/تم تحميل|الإضافة محمّلة/.test(text), false);
  assert.equal(JSON.stringify(handoff).includes('"extensionLoaded":true'), false);
});

test('the chrome handoff module does not launch a browser', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.equal(/child_process|spawn|execFile|findChrome|openIsolatedChrome|chrome\.exe|--load-extension|remote-debugging/i.test(source), false);
  assert.equal(/extension was loaded|loaded the extension/i.test(source), false);
  assert.equal(chromeManualLoad().browserTestRan, false);
});
