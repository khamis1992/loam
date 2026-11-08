/**
 * Notebook preview reads refuse an existing notebook whose nlink is greater
 * than 1 before readFileSync. Outside bytes stay unused. A regular nlink 1
 * notebook still reads. Digest stays null. This file creates hard links only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeNotebookPreview } from '../notebooks/view.js';

const viewSource = path.resolve('src/buildMenu/notebooks/view.ts');
const pinPath = path.resolve('src/buildMenu/notebooks/python/image-pin.json');

function notebookBytes(source = 'print(1)\n'): Buffer {
  return Buffer.from(`${JSON.stringify({
    nbformat: 4,
    cells: [{ id: 'cell-1', cell_type: 'code', source: [source], outputs: [] }],
  })}\n`);
}

function isUnsafe(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function samePath(left: string, right: string): boolean {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function withPair(prefix: string, run: (root: string, outsideRoot: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}out-`));
  try {
    run(root, outsideRoot);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
}

function notebookFile(workspace: string): string {
  return path.join(workspace, 'app', 'notebook.ipynb');
}

function previewFile(workspace: string): string {
  return path.join(workspace, 'app', 'preview.html');
}

function writeNotebook(workspace: string, source?: string): string {
  const notebook = notebookFile(workspace);
  fs.mkdirSync(path.dirname(notebook), { recursive: true });
  fs.writeFileSync(notebook, notebookBytes(source));
  return notebook;
}

function previewPin(html: string): { status: unknown; digest: unknown } {
  const match = html.match(/<meta name="loam-image-pin" content="([^"]*)">/);
  assert.ok(match?.[1]);
  const json = (match[1] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return JSON.parse(json) as { status: unknown; digest: unknown };
}

function assertPinUntouched(before: Buffer): void {
  const pin = JSON.parse(before.toString('utf8')) as { status?: unknown; digest?: unknown };
  assert.equal(pin.status, 'unresolved');
  assert.equal(pin.digest, null);
  assert.equal(fs.readFileSync(pinPath).equals(before), true);
}

function previewBody(source: string): string {
  const start = source.indexOf('export function writeNotebookPreview');
  const end = source.indexOf('export function csvPreview');
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test('the notebook read checks nlink first and the preview write check stays', () => {
  const source = fs.readFileSync(viewSource, 'utf8');
  const body = previewBody(source);
  const readAt = body.indexOf('fs.readFileSync(notebook');
  const first = body.indexOf('stat.nlink > 1');
  const second = body.indexOf('stat.nlink > 1', first + 1);
  const writeAt = body.indexOf('fs.writeFileSync');
  assert.equal((body.match(/stat\.nlink > 1/g) ?? []).length, 2);
  assert.ok(first >= 0 && first < readAt);
  assert.ok(second > readAt && writeAt > second);
  assert.equal(body.includes('catch'), false);
  assert.equal(body.includes('EPERM'), false);
  assert.equal(source.includes('docker pull'), false);
  assert.equal(source.includes('docker'), false);
  assert.equal(body.includes('symlinkSync'), false);
  assert.equal(body.includes('junction'), false);
});

test('a regular nlink 1 notebook still reads and the pin digest stays null', () => {
  const pinBefore = fs.readFileSync(pinPath);
  withPair('loam-48-view-read-nlink1-', (root) => {
    const notebook = writeNotebook(root, 'print(1)\n');
    const stat = fs.lstatSync(notebook);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    const page = previewFile(root);
    assert.equal(fs.existsSync(page), false);
    writeNotebookPreview(root);
    const created = fs.lstatSync(page);
    assert.equal(created.isSymbolicLink(), false);
    assert.equal(created.isFile(), true);
    assert.equal(created.nlink, 1);
    assert.equal(fs.lstatSync(notebook).nlink, 1);
    const html = fs.readFileSync(page, 'utf8');
    assert.match(html, /print\(1\)/);
    const pin = previewPin(html);
    assert.equal(pin.status, 'unresolved');
    assert.equal(pin.digest, null);
    assert.deepEqual(fs.readFileSync(notebook), notebookBytes('print(1)\n'));
    assertPinUntouched(pinBefore);
  });
});

test('a hard-linked notebook throws unsafe_path before read and the outside bytes stay', () => {
  const pinBefore = fs.readFileSync(pinPath);
  withPair('loam-48-view-read-link-', (root, outsideRoot) => {
    const notebook = notebookFile(root);
    const outside = path.join(outsideRoot, 'notebook.ipynb');
    const previous = notebookBytes('print("outside-secret")\n');
    fs.mkdirSync(path.dirname(notebook), { recursive: true });
    fs.writeFileSync(outside, previous);
    fs.linkSync(outside, notebook);
    const stat = fs.lstatSync(notebook);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(fs.lstatSync(outside).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(outside).nlink > 1, true);
    assert.equal(fs.lstatSync(outside).ino, stat.ino);
    const page = previewFile(root);
    assert.equal(fs.existsSync(page), false);
    const realRead = fs.readFileSync;
    const resolved = path.resolve(notebook);
    let notebookReads = 0;
    fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: fs.ObjectEncodingOptions | BufferEncoding | null) => {
      if (typeof target !== 'number' && samePath(path.resolve(String(target)), resolved)) notebookReads += 1;
      return options === undefined ? realRead(target) : realRead(target, options);
    }) as typeof fs.readFileSync;
    try {
      assert.throws(() => writeNotebookPreview(root), isUnsafe);
      assert.equal(notebookReads, 0);
    } finally {
      fs.readFileSync = realRead;
    }
    assert.equal(fs.existsSync(page), false);
    assert.equal(fs.lstatSync(notebook).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(notebook).isFile(), true);
    assert.equal(fs.lstatSync(notebook).nlink > 1, true);
    assert.equal(fs.lstatSync(outside).nlink > 1, true);
    assert.deepEqual(fs.readFileSync(notebook), previous);
    assert.deepEqual(fs.readFileSync(outside), previous);
    assert.equal(fs.readFileSync(notebook, 'utf8').includes('outside-secret'), true);
    assertPinUntouched(pinBefore);
  });
});

test('lstat EPERM on the notebook is not swallowed before read', () => {
  const pinBefore = fs.readFileSync(pinPath);
  withPair('loam-48-view-read-eperm-', (root) => {
    const notebook = writeNotebook(root, 'print(1)\n');
    const previous = fs.readFileSync(notebook);
    assert.equal(fs.lstatSync(notebook).nlink, 1);
    const page = previewFile(root);
    const real = fs.lstatSync;
    const resolved = path.resolve(notebook);
    fs.lstatSync = ((target: fs.PathLike, options?: fs.StatOptions) => {
      if (samePath(path.resolve(String(target)), resolved)) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return options === undefined ? real(target) : real(target, options);
    }) as typeof fs.lstatSync;
    try {
      assert.throws(() => writeNotebookPreview(root), isEperm);
      assert.equal(fs.existsSync(page), false);
      assert.equal(real(notebook).isSymbolicLink(), false);
      assert.equal(real(notebook).nlink, 1);
      assert.deepEqual(fs.readFileSync(notebook), previous);
      assertPinUntouched(pinBefore);
    } finally {
      fs.lstatSync = real;
    }
  });
});
