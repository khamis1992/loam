import { BuildMenuError } from '../grants.js';
import { installsPackage } from './installGuard.js';

export const KERNEL_TIMEOUT_MS = 30_000;
export const MAX_KERNEL_LINE = 8_192;

const MESSAGE_TYPES = new Set(['status', 'stream', 'execute_result', 'display_data', 'error']);
const REMOTE_SCHEME = /https?\s*:\s*\/\s*\/|(?:javascript|data|file|blob|mailto|tel|sms|intent|market)\s*:/i;

export interface StoredOutput {
  output_type: 'stream' | 'display_data' | 'error';
  name?: 'stdout';
  text?: string[];
  data?: { 'text/plain'?: string; 'image/png'?: string };
  ename?: string;
  evalue?: string;
}

export function parseKernelStdout(raw: string, cellId: string): { text: string; outputs: StoredOutput[] } {
  const outputs: StoredOutput[] = [];
  let text = '';
  let visible = '';
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (line.length > MAX_KERNEL_LINE) throw new BuildMenuError('tool_failed', 500);
    const record = parsedLine(line);
    if (record.cellId !== cellId) continue;
    if (record.type === 'complete' || record.messageType === 'status') continue;
    if (record.type === 'error' || record.messageType === 'error') {
      const stored = storedError(record);
      visible = acceptText(visible, `${stored.ename ?? ''}${stored.evalue ?? ''}`);
      outputs.push(stored);
      continue;
    }
    if (record.type !== 'output' || typeof record.messageType !== 'string' || !MESSAGE_TYPES.has(record.messageType)) continue;
    const content = record.content;
    if (record.messageType === 'stream') {
      const stream = streamText(content);
      visible = acceptText(visible, streamSource(content));
      text += stream;
      outputs.push({ output_type: 'stream', name: 'stdout', text: [stream] });
      continue;
    }
    visible = acceptText(visible, plainSource(content));
    const stored = displayData(content);
    if (stored['text/plain']) text += stored['text/plain'];
    if (stored['text/plain'] || stored['image/png']) outputs.push({ output_type: 'display_data', data: stored });
  }
  return { text, outputs };
}

function parsedLine(line: string): Record<string, unknown> {
  try {
    const message = JSON.parse(line) as unknown;
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('bad');
    return message as Record<string, unknown>;
  } catch {
    throw new BuildMenuError('tool_failed', 500);
  }
}

const MISSING_LIBRARY = 'المكتبة غير موجودة في الصورة المثبتة. لن يُثبَّت شيء.';
const INSTALL_REFUSED = 'طلب التثبيت مرفوض. لن يُثبَّت شيء.';

function storedError(record: Record<string, unknown>): StoredOutput {
  const text = `${errorName(record)} ${errorText(record)}`;
  if (/ModuleNotFoundError|ImportError|No module named/i.test(text)) {
    return { output_type: 'error', ename: 'missing_library', evalue: MISSING_LIBRARY };
  }
  if (installsPackage(text)) {
    return { output_type: 'error', ename: 'approval_required', evalue: INSTALL_REFUSED };
  }
  return { output_type: 'error', ename: 'error', evalue: errorText(record) };
}

function errorName(record: Record<string, unknown>): string {
  const content = record.content;
  if (content && typeof content === 'object' && typeof (content as { ename?: unknown }).ename === 'string') {
    return (content as { ename: string }).ename.slice(0, 80);
  }
  return '';
}

function errorText(record: Record<string, unknown>): string {
  if (typeof record.error === 'string') return record.error.slice(0, 500);
  const content = record.content;
  if (content && typeof content === 'object' && typeof (content as { evalue?: unknown }).evalue === 'string') {
    return (content as { evalue: string }).evalue.slice(0, 500);
  }
  return 'error';
}

function streamText(content: unknown): string {
  return streamSource(content).slice(0, MAX_KERNEL_LINE);
}

function streamSource(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  return joinedText((content as { text?: unknown }).text);
}

function plainSource(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const data = (content as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return '';
  return joinedText((data as { 'text/plain'?: unknown })['text/plain']);
}

function joinedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join('');
  return '';
}

function acceptText(visible: string, chunk: string): string {
  if (chunk.length === 0) return visible;
  const next = visible + chunk;
  if (remoteOutput(next)) throw new BuildMenuError('unsafe_path', 400);
  return next;
}

function remoteOutput(value: string): boolean {
  if (schemeIn(value)) return true;
  const decoded = decodePercent(value);
  return decoded !== value && schemeIn(decoded);
}

function schemeIn(value: string): boolean {
  return REMOTE_SCHEME.test(value.replace(/[\r\n]/g, ''));
}

function decodePercent(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function displayData(content: unknown): { 'text/plain'?: string; 'image/png'?: string } {
  const stored: { 'text/plain'?: string; 'image/png'?: string } = {};
  if (!content || typeof content !== 'object') return stored;
  const data = (content as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return stored;
  const record = data as Record<string, unknown>;
  if (typeof record['text/plain'] === 'string') stored['text/plain'] = record['text/plain'].slice(0, MAX_KERNEL_LINE);
  const png = record['image/png'];
  if (typeof png === 'string' && png.length <= 1_000_000 && /^[A-Za-z0-9+/=]+$/.test(png)) stored['image/png'] = png;
  return stored;
}
