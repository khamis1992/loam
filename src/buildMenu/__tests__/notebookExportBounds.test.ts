import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildMenuError } from '../grants.js';
import { notebookExportText } from '../notebooks/document.js';

function notebook(cells: unknown[], nbformat: unknown = 4): string {
  return JSON.stringify({ nbformat, cells });
}

test('a one-cell print notebook still exports', () => {
  const exported = notebookExportText(notebook([
    { id: 'cell-1', cell_type: 'code', source: ['print(1)'], outputs: [], metadata: {} },
  ]));
  const parsed = JSON.parse(exported) as { nbformat: number; cells: Array<{ source: string[] }> };
  assert.equal(parsed.nbformat, 4);
  assert.equal(parsed.cells.length, 1);
  assert.deepEqual(parsed.cells[0]?.source, ['print(1)']);
});

test('export rejects a notebook that is not nbformat 4', () => {
  assert.throws(() => notebookExportText(notebook([], 3)), /invalid_notebook/);
});

test('export rejects more than 1000 cells', () => {
  const cells = Array.from({ length: 1000 }, (_item, index) => ({
    id: `c${index}`,
    cell_type: 'code',
    source: ['x'],
    outputs: [],
  }));
  const accepted = JSON.parse(notebookExportText(notebook(cells))) as { cells: unknown[] };
  assert.equal(accepted.cells.length, 1000);
  cells.push({ id: 'c1000', cell_type: 'code', source: ['x'], outputs: [] });
  assert.throws(() => notebookExportText(notebook(cells)), /invalid_notebook/);
});

test('export keeps 2MB of source and rejects one more byte', () => {
  const half = 'a'.repeat(1_000_000);
  const accepted = JSON.parse(notebookExportText(notebook([
    { id: 'c1', source: [half], outputs: [] },
    { id: 'c2', source: [half], outputs: [] },
  ]))) as { cells: Array<{ source: string[] }> };
  const kept = (accepted.cells[0]?.source.join('') ?? '') + (accepted.cells[1]?.source.join('') ?? '');
  assert.equal(Buffer.byteLength(kept), 2_000_000);
  assert.throws(() => notebookExportText(notebook([
    { id: 'c1', source: [half], outputs: [] },
    { id: 'c2', source: [half, 'a'], outputs: [] },
  ])), /invalid_notebook/);
  const wide = 'م'.repeat(1_000_001);
  assert.equal(Buffer.byteLength(wide), 2_000_002);
  assert.throws(() => notebookExportText(notebook([
    { id: 'wide', source: [wide], outputs: [] },
  ])), /invalid_notebook/);
});

test('export keeps 10MB of outputs and rejects one more byte', () => {
  const wrapper = Buffer.byteLength(JSON.stringify([{ output_type: 'stream', text: '' }]));
  const exact = 'b'.repeat(10_000_000 - wrapper);
  const accepted = JSON.parse(notebookExportText(notebook([
    { id: 'out', source: 'print(1)', outputs: [{ output_type: 'stream', text: exact }] },
  ]))) as { cells: Array<{ outputs: Array<{ text: string }> }> };
  assert.equal(accepted.cells[0]?.outputs[0]?.text, exact);
  assert.throws(() => notebookExportText(notebook([
    { id: 'out', source: 'print(1)', outputs: [{ output_type: 'stream', text: `${exact}b` }] },
  ])), /invalid_notebook/);
  const chunk = 'c'.repeat(6_000_000);
  assert.throws(() => notebookExportText(notebook([
    { id: 'o1', source: 'print(1)', outputs: [{ output_type: 'stream', text: chunk }] },
    { id: 'o2', source: 'print(1)', outputs: [{ output_type: 'stream', text: chunk }] },
  ])), /invalid_notebook/);
});

test('an install cell still requires approval', () => {
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
