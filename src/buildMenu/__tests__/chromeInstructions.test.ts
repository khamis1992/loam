import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromePreviewSummary, writeUnpackedInstructions } from '../chrome/browser.js';
import { chromeManualLoad } from '../chrome/manualLoad.js';
import { BuildMenuError } from '../grants.js';

test('chrome instructions stay inside the project and hide its path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-chrome-note-'));
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'secret');
  fs.mkdirSync(path.join(root, 'app'));
  try {
    assert.throws(
      () => writeUnpackedInstructions(root, 'job_../out', false),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request',
    );
    assert.equal(fs.existsSync(path.join(root, 'out')), false);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'secret');
    const file = writeUnpackedInstructions(root, 'job_chrome_note', false);
    assert.equal(path.basename(file), 'unpacked.txt');
    const note = chromePreviewSummary(root, 'http://127.0.0.1:9/');
    assert.equal(note.includes(root), false);
    assert.equal(note.includes('http://'), false);
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.throws(
      () => writeUnpackedInstructions(root, 'job_chrome_note', false),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path',
    );
    assert.equal(fs.statSync(file).isDirectory(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unopened chrome instructions do not claim a temporary profile window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-chrome-unopened-'));
  fs.mkdirSync(path.join(root, 'app'));
  const temporaryWindow = 'هذه نافذة ملف شخصي مؤقت، وليست متصفح الحساب.';
  try {
    const file = writeUnpackedInstructions(root, 'job_chrome_unopened', false);
    const closed = fs.readFileSync(file, 'utf8');
    assert.match(closed, /لم تُفتح نافذة Chrome\./);
    assert.equal(closed.includes(temporaryWindow), false);
    assert.match(closed, /فعّل وضع المطوّر ثم اختر Load unpacked/);
    assert.equal(/extension was loaded|loaded the extension|الإضافة محمّلة|تم تحميل/i.test(closed), false);
    assert.equal(/browser test ran|اختبار المتصفح/i.test(closed), false);
    assert.equal(/storage\.local was proven|storage\.local أثبت|أُثبت storage\.local/i.test(closed), false);
    assert.equal(closed.includes('extensionLoaded'), false);
    assert.equal(closed.includes('browserTestRan'), false);
    const handoff = chromeManualLoad();
    assert.equal(handoff.loadUnpacked, 'manual');
    assert.equal(handoff.extensionLoaded, false);
    assert.equal(handoff.browserTestRan, false);
    assert.equal(handoff.storageLocalRealProfile, 'unproven');

    writeUnpackedInstructions(root, 'job_chrome_unopened', true);
    const opened = fs.readFileSync(file, 'utf8');
    assert.match(opened, /هذه نافذة ملف شخصي مؤقت، وليست متصفح الحساب\./);
    assert.equal(opened.includes('لم تُفتح نافذة Chrome'), false);
    assert.match(opened, /Load unpacked/);
    assert.equal(/storage\.local was proven|storage\.local أثبت/i.test(opened), false);
    assert.equal(opened.includes('extensionLoaded'), false);
    assert.equal(opened.includes('browserTestRan'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
