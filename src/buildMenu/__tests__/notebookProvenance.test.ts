import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildMenuError } from '../grants.js';
import { notebookExportText } from '../notebooks/document.js';
import { notebookImagePin, notebookPage, parseNotebook, writeNotebookPreview } from '../notebooks/view.js';

const pinPath = path.resolve('src/buildMenu/notebooks/python/image-pin.json');

function notebook(cells: unknown[], nbformat: unknown = 4): string {
  return JSON.stringify({ nbformat, cells });
}

function previewPin(html: string): { status: unknown; digest: unknown } {
  const match = html.match(/<meta name="loam-image-pin" content="([^"]*)">/);
  assert.ok(match?.[1]);
  const json = (match[1] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return JSON.parse(json) as { status: unknown; digest: unknown };
}

test('a normal print cell still exports', () => {
  const exported = notebookExportText(notebook([
    { id: 'cell-1', cell_type: 'code', source: ['print(1)'], outputs: [], metadata: {} },
  ]));
  const parsed = JSON.parse(exported) as { nbformat: number; metadata?: unknown; cells: Array<{ source: string[] }> };
  assert.equal(parsed.nbformat, 4);
  assert.equal(parsed.cells.length, 1);
  assert.deepEqual(parsed.cells[0]?.source, ['print(1)']);
  assert.equal(/[a-f0-9]{64}/i.test(JSON.stringify(parsed.metadata ?? null)), false);
});

test('an install cell still refuses', () => {
  assert.throws(() => notebookExportText(notebook([
    {
      id: 'cell-2',
      cell_type: 'code',
      source: ["subprocess.check_call(['pip', ", "'install', 'requests'])"],
      outputs: [],
      metadata: {},
    },
  ])), (error: unknown) => error instanceof BuildMenuError && error.message === 'approval_required' && error.status === 403);
});

test('nbformat other than 4 still fails', () => {
  assert.throws(() => notebookExportText(notebook([], 3)), /invalid_notebook/);
  assert.throws(() => parseNotebook(JSON.stringify({ nbformat: 3, cells: [] })), /invalid_notebook/);
});

test('preview metadata records image pin status unresolved and digest null', () => {
  const pinText = fs.readFileSync(pinPath, 'utf8');
  const pinFile = JSON.parse(pinText) as { status?: unknown; digest?: unknown };
  assert.equal(pinFile.status, 'unresolved');
  assert.equal(pinFile.digest, null);
  assert.equal(/[a-f0-9]{64}/i.test(pinText), false);

  const recorded = notebookImagePin();
  assert.equal(recorded.status, 'unresolved');
  assert.equal(recorded.digest, null);
  assert.equal(/[a-f0-9]{64}/i.test(JSON.stringify(recorded)), false);

  const page = notebookPage(parseNotebook(notebook([
    { id: 'cell-1', cell_type: 'code', source: ['print(1)'], outputs: [] },
  ])));
  const shown = previewPin(page);
  assert.equal(shown.status, 'unresolved');
  assert.equal(shown.digest, null);
  assert.equal(/[a-f0-9]{64}/i.test(JSON.stringify(shown)), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notebook-pin-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  try {
    fs.writeFileSync(path.join(app, 'notebook.ipynb'), `${notebook([
      { id: 'cell-1', cell_type: 'code', source: ['print(1)'], outputs: [] },
    ])}\n`);
    writeNotebookPreview(root);
    const preview = fs.readFileSync(path.join(app, 'preview.html'), 'utf8');
    const saved = previewPin(preview);
    assert.equal(saved.status, 'unresolved');
    assert.equal(saved.digest, null);
    assert.equal(fs.readFileSync(pinPath, 'utf8'), pinText);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
