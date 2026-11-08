import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { sourceEntries } from '../artifacts.js';
import { BuildMenuError } from '../grants.js';
import { notebookExportText } from '../notebooks/document.js';
import { createNotebooksPorts } from '../notebooks/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'notebook' };
  return {
    workspace,
    jobId: 'job_notebookexport',
    operation: { action: 'package', format: 'ipynb' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'دفتر',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

test('notebook export refuses an install cell and keeps the previous artifact', async () => {
  const mentioned = notebookExportText(JSON.stringify({
    nbformat: 4,
    cells: [{ id: 'cell-1', cell_type: 'code', source: ['print("pipeline")', 'print("pip", "install")'], outputs: [], metadata: {} }],
  }));
  const kept = JSON.parse(mentioned) as { cells: Array<{ source: string[] }> };
  assert.deepEqual(kept.cells[0]?.source, ['print("pipeline")', 'print("pip", "install")']);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notebook-install-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  const file = path.join(app, 'notebook.ipynb');
  const book = {
    nbformat: 4,
    cells: [{ id: 'cell-1', cell_type: 'code', source: ['print(1)'], outputs: [], metadata: {} }],
  };
  fs.writeFileSync(file, `${JSON.stringify(book)}\n`);
  const ports = createNotebooksPorts({ leases: new ProcessLeaseRegistry(500) });
  const ctx = context(root);
  try {
    const packed = sourceEntries(app).find((entry) => entry.name === 'notebook.ipynb')?.data.toString('utf8') ?? '';
    assert.match(packed, /print\(1\)/);
    const artifact = await ports.export(ctx, 'ipynb');
    const previous = fs.readFileSync(path.join(root, artifact.relativePath));
    assert.match(previous.toString('utf8'), /print\(1\)/);
    book.cells.push({
      id: 'cell-2',
      cell_type: 'code',
      source: ["subprocess.check_call(['pip', ", "'install', 'requests'])"],
      outputs: [],
      metadata: {},
    });
    fs.writeFileSync(file, `${JSON.stringify(book)}\n`);
    await assert.rejects(ports.export(ctx, 'ipynb'), (error: unknown) => error instanceof BuildMenuError && error.message === 'approval_required');
    assert.equal(fs.readFileSync(path.join(root, artifact.relativePath)).equals(previous), true);
    const saved = fs.readFileSync(file, 'utf8');
    assert.match(saved, /\['pip'/);
    assert.match(saved, /'install'/);
    assert.throws(() => sourceEntries(app), (error: unknown) => error instanceof BuildMenuError && error.message === 'approval_required');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ipynb export refuses a notebook folder and writes no artifact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notebook-dir-export-'));
  const notebook = path.join(root, 'app', 'notebook.ipynb');
  fs.mkdirSync(notebook, { recursive: true });
  const ports = createNotebooksPorts({ leases: new ProcessLeaseRegistry(500) });
  try {
    await assert.rejects(
      ports.export(context(root), 'ipynb'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'artifacts')), false);
    assert.equal(fs.statSync(notebook).isDirectory(), true);
    assert.equal(fs.readdirSync(notebook).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
