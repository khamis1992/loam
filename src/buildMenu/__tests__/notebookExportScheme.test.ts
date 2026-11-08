import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildMenuError } from '../grants.js';
import { notebookExportText } from '../notebooks/document.js';

const SCHEMES = [
  'https://example.test/a',
  'http://example.test/a',
  'javascript:alert(1)',
  'data:text/html,hi',
  'file:///c:/secret',
  'blob:null/uuid',
  'mailto:user@example.test',
  'tel:+97400000000',
  'sms:+97400000000',
  'intent:#Intent;end',
  'market://details?id=app',
  '//cdn.example/a.js',
];

function notebook(cells: unknown[], nbformat: unknown = 4): string {
  return JSON.stringify({ nbformat, cells });
}

function cell(source: string | string[], outputs: unknown[] = []): unknown {
  return { id: 'cell-1', cell_type: 'code', source, outputs, metadata: {} };
}

function refused(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

function percentEncode(value: string): string {
  return Array.from(value, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
}

function forms(value: string): string[] {
  const once = percentEncode(value);
  const twice = percentEncode(once);
  const uriOnce = encodeURIComponent(value);
  const uriTwice = encodeURIComponent(uriOnce);
  return [
    value,
    value.toUpperCase(),
    once,
    once.toUpperCase(),
    twice,
    twice.toUpperCase(),
    uriOnce,
    uriOnce.toUpperCase(),
    uriTwice,
    uriTwice.toUpperCase(),
  ];
}

test('notebook export strips connection fields and keeps a print cell', () => {
  const exported = notebookExportText(JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python', connection_file: 'kernel.json' },
      connection: { key: 'secret-key', shell_port: 5000, signature_scheme: 'hmac-sha256' },
    },
    cells: [{
      id: 'cell-1',
      cell_type: 'code',
      source: ['print(1)'],
      outputs: [{ output_type: 'stream', text: '1' }],
      execution_count: 1,
      metadata: { connection_file: 'kernel.json', key: 'secret-key', kernel_id: 'kid' },
    }],
  }));
  const parsed = JSON.parse(exported) as { nbformat: number; cells: Array<{ source: string[] }> };
  assert.equal(parsed.nbformat, 4);
  assert.deepEqual(parsed.cells[0]?.source, ['print(1)']);
  assert.equal(exported.includes('connection_file'), false);
  assert.equal(exported.includes('connection'), false);
  assert.equal(exported.includes('secret-key'), false);
  assert.equal(exported.includes('shell_port'), false);
  assert.equal(exported.includes('signature_scheme'), false);
  assert.equal(exported.includes('kernel_id'), false);
});

test('a normal print cell still exports', () => {
  const exported = notebookExportText(notebook([
    cell(['print(1)']),
  ]));
  const parsed = JSON.parse(exported) as { nbformat: number; cells: Array<{ source: string[] }> };
  assert.equal(parsed.nbformat, 4);
  assert.equal(parsed.cells.length, 1);
  assert.deepEqual(parsed.cells[0]?.source, ['print(1)']);
  const words = JSON.parse(notebookExportText(notebook([
    cell(['print("https http javascript data file blob mailto tel sms intent market")']),
  ]))) as { cells: Array<{ source: string[] }> };
  assert.deepEqual(words.cells[0]?.source, ['print("https http javascript data file blob mailto tel sms intent market")']);
});

test('nbformat other than 4 still throws invalid_notebook', () => {
  assert.throws(() => notebookExportText(notebook([], 3)), /invalid_notebook/);
  assert.throws(() => notebookExportText(notebook([
    cell(['https://example.test/a']),
  ], 3)), (error: unknown) => error instanceof Error && error.message === 'invalid_notebook');
});

test('an install cell still throws approval_required', () => {
  assert.throws(() => notebookExportText(notebook([
    cell(["subprocess.check_call(['pip', ", "'install', 'requests'])"]),
  ])), (error: unknown) => error instanceof BuildMenuError && error.message === 'approval_required' && error.status === 403);
});

test('export refuses remote schemes in cell source and output, including percent-encoding once or twice', () => {
  for (const scheme of SCHEMES) {
    for (const payload of forms(scheme)) {
      const noted = `note ${payload} end`;
      assert.throws(() => notebookExportText(notebook([cell(noted)])), refused, payload);
      assert.throws(() => notebookExportText(notebook([cell([noted])])), refused, payload);
      assert.throws(() => notebookExportText(notebook([
        cell(['print(1)'], [{ output_type: 'stream', text: noted }]),
      ])), refused, payload);
      assert.throws(() => notebookExportText(notebook([
        cell(['print(1)'], [{ output_type: 'display_data', data: { 'text/plain': payload }, metadata: {} }]),
      ])), refused, payload);
      assert.throws(() => notebookExportText(notebook([
        cell(['print(1)'], [{ output_type: 'error', ename: 'Error', evalue: 'boom', traceback: [payload] }]),
      ])), refused, payload);
    }
  }
});

test('export refuses a scheme split across a later cell, source lines, or output chunks', () => {
  assert.throws(() => notebookExportText(notebook([
    cell(['print(1)']),
    { id: 'cell-2', cell_type: 'code', source: ['print(2)'], outputs: [{ output_type: 'stream', text: 'https://evil.test' }], metadata: {} },
  ])), refused);
  assert.throws(() => notebookExportText(notebook([cell(['https:', '//evil.test'])])), refused);
  assert.throws(() => notebookExportText(notebook([cell(['java', 'script:alert(1)'])])), refused);
  assert.throws(() => notebookExportText(notebook([
    cell(['print(1)'], [{ output_type: 'stream', text: ['mail', 'to:user@example.test'] }]),
  ])), refused);
  assert.throws(() => notebookExportText(notebook([
    cell(['print(1)'], [{ output_type: 'stream', text: ['https%3A', '%2F%2Fevil.test'] }]),
  ])), refused);
  assert.throws(() => notebookExportText(notebook([
    cell(['print(1)'], [{ output_type: 'stream', text: ['https%253A', '%252F%252Fevil.test'] }]),
  ])), refused);
  assert.throws(() => notebookExportText(notebook([
    cell(['print(1)'], [{ output_type: 'stream', text: ['%2F%2Fcdn.example', '/a.js'] }]),
  ])), refused);
  assert.throws(() => notebookExportText(notebook([
    cell(['print(1)'], [{ output_type: 'stream', text: ['%252F%252Fcdn.example', '/a.js'] }]),
  ])), refused);
});
