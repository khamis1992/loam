import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeUnpackedInstructions } from '../chrome/browser.js';
import { chromeManualLoad } from '../chrome/manualLoad.js';
import { BuildMenuError } from '../grants.js';

function unsafe(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'EPERM';
}

function assertManual(): void {
  const handoff = chromeManualLoad();
  assert.equal(handoff.loadUnpacked, 'manual');
  assert.equal(handoff.extensionLoaded, false);
  assert.equal(handoff.browserTestRan, false);
}

function claimsLoaded(note: string): boolean {
  return /extension was loaded|loaded the extension|الإضافة محمّلة|تم تحميل/i.test(note)
    || /browser test ran|اختبار المتصفح/i.test(note)
    || note.includes('extensionLoaded')
    || note.includes('browserTestRan');
}

test('an existing note with nlink greater than 1 is refused before write', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-46-chrome-nlink-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-46-chrome-nlink-out-'));
  const file = path.join(root, 'app', 'unpacked.txt');
  const outsideFile = path.join(outside, 'secret.txt');
  const previous = Buffer.from('outside-note-bytes');
  fs.mkdirSync(path.join(root, 'app'));
  try {
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    assert.throws(() => writeUnpackedInstructions(root, 'job_chrome_note', false), unsafe);
    assert.throws(() => writeUnpackedInstructions(root, 'job_chrome_note', true), unsafe);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(outsideFile).nlink > 1, true);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assertManual();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a new note still writes and chrome load stays manual', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-46-chrome-new-'));
  const file = path.join(root, 'app', 'unpacked.txt');
  fs.mkdirSync(path.join(root, 'app'));
  try {
    assert.equal(fs.existsSync(file), false);
    const written = writeUnpackedInstructions(root, 'job_chrome_note', false);
    assert.equal(written, file);
    const created = fs.lstatSync(file);
    assert.equal(created.isSymbolicLink(), false);
    assert.equal(created.isFile(), true);
    assert.equal(created.nlink, 1);
    const closed = fs.readFileSync(file, 'utf8');
    assert.match(closed, /لم تُفتح نافذة Chrome\./);
    assert.equal(claimsLoaded(closed), false);
    assertManual();

    writeUnpackedInstructions(root, 'job_chrome_note', true);
    const replaced = fs.lstatSync(file);
    assert.equal(replaced.isSymbolicLink(), false);
    assert.equal(replaced.isFile(), true);
    assert.equal(replaced.nlink, 1);
    const opened = fs.readFileSync(file, 'utf8');
    assert.match(opened, /هذه نافذة ملف شخصي مؤقت، وليست متصفح الحساب\./);
    assert.equal(claimsLoaded(opened), false);
    assertManual();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lstat EPERM is not swallowed before the note write', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-46-chrome-eperm-'));
  const file = path.join(root, 'app', 'unpacked.txt');
  const previous = Buffer.from('existing-note-bytes');
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(file, previous);
  const realLstatSync = fs.lstatSync;
  const resolved = path.resolve(file);
  fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (path.resolve(String(target)) === resolved) {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    return realLstatSync(target, options);
  }) as typeof fs.lstatSync;
  try {
    assert.equal(realLstatSync(file).nlink, 1);
    assert.throws(() => writeUnpackedInstructions(root, 'job_chrome_note', false), isEperm);
    assert.throws(() => writeUnpackedInstructions(root, 'job_chrome_note', true), isEperm);
    assert.equal(realLstatSync(file).nlink, 1);
    assert.equal(realLstatSync(file).isSymbolicLink(), false);
    assert.equal(realLstatSync(file).isFile(), true);
    assert.deepEqual(fs.readFileSync(file), previous);
    assertManual();
  } finally {
    fs.lstatSync = realLstatSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
