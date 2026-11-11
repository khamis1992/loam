import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { materialize } from '../materialize.js';
import { desktopPreviewScript } from '../desktop/previewPage.js';

const require = createRequire(import.meta.url);
const notes = require('../../templates/electron-app/electron/notes.cjs') as {
  MAX_NOTES_BYTES: number;
  loadNotes: (root: string) => string;
  saveNotes: (root: string, text: string) => string;
  registerNotes: (root: string, ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => void }) => void;
};

test('desktop notes load and save stay in one file and stop at 64KB', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notes-'));
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  try {
    notes.registerNotes(root, { handle: (name, fn) => handlers.set(name, fn) });
    assert.deepEqual([...handlers.keys()].sort(), ['notes:load', 'notes:save']);
    assert.equal(notes.MAX_NOTES_BYTES, 64 * 1024);
    assert.equal(notes.loadNotes(root), '');
    const exact = 'n'.repeat(notes.MAX_NOTES_BYTES);
    assert.equal(notes.saveNotes(root, exact), exact);
    assert.equal(notes.loadNotes(root), exact);
    assert.throws(() => notes.saveNotes(root, `${exact}x`), (error: unknown) => error instanceof Error && error.message === 'notes_too_large');
    assert.equal(notes.loadNotes(root), exact);
    assert.throws(() => notes.saveNotes(root, 12 as unknown as string), (error: unknown) => error instanceof Error && error.message === 'invalid_request');
    const save = handlers.get('notes:save');
    assert.equal(save?.({}, 'مرحبًا', 'C:\\outside\\secret.txt'), 'مرحبًا');
    assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'مرحبًا');
    assert.equal(fs.readdirSync(root).filter((name) => name !== 'notes.txt').length, 0);
    fs.rmSync(path.join(root, 'notes.txt'));
    fs.mkdirSync(path.join(root, 'notes.txt'));
    assert.throws(() => notes.saveNotes(root, 'text'), (error: unknown) => error instanceof Error && error.message === 'unsafe_path');
    const source = fs.readFileSync(new URL('../../templates/electron-app/electron/notes.cjs', import.meta.url), 'utf8');
    const notesPreload = fs.readFileSync(new URL('../../templates/electron-app/electron/notes-preload.cjs', import.meta.url), 'utf8');
    const packPreload = fs.readFileSync(new URL('../../templates/electron-app/electron/preload.cjs', import.meta.url), 'utf8');
    const main = fs.readFileSync(new URL('../../templates/electron-app/electron/main.cjs', import.meta.url), 'utf8');
    const store = fs.readFileSync(new URL('../../templates/electron-app/electron/store.cjs', import.meta.url), 'utf8');
    assert.equal(source.includes('child_process'), false);
    assert.equal(source.includes('shell'), false);
    assert.equal(notesPreload.includes('child_process'), false);
    assert.equal(notesPreload.includes('__apis'), false);
    assert.equal(notesPreload.includes('vault:'), false);
    assert.equal(notesPreload.includes('files:'), false);
    assert.equal(notesPreload.includes('habits:'), false);
    assert.equal(notesPreload.includes('markdown:'), false);
    assert.equal(notesPreload.includes('photos:'), false);
    assert.equal(notesPreload.includes('auth.getToken'), false);
    assert.equal(notesPreload.includes('system.readFile'), false);
    assert.deepEqual(notesPreload.match(/invoke\('([^']+)'/g), ["invoke('notes:load'", "invoke('notes:save'"]);
    assert.equal(packPreload.includes('notes:load'), false);
    assert.equal(packPreload.includes('__apis'), false);
    assert.match(main, /nodeIntegration: false/);
    assert.match(main, /contextIsolation: true/);
    assert.match(main, /sandbox: true/);
    assert.match(main, /const notesOnly = config\.ipc === 'notes'/);
    assert.match(main, /notesOnly \? 'notes-preload\.cjs' : 'preload\.cjs'/);
    assert.equal(main.includes('__apis'), false);
    assert.match(store, /if \(config && config\.ipc === 'notes'\) \{\s*registerNotes\(path\.join\(__dirname, '\.\.\/notes'\), ipcMain\);\s*return \{ notes: true \};/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a generated desktop window saves through the notes bridge and a widget keeps its own preload', () => {
  const desktop = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notes-desktop-'));
  const widget = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notes-widget-'));
  try {
    materialize({ selection: { kind: 'desktop' }, workspace: desktop, title: 'مكتب' });
    materialize({ selection: { kind: 'widget' }, workspace: widget, title: 'ويدجت' });
    const desktopConfig = JSON.parse(fs.readFileSync(path.join(desktop, 'app', 'desktop-app.json'), 'utf8')) as { ipc?: string; surface?: string };
    const widgetConfig = JSON.parse(fs.readFileSync(path.join(widget, 'app', 'desktop-app.json'), 'utf8')) as { ipc?: string; surface?: string };
    assert.equal(desktopConfig.ipc, 'notes');
    assert.equal(desktopConfig.surface, undefined);
    assert.equal(widgetConfig.ipc, undefined);
    assert.equal(widgetConfig.surface, 'widget');
    const saved: string[] = [];
    const storage = new Map<string, string>();
    const note = { value: '' };
    const error = { hidden: true, textContent: '' };
    const exported = { hidden: true, value: '' };
    const empty = { hidden: true };
    let onInput: (() => void) | undefined;
    const document = {
      querySelector(selector: string) {
        switch (selector) {
          case '#note': return note;
          case '#save-error': return error;
          case '#export': return exported;
          case '#empty': return empty;
          default: return null;
        }
      },
      addEventListener() {},
    };
    Object.defineProperty(note, 'addEventListener', { value(_type: string, fn: () => void) { onInput = fn; } });
    vm.runInNewContext(desktopPreviewScript(), {
      document,
      Promise,
      desktop: {
        loadNotes: () => Promise.resolve(''),
        saveNotes: (text: string) => {
          saved.push(text);
          return Promise.resolve(text);
        },
      },
      localStorage: {
        getItem: () => { throw new Error('storage'); },
        setItem: () => { storage.set('used', 'yes'); },
      },
    });
    note.value = 'ملاحظة';
    onInput?.();
    assert.deepEqual(saved, ['ملاحظة']);
    assert.equal(storage.size, 0);
    note.value = 'ن'.repeat(65537);
    onInput?.();
    assert.deepEqual(saved, ['ملاحظة']);
    assert.equal(error.hidden, false);
  } finally {
    fs.rmSync(desktop, { recursive: true, force: true });
    fs.rmSync(widget, { recursive: true, force: true });
  }
});

test('saving notes through a symlink fails and leaves the previous file unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notes-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notes-outside-'));
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  try {
    notes.registerNotes(root, { handle: (name, fn) => handlers.set(name, fn) });
    assert.deepEqual([...handlers.keys()].sort(), ['notes:load', 'notes:save']);
    const save = handlers.get('notes:save');
    const notesFile = path.join(root, 'notes.txt');
    const linked = path.join(outside, 'notes.txt');
    fs.writeFileSync(linked, 'previous');
    fs.symlinkSync(linked, notesFile, 'file');
    assert.throws(() => save?.({}, 'hacked'), (error: unknown) => error instanceof Error && error.message === 'unsafe_path');
    assert.equal(fs.readFileSync(linked, 'utf8'), 'previous');
    assert.equal(fs.lstatSync(notesFile).isSymbolicLink(), true);
    fs.rmSync(notesFile);
    const dangling = path.join(outside, 'missing.txt');
    fs.symlinkSync(dangling, notesFile, 'file');
    assert.throws(() => notes.saveNotes(root, 'hacked'), (error: unknown) => error instanceof Error && error.message === 'unsafe_path');
    assert.equal(fs.existsSync(dangling), false);
    assert.equal(fs.readFileSync(linked, 'utf8'), 'previous');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('saving notes through a hard link fails and leaves the outside file unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notes-hard-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notes-hard-out-'));
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  try {
    notes.registerNotes(root, { handle: (name, fn) => handlers.set(name, fn) });
    const notesFile = path.join(root, 'notes.txt');
    const linked = path.join(outside, 'secret.txt');
    fs.writeFileSync(linked, 'previous');
    fs.linkSync(linked, notesFile);
    assert.equal(fs.lstatSync(notesFile).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(notesFile).nlink > 1, true);
    const load = handlers.get('notes:load');
    const save = handlers.get('notes:save');
    assert.throws(() => load?.({}), (error: unknown) => error instanceof Error && error.message === 'unsafe_path');
    assert.throws(() => save?.({}, 'hacked'), (error: unknown) => error instanceof Error && error.message === 'unsafe_path');
    assert.equal(fs.readFileSync(linked, 'utf8'), 'previous');
    assert.equal(fs.readFileSync(notesFile, 'utf8'), 'previous');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
