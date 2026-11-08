import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeUnpackedInstructions } from '../chrome/browser.js';
import { BuildMenuError } from '../grants.js';

const CLOSED = 'لم تُفتح نافذة Chrome.';
const TEMPORARY = 'هذه نافذة ملف شخصي مؤقت، وليست متصفح الحساب.';

function unsafe(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

function invalid(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'invalid_request' && error.status === 400;
}

function claimsLoaded(note: string): boolean {
  return /extension was loaded|loaded the extension|الإضافة محمّلة|تم تحميل/i.test(note)
    || /browser test ran|اختبار المتصفح/i.test(note)
    || /storage\.local was proven|storage\.local أثبت|أُثبت storage\.local/i.test(note)
    || note.includes('extensionLoaded')
    || note.includes('browserTestRan');
}

test('a closed chrome note does not say a temporary window opened', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-41-chrome-note-'));
  fs.mkdirSync(path.join(root, 'app'));
  try {
    const file = writeUnpackedInstructions(root, 'job_chrome_note', false);
    const closed = fs.readFileSync(file, 'utf8');
    assert.match(closed, /لم تُفتح نافذة Chrome\./);
    assert.equal(closed.includes(TEMPORARY), false);
    assert.equal(closed.includes('نافذة ملف شخصي مؤقت'), false);
    assert.match(closed, /فعّل وضع المطوّر ثم اختر Load unpacked/);
    assert.equal(claimsLoaded(closed), false);

    writeUnpackedInstructions(root, 'job_chrome_note', true);
    const opened = fs.readFileSync(file, 'utf8');
    assert.match(opened, /هذه نافذة ملف شخصي مؤقت، وليست متصفح الحساب\./);
    assert.equal(opened.includes(CLOSED), false);
    assert.match(opened, /Load unpacked/);
    assert.equal(claimsLoaded(opened), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a scheme or path separator in the job id or a workspace segment writes nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-41-chrome-scheme-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  const file = path.join(app, 'unpacked.txt');
  const seeded = `${CLOSED}\n`;
  fs.writeFileSync(file, seeded);
  const profile = path.join(root, '.loam');
  try {
    const schemeJobIds = [
      'job_https',
      'job_HTTPS',
      'job_javascript',
      'job_JavaScript',
      'job_mailto',
      'job_MAILTO',
      'job_note_https_1',
      'job_has_javascript',
      'job_x_mailto_y',
    ];
    for (const jobId of schemeJobIds) {
      assert.throws(() => writeUnpackedInstructions(root, jobId, false), unsafe, jobId);
      assert.throws(() => writeUnpackedInstructions(root, jobId, true), unsafe, jobId);
      assert.equal(fs.readFileSync(file, 'utf8'), seeded, jobId);
      assert.equal(fs.existsSync(profile), false, jobId);
    }

    const separatorJobIds = ['job_../out', 'job_a/b', 'job_a\\b', 'job_https/note', '..\\mailto'];
    for (const jobId of separatorJobIds) {
      assert.throws(() => writeUnpackedInstructions(root, jobId, false), invalid, jobId);
      assert.throws(() => writeUnpackedInstructions(root, jobId, true), invalid, jobId);
      assert.equal(fs.readFileSync(file, 'utf8'), seeded, jobId);
      assert.equal(fs.existsSync(profile), false, jobId);
    }

    const segmentNames = [
      'https',
      'javascript',
      'mailto',
      'HTTPS',
      'JavaScript',
      'MailTo',
      'dir-https',
      'javascript-dir',
      'pre-mailto-post',
    ];
    for (const name of segmentNames) {
      const nested = path.join(root, 'wrap', name, 'proj');
      fs.mkdirSync(path.join(nested, 'app'), { recursive: true });
      const nestedFile = path.join(nested, 'app', 'unpacked.txt');
      const nestedProfile = path.join(nested, '.loam');
      assert.throws(() => writeUnpackedInstructions(nested, 'job_chrome_note', false), unsafe, name);
      assert.throws(() => writeUnpackedInstructions(nested, 'job_chrome_note', true), unsafe, name);
      assert.equal(fs.existsSync(nestedFile), false, name);
      assert.equal(fs.existsSync(nestedProfile), false, name);
      const slashed = `${root}/wrap/${name}/proj`;
      assert.throws(() => writeUnpackedInstructions(slashed, 'job_chrome_note', false), unsafe, name);
      assert.equal(fs.existsSync(nestedFile), false, name);
    }

    const mixed = `${root}\\wrap\\foo/bar`;
    assert.throws(() => writeUnpackedInstructions(mixed, 'job_chrome_note', false), unsafe);
    assert.throws(() => writeUnpackedInstructions(mixed, 'job_chrome_note', true), unsafe);
    assert.equal(fs.existsSync(path.join(root, 'wrap', 'foo', 'bar', 'app', 'unpacked.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'wrap', 'foo', 'app', 'unpacked.txt')), false);
    assert.equal(fs.readFileSync(file, 'utf8'), seeded);
    assert.equal(seeded.includes(TEMPORARY), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
