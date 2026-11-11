import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromePreviewSummary, writeUnpackedInstructions } from '../chrome/browser.js';
import { chromeManualLoad } from '../chrome/manualLoad.js';
import { BuildMenuError } from '../grants.js';

const PREVIEW_URL = 'http://127.0.0.1:9/';

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

function withoutNoteRead(file: string, run: () => void): void {
  const realReadFileSync = fs.readFileSync;
  const resolved = path.resolve(file);
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (typeof target !== 'number' && path.resolve(String(target)) === resolved) {
      throw new Error('note_read');
    }
    return realReadFileSync(target, options);
  }) as typeof fs.readFileSync;
  try {
    run();
  } finally {
    fs.readFileSync = realReadFileSync;
  }
}

test('an unpacked note with nlink greater than 1 is refused before read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-chrome-read-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-chrome-read-out-'));
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
    let summary: string | undefined;
    withoutNoteRead(file, () => {
      assert.throws(() => {
        summary = chromePreviewSummary(root, PREVIEW_URL);
      }, unsafe);
    });
    assert.equal(summary, undefined);
    assert.throws(() => writeUnpackedInstructions(root, 'job_chrome_note', false), unsafe);
    assert.throws(() => writeUnpackedInstructions(root, 'job_chrome_note', true), unsafe);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(outsideFile).nlink > 1, true);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.equal(fs.readFileSync(file, 'utf8').includes('outside-note-bytes'), true);
    assertManual();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a regular nlink 1 note still reads and chrome load stays manual', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-chrome-read-new-'));
  const file = path.join(root, 'app', 'unpacked.txt');
  fs.mkdirSync(path.join(root, 'app'));
  try {
    const written = writeUnpackedInstructions(root, 'job_chrome_note', false);
    assert.equal(written, file);
    const created = fs.lstatSync(file);
    assert.equal(created.isSymbolicLink(), false);
    assert.equal(created.isFile(), true);
    assert.equal(created.nlink, 1);
    const summary = chromePreviewSummary(root, PREVIEW_URL);
    assert.match(summary, /لم تُفتح نافذة Chrome/);
    assert.match(summary, /Load unpacked/);
    assert.equal(summary.includes('http://'), false);
    assert.equal(summary.includes('outside-note-bytes'), false);
    assert.equal(claimsLoaded(summary), false);
    assertManual();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lstat EPERM is not swallowed before the note read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-chrome-read-eperm-'));
  const file = path.join(root, 'app', 'unpacked.txt');
  const previous = Buffer.from('regular-note-bytes');
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(file, previous);
  const realLstatSync = fs.lstatSync;
  const resolved = path.resolve(file);
  Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (path.resolve(String(target)) === resolved) {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    return realLstatSync(target, options);
  }) as typeof fs.lstatSync });
  try {
    assert.equal(realLstatSync(file).nlink, 1);
    let summary: string | undefined;
    withoutNoteRead(file, () => {
      assert.throws(() => {
        summary = chromePreviewSummary(root, PREVIEW_URL);
      }, isEperm);
    });
    assert.equal(summary, undefined);
    assert.equal(realLstatSync(file).nlink, 1);
    assert.equal(realLstatSync(file).isSymbolicLink(), false);
    assert.equal(realLstatSync(file).isFile(), true);
    assert.deepEqual(fs.readFileSync(file), previous);
    assertManual();
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the note reader does not launch Chrome and the writer still checks nlink', () => {
  const source = fs.readFileSync(new URL('../chrome/browser.ts', import.meta.url), 'utf8');
  const writeStart = source.indexOf('export function writeUnpackedInstructions');
  const readStart = source.indexOf('export function chromePreviewSummary');
  const openStart = source.indexOf('export async function openIsolatedChrome');
  assert.ok(writeStart >= 0 && readStart > writeStart && openStart > readStart);
  const writeBody = source.slice(writeStart, readStart);
  const readBody = source.slice(readStart, openStart);
  const writeNlink = writeBody.indexOf('stat.nlink > 1');
  const writeFile = writeBody.indexOf('writeFileSync');
  assert.ok(writeNlink >= 0 && writeNlink < writeFile);
  const readNlink = readBody.indexOf('stat.nlink > 1');
  const readFile = readBody.indexOf('readFileSync');
  assert.ok(readNlink >= 0 && readNlink < readFile);
  assert.equal(readBody.includes('catch'), false);
  assert.equal(readBody.includes('EPERM'), false);
  assert.equal(readBody.includes('symlinkSync'), false);
  assert.equal(readBody.includes('junction'), false);
  assert.equal(/spawn\(|execFile|chrome\.exe|openIsolatedChrome|--load-extension/.test(readBody), false);
  assertManual();
});
