import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notebookProfile, notebooksBrief } from '../notebooks/profile.js';
import { assertProjectFile, copyApprovedCsv } from '../notebooks/csv.js';
import { emptyNotebook, notebookExportText } from '../notebooks/document.js';
import { sourceEntries } from '../artifacts.js';
import { BuildMenuError } from '../grants.js';
import { readCellSource } from '../notebooks/kernel.js';
import { MAX_KERNEL_LINE, parseKernelStdout } from '../notebooks/messages.js';
import { notebookPage, parseNotebook, writeNotebookPreview } from '../notebooks/view.js';

test('notebook: fixed capability boundary', () => {
  assert.equal(notebookProfile.kind, 'notebook');
  assert.equal(notebookProfile.preview, 'notebook');
  assert.equal(notebookProfile.externalEffects, 'approval-required');
  assert.ok(notebookProfile.exports.includes('source-zip'));
  assert.ok(notebooksBrief.length > 40);
});

test('new notebook is nbformat4 and not executed', () => {
  const book = emptyNotebook();
  assert.equal(book.nbformat, 4);
  assert.equal(book.cells[0]?.execution_count, null);
  assert.deepEqual(book.cells[0]?.outputs, []);
  const saved = JSON.stringify(book);
  assert.equal(parseNotebook(saved).cells[0]?.id, book.cells[0]?.id);
});

test('notebook export keeps the cell and drops the kernel connection', () => {
  const raw = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python', connection_file: 'kernel.json' },
      connection: { key: 'secret-key', shell_port: 5000, signature_scheme: 'hmac-sha256' },
    },
    cells: [{
      id: 'cell-1',
      cell_type: 'code',
      source: ['print(1 + 1)'],
      outputs: [{ output_type: 'stream', text: '2' }],
      execution_count: 1,
      metadata: { connection_file: 'kernel.json' },
    }],
  });
  const exported = notebookExportText(raw);
  assert.match(exported, /print\(1 \+ 1\)/);
  assert.match(exported, /cell-1/);
  assert.equal(exported.includes('connection_file'), false);
  assert.equal(exported.includes('shell_port'), false);
  assert.equal(exported.includes('secret-key'), false);
  assert.equal(exported.includes('signature_scheme'), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notebook-export-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  try {
    fs.writeFileSync(path.join(app, 'notebook.ipynb'), raw);
    fs.writeFileSync(path.join(app, 'kernel.json'), '{"key":"secret-key","shell_port":1,"signature_scheme":"hmac-sha256"}\n');
    const entries = sourceEntries(app);
    assert.equal(entries.some((entry) => entry.name === 'kernel.json'), false);
    const book = entries.find((entry) => entry.name === 'notebook.ipynb')?.data.toString('utf8') ?? '';
    assert.match(book, /print\(1 \+ 1\)/);
    assert.equal(book.includes('secret-key'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('notebook preview escapes active outputs and keeps a png inert', () => {
  const page = notebookPage(parseNotebook(JSON.stringify({
    nbformat: 4,
    cells: [{
      id: 'cell-1',
      source: ['print(1)'],
      outputs: [{
        output_type: 'display_data',
        data: {
          'text/html': '<script>alert(1)</script>',
          'image/svg+xml': '<svg onload="alert(1)"></svg>',
          'text/plain': '[link](javascript:alert(1))',
          'image/png': 'iVBORw0KGgo=',
          'application/zip': 'not-run',
        },
      }],
    }],
  })));
  assert.equal(page.includes('<script'), false);
  assert.equal(page.includes('<svg'), false);
  assert.equal(page.includes('<a'), false);
  assert.equal(page.includes('href='), false);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(page, /&lt;svg onload=&quot;alert\(1\)&quot;/);
  assert.match(page, /data:image\/png;base64,iVBORw0KGgo=/);
  assert.match(page, /application\/zip/);
  assert.throws(() => parseNotebook(JSON.stringify({ nbformat: 3, cells: [] })), /invalid_notebook/);
  assert.throws(() => parseNotebook(JSON.stringify({ nbformat: 4, cells: Array.from({ length: 1001 }, (_item, index) => ({ id: `c${index}`, source: '' })) })), /invalid_notebook/);
});

test('kernel lines without this cell id are dropped', () => {
  const raw = [
    JSON.stringify({ type: 'output', messageType: 'stream', content: { text: 'unstamped' } }),
    JSON.stringify({ type: 'output', cellId: 'other', messageType: 'stream', content: { text: 'other-cell' } }),
    JSON.stringify({ type: 'error', error: 'injected' }),
    JSON.stringify({ type: 'output', cellId: 'cell-1', messageType: 'stream', content: { text: '3' } }),
  ].join('\n');
  const parsed = parseKernelStdout(raw, 'cell-1');
  assert.equal(parsed.text, '3');
  assert.equal(JSON.stringify(parsed.outputs).includes('unstamped'), false);
  assert.equal(JSON.stringify(parsed.outputs).includes('other-cell'), false);
  assert.equal(JSON.stringify(parsed.outputs).includes('injected'), false);
});

test('a kernel image must fit on one line and markup is dropped', () => {
  const png = 'A'.repeat(2000);
  const kept = parseKernelStdout(JSON.stringify({
    type: 'output',
    cellId: 'cell-1',
    messageType: 'display_data',
    content: { data: { 'text/plain': 'رسم', 'image/png': png, 'text/html': '<script>alert(1)</script>' } },
  }), 'cell-1');
  assert.equal(kept.outputs[0]?.data?.['image/png'], png);
  assert.equal(JSON.stringify(kept.outputs).includes('<script'), false);
  const dropped = parseKernelStdout(JSON.stringify({
    type: 'output',
    cellId: 'cell-1',
    messageType: 'display_data',
    content: { data: { 'text/plain': 'رسم', 'image/png': 'aaa<script>' } },
  }), 'cell-1');
  assert.equal(dropped.outputs[0]?.data?.['image/png'], undefined);
  assert.equal(dropped.outputs[0]?.data?.['text/plain'], 'رسم');
  assert.equal(JSON.stringify(dropped).includes('<script'), false);
  const wide = JSON.stringify({
    type: 'output',
    cellId: 'cell-1',
    messageType: 'display_data',
    content: { data: { 'image/png': 'A'.repeat(9_000) } },
  });
  assert.ok(wide.length > MAX_KERNEL_LINE);
  assert.throws(() => parseKernelStdout(wide, 'cell-1'), /tool_failed/);
});

test('a missing library is shown without an install command', () => {
  const parsed = parseKernelStdout([
    JSON.stringify({ type: 'error', cellId: 'cell-1', error: "ModuleNotFoundError: No module named 'pandas'" }),
    JSON.stringify({ type: 'output', cellId: 'cell-1', messageType: 'error', content: { ename: 'ModuleNotFoundError', evalue: 'No module named pandas. Run pip install pandas' } }),
    JSON.stringify({ type: 'error', cellId: 'cell-1', error: 'SyntaxError: bad' }),
    JSON.stringify({ type: 'error', cellId: 'cell-1', error: 'try: pip install requests' }),
    JSON.stringify({ type: 'error', cellId: 'cell-1', error: "subprocess.check_call(['pip', 'install', 'requests'])" }),
  ].join('\n'), 'cell-1');
  const body = JSON.stringify(parsed.outputs);
  assert.equal(body.includes('pip install'), false);
  assert.equal(body.includes('pandas'), false);
  assert.equal(body.includes('requests'), false);
  assert.match(body, /لن يُثبَّت شيء/);
  assert.match(body, /SyntaxError: bad/);
  const page = notebookPage(parseNotebook(JSON.stringify({
    nbformat: 4,
    cells: [{ id: 'cell-1', source: ['import pandas\n'], outputs: parsed.outputs }],
  })));
  assert.equal(page.includes('pip install'), false);
  assert.equal(page.includes('<script'), false);
  assert.match(page, /import pandas/);
});

test('an interrupted cell says the kernel restarted and the source stays', () => {
  const page = notebookPage(parseNotebook(JSON.stringify({
    nbformat: 4,
    cells: [{
      id: 'cell-1',
      source: ['print(1)\n'],
      outputs: [{ output_type: 'error', ename: 'interrupted', evalue: 'interrupted' }],
    }],
  })));
  assert.match(page, /أعيد تشغيل النواة وستحتاج إعادة تنفيذ الخلايا/);
  assert.match(page, /print\(1\)/);
  assert.equal(page.includes('interrupted:'), false);
});

test('csv import copies only an approved project file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-csv-'));
  const outside = path.join(root, 'secret.csv');
  fs.writeFileSync(outside, 'hidden\n');
  fs.mkdirSync(path.join(root, 'app', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'inbox', 'sales.csv'), 'amount\n2\n<script>alert(1)</script>\n');
  try {
    assert.equal(copyApprovedCsv(root, 'app/inbox/sales.csv'), 'app/data/sales.csv');
    assert.equal(fs.readFileSync(path.join(root, 'app', 'data', 'sales.csv'), 'utf8'), 'amount\n2\n<script>alert(1)</script>\n');
    fs.writeFileSync(path.join(root, 'app', 'notebook.ipynb'), `${JSON.stringify(emptyNotebook())}\n`);
    writeNotebookPreview(root);
    const preview = fs.readFileSync(path.join(root, 'app', 'preview.html'), 'utf8');
    assert.match(preview, /بيانات محلية — لم تُنفَّذ/);
    assert.match(preview, /amount/);
    assert.match(preview, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.equal(preview.includes('<script'), false);
    assert.throws(() => copyApprovedCsv(root, '../secret.csv'), /unsafe_path/);
    assert.throws(() => copyApprovedCsv(root, 'app/inbox/../secret.csv'), /unsafe_path/);
    assert.equal(fs.existsSync(path.join(root, 'app', 'data', 'secret.csv')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('notebook source stays within 2MB and outputs stay within 10MB', () => {
  const half = 'a'.repeat(1_000_000);
  const accepted = parseNotebook(JSON.stringify({
    nbformat: 4,
    cells: [
      { id: 'c1', source: half, outputs: [] },
      { id: 'c2', source: half, outputs: [] },
    ],
  }));
  assert.equal(accepted.cells.length, 2);
  assert.throws(() => parseNotebook(JSON.stringify({
    nbformat: 4,
    cells: [
      { id: 'c1', source: half, outputs: [] },
      { id: 'c2', source: `${half}a`, outputs: [] },
    ],
  })), /invalid_notebook/);
  const wrapper = Buffer.byteLength(JSON.stringify([{ output_type: 'stream', text: '' }]));
  const exact = 'b'.repeat(10_000_000 - wrapper);
  const kept = parseNotebook(JSON.stringify({
    nbformat: 4,
    cells: [{ id: 'out', source: 'print(1)', outputs: [{ output_type: 'stream', text: exact }] }],
  }));
  assert.equal(kept.cells[0]?.outputs[0]?.kind, 'text');
  assert.throws(() => parseNotebook(JSON.stringify({
    nbformat: 4,
    cells: [{ id: 'out', source: 'print(1)', outputs: [{ output_type: 'stream', text: `${exact}b` }] }],
  })), /invalid_notebook/);
});

test('a notebook image stays within 1MB and a larger one is not shown', () => {
  const exact = 'A'.repeat(1_000_000);
  const shown = notebookPage(parseNotebook(JSON.stringify({
    nbformat: 4,
    cells: [{ id: 'pic', source: 'plot', outputs: [{ output_type: 'display_data', data: { 'image/png': exact, 'text/plain': 'رسم' } }] }],
  })));
  assert.equal(shown.includes(`data:image/png;base64,${exact}`), true);
  assert.match(shown, /رسم/);
  const tooBig = notebookPage(parseNotebook(JSON.stringify({
    nbformat: 4,
    cells: [{ id: 'pic', source: 'plot', outputs: [{ output_type: 'display_data', data: { 'image/png': `${exact}A`, 'text/plain': 'رسم' } }] }],
  })));
  assert.equal(tooBig.includes('<img'), false);
  assert.equal(tooBig.includes(exact), false);
  assert.match(tooBig, /رسم/);
  const hostile = notebookPage(parseNotebook(JSON.stringify({
    nbformat: 4,
    cells: [{ id: 'pic', source: 'plot', outputs: [{ output_type: 'display_data', data: { 'image/png': 'aaa<script>' } }] }],
  })));
  assert.equal(hostile.includes('<img'), false);
  assert.equal(hostile.includes('<script'), false);
});

test('notebook: fixed capability boundary', () => {
  assert.equal(notebookProfile.kind, 'notebook');
  assert.equal(notebookProfile.preview, 'notebook');
  assert.equal(notebookProfile.externalEffects, 'approval-required');
  assert.ok(notebookProfile.exports.includes('source-zip'));
  assert.ok(notebooksBrief.length > 40);
});

test('new notebook is nbformat4 and not executed', () => {
  const book = emptyNotebook();
  assert.equal(book.nbformat, 4);
  assert.equal(book.cells[0]?.execution_count, null);
  assert.deepEqual(book.cells[0]?.outputs, []);
});

test('a csv whose real path leaves the project is refused before it is read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-csv-real-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-csv-out-'));
  fs.writeFileSync(path.join(outside, 'sales.csv'), 'secret-row\n');
  try {
    assert.throws(() => assertProjectFile(root, path.join(outside, 'sales.csv')), /unsafe_path/);
    assert.equal(fs.readFileSync(path.join(outside, 'sales.csv'), 'utf8'), 'secret-row\n');
    fs.mkdirSync(path.join(root, 'app', 'inbox'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'inbox', 'sales.csv'), 'amount\n2\n');
    assert.doesNotThrow(() => assertProjectFile(root, path.join(root, 'app', 'inbox', 'sales.csv')));
    assert.equal(copyApprovedCsv(root, 'app/inbox/sales.csv'), 'app/data/sales.csv');
    assert.equal(fs.readFileSync(path.join(root, 'app', 'data', 'sales.csv'), 'utf8'), 'amount\n2\n');
    assert.equal(fs.readFileSync(path.join(outside, 'sales.csv'), 'utf8'), 'secret-row\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a notebook folder is not read as a cell', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notebook-dir-'));
  const notebook = path.join(root, 'app', 'notebook.ipynb');
  const outside = path.join(root, 'secret.txt');
  fs.mkdirSync(notebook, { recursive: true });
  fs.writeFileSync(outside, 'secret');
  try {
    assert.throws(
      () => readCellSource(root, 'cell-1'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.statSync(notebook).isDirectory(), true);
    assert.equal(fs.readdirSync(notebook).length, 0);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'secret');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a notebook folder is not packed or previewed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notebook-pack-'));
  const app = path.join(root, 'app');
  const notebook = path.join(app, 'notebook.ipynb');
  fs.mkdirSync(notebook, { recursive: true });
  fs.writeFileSync(path.join(notebook, 'secret.txt'), 'secret');
  try {
    assert.throws(() => sourceEntries(app), (error: unknown) => error instanceof Error && error.message === 'unsafe_path');
    assert.throws(() => writeNotebookPreview(root), (error: unknown) => error instanceof Error && error.message === 'unsafe_path');
    assert.equal(fs.existsSync(path.join(app, 'preview.html')), false);
    assert.equal(fs.readFileSync(path.join(notebook, 'secret.txt'), 'utf8'), 'secret');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
