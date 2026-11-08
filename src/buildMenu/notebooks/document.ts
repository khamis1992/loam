import { randomUUID } from 'node:crypto';
import { BuildMenuError } from '../grants.js';
import { installsPackage } from './installGuard.js';
import { NOTEBOOK_MAX_CELLS, NOTEBOOK_MAX_OUTPUT_BYTES, NOTEBOOK_MAX_SOURCE_BYTES } from './view.js';

export interface CodeCell {
  id: string;
  cell_type: 'code';
  metadata: Record<string, never>;
  source: string[];
  execution_count: number | null;
  outputs: unknown[];
}

export interface NotebookDocument {
  nbformat: 4;
  nbformat_minor: 5;
  metadata: { kernelspec: { name: 'python3'; display_name: 'Python 3'; language: 'python' } };
  cells: CodeCell[];
}

const CONNECTION_KEYS = new Set([
  'connection_file',
  'connection',
  'key',
  'signature_scheme',
  'transport',
  'ip',
  'shell_port',
  'iopub_port',
  'stdin_port',
  'control_port',
  'hb_port',
  'kernel_id',
]);

const REMOTE_SCHEME = /https?\s*:\s*\/\s*\/|(?:javascript|data|file|blob|mailto|tel|sms|intent|market)\s*:|(?<!:)\/\//i;

export function notebookExportText(text: string): string {
  const value = JSON.parse(text) as { nbformat?: unknown; nbformat_minor?: unknown; metadata?: unknown; cells?: unknown };
  if (value.nbformat !== 4 || !Array.isArray(value.cells)) throw new Error('invalid_notebook');
  assertExportBounds(value.cells);
  const exported = {
    nbformat: 4 as const,
    nbformat_minor: 5 as const,
    metadata: stripConnections(value.metadata),
    cells: value.cells.map((cell) => {
      if (installsPackage(sourceText(cell))) throw new BuildMenuError('approval_required', 403);
      if (cellHasRemoteScheme(cell)) throw new BuildMenuError('unsafe_path', 400);
      return stripConnections(cell);
    }),
  };
  return `${JSON.stringify(exported, null, 2)}\n`;
}

function cellHasRemoteScheme(cell: unknown): boolean {
  return containsRemoteScheme(sourceText(cell)) || containsRemoteScheme(outputText(cell));
}

function containsRemoteScheme(value: string): boolean {
  let current = value;
  for (let pass = 0; pass < 3; pass += 1) {
    REMOTE_SCHEME.lastIndex = 0;
    if (REMOTE_SCHEME.test(current)) return true;
    if (pass === 2) return false;
    const next = decodePercent(current);
    if (next === current) return false;
    current = next;
  }
  return false;
}

function decodePercent(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function outputText(cell: unknown): string {
  if (!cell || typeof cell !== 'object') return '';
  const parts: string[] = [];
  collectText((cell as { outputs?: unknown }).outputs, parts);
  return parts.join('');
}

function collectText(value: unknown, parts: string[]): void {
  if (typeof value === 'string') {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, parts);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    parts.push(key);
    collectText(item, parts);
  }
}

function assertExportBounds(cells: unknown[]): void {
  if (cells.length > NOTEBOOK_MAX_CELLS) throw new Error('invalid_notebook');
  let sourceBytes = 0;
  let outputBytes = 0;
  for (const cell of cells) {
    sourceBytes += Buffer.byteLength(sourceText(cell));
    outputBytes += outputByteLength(cell);
    if (sourceBytes > NOTEBOOK_MAX_SOURCE_BYTES || outputBytes > NOTEBOOK_MAX_OUTPUT_BYTES) {
      throw new Error('invalid_notebook');
    }
  }
}

function outputByteLength(cell: unknown): number {
  const outputs = cell && typeof cell === 'object' ? (cell as { outputs?: unknown }).outputs : undefined;
  return Buffer.byteLength(JSON.stringify(Array.isArray(outputs) ? outputs : []));
}

export function isKernelConnectionFile(name: string, data: Buffer): boolean {
  const base = name.split(/[/\\]/).pop() ?? name;
  if (base === 'kernel.json' || base === 'kernel-connection.json') return true;
  if (!base.endsWith('.json')) return false;
  const text = data.toString('utf8');
  return text.includes('"signature_scheme"') && text.includes('"shell_port"');
}

function sourceText(cell: unknown): string {
  if (!cell || typeof cell !== 'object') return '';
  const source = (cell as { source?: unknown }).source;
  if (typeof source === 'string') return source;
  if (!Array.isArray(source)) return '';
  return source.map((line) => (typeof line === 'string' ? line : '')).join('');
}

function stripConnections(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripConnections(item));
  if (!value || typeof value !== 'object') return value;
  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (CONNECTION_KEYS.has(key)) continue;
    clean[key] = stripConnections(item);
  }
  return clean;
}

export function emptyNotebook(): NotebookDocument {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    cells: [{
      id: randomUUID(),
      cell_type: 'code',
      metadata: {},
      source: ['print(1 + 1)'],
      execution_count: null,
      outputs: [],
    }],
  };
}
