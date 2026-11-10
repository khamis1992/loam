import fs from 'node:fs';
import path from 'node:path';
import { rootAsset } from '../../config.js';
import { storedBrief, visibleBriefHtml } from '../planProvenance.js';
import { localCsvText } from './csv.js';

export const NOTEBOOK_MAX_CELLS = 1_000;
export const NOTEBOOK_MAX_SOURCE_BYTES = 2_000_000;
export const NOTEBOOK_MAX_OUTPUT_BYTES = 10_000_000;
const MAX_PNG = 1_000_000;

export interface NotebookView {
  cells: NotebookCellView[];
}

export interface NotebookCellView {
  id: string;
  source: string;
  outputs: NotebookOutputView[];
}

export type NotebookOutputView =
  | { kind: 'text'; text: string }
  | { kind: 'png'; base64: string }
  | { kind: 'inert'; mime: string; text: string };

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const PIN_FILE = rootAsset('src', 'buildMenu', 'notebooks', 'python', 'image-pin.json');
const PIN_STATUS = /^[a-z][a-z0-9-]{0,31}$/;
const PIN_DIGEST = /^[a-f0-9]{64}$/;

export interface NotebookImagePin {
  status: string;
  digest: string | null;
}

export function notebookImagePin(): NotebookImagePin {
  const unresolved: NotebookImagePin = { status: 'unresolved', digest: null };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')) as unknown;
  } catch {
    return unresolved;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unresolved;
  const record = raw as { status?: unknown; digest?: unknown };
  if (typeof record.status !== 'string' || !PIN_STATUS.test(record.status)) return unresolved;
  if (record.digest === null) return { status: record.status, digest: null };
  if (typeof record.digest !== 'string' || !PIN_DIGEST.test(record.digest) || record.digest.includes('latest')) return unresolved;
  return { status: record.status, digest: record.digest };
}

export function parseNotebook(text: string): NotebookView {
  const value = JSON.parse(text) as { nbformat?: unknown; cells?: unknown };
  if (value.nbformat !== 4 || !Array.isArray(value.cells) || value.cells.length > NOTEBOOK_MAX_CELLS) throw new Error('invalid_notebook');
  let sourceBytes = 0;
  let outputBytes = 0;
  const cells = value.cells.map((cell) => {
    if (!cell || typeof cell !== 'object') throw new Error('invalid_notebook');
    const record = cell as { id?: unknown; source?: unknown; outputs?: unknown };
    if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 80) throw new Error('invalid_notebook');
    const source = sourceText(record.source);
    sourceBytes += Buffer.byteLength(source);
    const outputs = Array.isArray(record.outputs) ? record.outputs : [];
    outputBytes += Buffer.byteLength(JSON.stringify(outputs));
    if (sourceBytes > NOTEBOOK_MAX_SOURCE_BYTES || outputBytes > NOTEBOOK_MAX_OUTPUT_BYTES) throw new Error('invalid_notebook');
    return { id: record.id, source, outputs: outputs.flatMap(viewOutput) };
  });
  return { cells };
}

export function notebookPage(book: NotebookView, brief = ''): string {
  const cells = book.cells.map((cell) => {
    const outputs = cell.outputs.map(renderOutput).join('');
    return `<section><form method="post" action="/notebook-cell"><textarea name="source" aria-label="${escapeText(cell.id)}">${escapeText(cell.source)}</textarea><input type="hidden" name="id" value="${escapeText(cell.id)}"><button type="submit">احفظ الخلية</button></form>${outputs}</section>`;
  }).join('');
  const pin = notebookImagePin();
  const pinMeta = `<meta name="loam-image-pin" content="${escapeText(JSON.stringify({ status: pin.status, digest: pin.digest }))}">`;
  const html = `<!doctype html><meta charset="utf-8">${pinMeta}<title>دفتر</title>${visibleBriefHtml(brief)}<p>nbformat 4</p><p id="kernel-note">لم تُنفَّذ خلية على هذا الجهاز. يمكن تحرير الدفتر وتصديره بلا حاوية.</p><p id="save-note">الحفظ يكتب الخلية في الدفتر ولا ينفّذها.</p>${cells}`;
  return html;
}

export function writeNotebookPreview(workspace: string): void {
  const notebook = path.join(workspace, 'app', 'notebook.ipynb');
  if (fs.existsSync(notebook)) {
    const stat = fs.lstatSync(notebook);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  }
  const text = fs.readFileSync(notebook, 'utf8');
  const page = `${notebookPage(parseNotebook(text), storedBrief(workspace))}${csvPreview(localCsvText(workspace))}`;
  const file = path.join(workspace, 'app', 'preview.html');
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, page);
}

export function csvPreview(csv: { name: string; text: string } | null): string {
  if (!csv) return '';
  const rows = csv.text.replace(/\0/g, '').split(/\r?\n/).slice(0, 20).join('\n');
  return `<section><p>بيانات محلية — لم تُنفَّذ</p><pre>${escapeText(`${csv.name}\n${rows}`)}</pre></section>`;
}

function sourceText(source: unknown): string {
  if (typeof source === 'string') return source;
  if (Array.isArray(source) && source.every((line) => typeof line === 'string')) return source.join('');
  throw new Error('invalid_notebook');
}

function viewOutput(output: unknown): NotebookOutputView[] {
  if (!output || typeof output !== 'object') return [{ kind: 'inert', mime: 'unknown', text: '' }];
  const record = output as { output_type?: unknown; text?: unknown; data?: unknown; ename?: unknown; evalue?: unknown };
  if (record.output_type === 'stream') return [{ kind: 'text', text: sourceText(record.text) }];
  if (record.output_type === 'error' && record.ename === 'interrupted') {
    return [{ kind: 'text', text: 'أعيد تشغيل النواة وستحتاج إعادة تنفيذ الخلايا' }];
  }
  if (record.output_type === 'error') return [{ kind: 'text', text: `${String(record.ename ?? 'error')}: ${String(record.evalue ?? '')}` }];
  if (!record.data || typeof record.data !== 'object') return [{ kind: 'inert', mime: 'unknown', text: '' }];
  const data = record.data as Record<string, unknown>;
  const views: NotebookOutputView[] = [];
  const png = data['image/png'];
  if (typeof png === 'string' && png.length <= MAX_PNG && /^[A-Za-z0-9+/=\r\n]+$/.test(png)) views.push({ kind: 'png', base64: png.replace(/\s/g, '') });
  if (typeof data['text/plain'] === 'string') views.push({ kind: 'text', text: data['text/plain'] });
  for (const [mime, body] of Object.entries(data)) {
    if (mime === 'image/png' || mime === 'text/plain' || typeof body !== 'string') continue;
    views.push({ kind: 'inert', mime, text: body });
  }
  return views.length > 0 ? views : [{ kind: 'inert', mime: 'unknown', text: '' }];
}

function renderOutput(output: NotebookOutputView): string {
  switch (output.kind) {
    case 'text':
      return `<pre>${escapeText(output.text)}</pre>`;
    case 'png':
      return `<img alt="" src="data:image/png;base64,${output.base64}">`;
    case 'inert':
      return `<pre>${escapeText(`${output.mime}\n${output.text}`)}</pre>`;
    default: {
      const unknown: never = output;
      return unknown;
    }
  }
}

function escapeText(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ESCAPE[char] ?? char);
}
