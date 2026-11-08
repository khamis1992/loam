/**
 * An existing notebook preview whose nlink is greater than 1 is refused before
 * write. Outside bytes stay. A new page still writes. Digest stays null.
 * This file creates hard links only.
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

function writeNotebook(workspace: string, source?: string): string {
  const notebook = path.join(workspace, 'app', 'notebook.ipynb');
  fs.mkdirSync(path.dirname(notebook), { recursive: true });
  fs.writeFileSync(notebook, notebookBytes(source));
  return notebook;
}

function previewFile(workspace: string): string {
  return path.join(workspace, 'app', 'preview.html');
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

test('a new page still writes and an existing nlink 1 page still updates', () => {
  const source = fs.readFileSync(viewSource, 'utf8');
  assert.equal(source.includes('nlink > 1'), true);
  assert.equal(source.includes('docker pull'), false);
  assert.equal(source.includes('docker'), false);
  const pinBefore = fs.readFileSync(pinPath);
  withPair('loam-46-view-new-', (root) => {
    writeNotebook(root);
    const page = previewFile(root);
    assert.equal(fs.existsSync(page), false);
    writeNotebookPreview(root);
    const created = fs.lstatSync(page);
    assert.equal(created.isSymbolicLink(), false);
    assert.equal(created.isFile(), true);
    assert.equal(created.nlink, 1);
    const html = fs.readFileSync(page, 'utf8');
    assert.match(html, /print\(1\)/);
    const pin = previewPin(html);
    assert.equal(pin.status, 'unresolved');
    assert.equal(pin.digest, null);
    writeNotebook(root, 'print(2)\n');
    assert.equal(fs.lstatSync(page).nlink, 1);
    writeNotebookPreview(root);
    const replaced = fs.lstatSync(page);
    assert.equal(replaced.isSymbolicLink(), false);
    assert.equal(replaced.isFile(), true);
    assert.equal(replaced.nlink, 1);
    const next = fs.readFileSync(page, 'utf8');
    assert.match(next, /print\(2\)/);
    assert.equal(previewPin(next).digest, null);
    assertPinUntouched(pinBefore);
  });
});

test('a hard-linked preview throws unsafe_path before write and the outside bytes stay', () => {
  const pinBefore = fs.readFileSync(pinPath);
  withPair('loam-46-view-link-', (root, outsideRoot) => {
    writeNotebook(root);
    const page = previewFile(root);
    const outside = path.join(outsideRoot, 'preview.html');
    const previous = Buffer.from('outside-preview-bytes');
    fs.writeFileSync(outside, previous);
    fs.linkSync(outside, page);
    const stat = fs.lstatSync(page);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(fs.lstatSync(outside).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(outside).nlink > 1, true);
    assert.throws(() => writeNotebookPreview(root), isUnsafe);
    assert.equal(fs.lstatSync(page).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(page).isFile(), true);
    assert.equal(fs.lstatSync(page).nlink > 1, true);
    assert.equal(fs.lstatSync(outside).nlink > 1, true);
    assert.deepEqual(fs.readFileSync(page), previous);
    assert.deepEqual(fs.readFileSync(outside), previous);
    assertPinUntouched(pinBefore);
  });
});

test('lstat EPERM on the preview is not swallowed before write', () => {
  const pinBefore = fs.readFileSync(pinPath);
  withPair('loam-46-view-eperm-', (root) => {
    writeNotebook(root);
    const page = previewFile(root);
    const previous = Buffer.from('regular-preview');
    fs.writeFileSync(page, previous);
    assert.equal(fs.lstatSync(page).nlink, 1);
    const real = fs.lstatSync;
    const resolved = path.resolve(page);
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
      assert.equal(real(page).isSymbolicLink(), false);
      assert.equal(real(page).nlink, 1);
      assert.deepEqual(fs.readFileSync(page), previous);
      assertPinUntouched(pinBefore);
    } finally {
      fs.lstatSync = real;
    }
  });
});
