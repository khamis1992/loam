import fs from 'node:fs';
import path from 'node:path';

export interface Tuning {
  speed: number;
  gravity: number;
}

const DECODE_PASSES = 2;
const COLON_SCHEME = /(?:mailto|tel|sms|intent|market|javascript|data|file|blob)\s*:/i;
const WEB_SCHEME = /https?\s*:\/\//i;
const PROTOCOL_RELATIVE = /(?<!:)\/\//;
const QUOTE_SPLIT_WEB = /(?:['"]\s*)?(?:https?|javascript|mailto|tel|sms|intent|market|data|file|blob)\s*['"]\s*\+\s*['"]\s*:?\s*\/\//i;
const QUOTE_SPLIT_COLON = /(?:['"]\s*)?(?:javascript|mailto|tel|sms|intent|market|data|file|blob)\s*['"]\s*\+\s*['"]\s*:/i;

function decodePercent(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function collapseQuotes(value: string): string {
  let current = value.replace(/\\/g, '');
  let previous = '';
  while (current !== previous) {
    previous = current;
    current = current.replace(/['"]\s*\+\s*['"]/g, '');
  }
  return current;
}

function remember(forms: string[], seen: Set<string>, value: string): void {
  if (seen.has(value)) return;
  seen.add(value);
  forms.push(value);
}

function schemeForms(value: string): string[] {
  const forms: string[] = [];
  const seen = new Set<string>();
  let pending = [value];
  for (let depth = 0; depth <= DECODE_PASSES; depth += 1) {
    const layer = pending;
    pending = [];
    for (const item of layer) {
      const collapsed = collapseQuotes(item);
      remember(forms, seen, item);
      remember(forms, seen, collapsed);
      remember(forms, seen, item.replace(/['"]/g, ''));
      remember(forms, seen, collapsed.replace(/['"]/g, ''));
      if (depth >= DECODE_PASSES) continue;
      for (const next of [item, collapsed]) {
        const decoded = decodePercent(next);
        if (!seen.has(decoded)) pending.push(decoded);
      }
    }
  }
  return forms;
}

function hasScheme(value: string): boolean {
  return COLON_SCHEME.test(value)
    || WEB_SCHEME.test(value)
    || PROTOCOL_RELATIVE.test(value)
    || QUOTE_SPLIT_WEB.test(value)
    || QUOTE_SPLIT_COLON.test(value);
}

function containsRemote(value: string): boolean {
  return schemeForms(value).some((form) => hasScheme(form));
}

export function checkedTuning(value: Tuning): Tuning {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_tuning');
  let raw = '';
  try {
    raw = JSON.stringify(value);
  } catch {
    throw new Error('invalid_tuning');
  }
  if (containsRemote(raw)) throw new Error('invalid_tuning');
  const record = value as { speed?: unknown; gravity?: unknown };
  return {
    speed: boundedNumber(record.speed, 50, 500),
    gravity: boundedNumber(record.gravity, 100, 1500),
  };
}

function boundedNumber(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error('invalid_tuning');
  }
  return value;
}

export function loadTuningText(text: string): Tuning {
  if (containsRemote(text)) throw new Error('invalid_tuning');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('invalid_tuning');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_tuning');
  return checkedTuning(parsed as Tuning);
}

function tuningTarget(gameDir: string): string {
  const root = path.resolve(gameDir);
  const target = path.resolve(root, 'tuning.json');
  if (path.relative(root, target) !== 'tuning.json') throw new Error('unsafe_path');
  return target;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return typeof error.code === 'string' ? error.code : '';
}

function assertReplaceableFile(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    if (errorCode(error) === 'EPERM') throw error;
    throw new Error('unsafe_path');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
}

export function readLocalTuning(gameDir: string): Tuning {
  const target = tuningTarget(gameDir);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EPERM' || code === 'EACCES') throw error;
    throw new Error('invalid_tuning');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  return loadTuningText(fs.readFileSync(target, 'utf8'));
}

export function writeLocalTuning(gameDir: string, text: string): void {
  const root = path.resolve(gameDir);
  const target = tuningTarget(gameDir);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (errorCode(error) === 'EPERM') throw error;
    throw new Error('unsafe_path');
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('unsafe_path');
  assertReplaceableFile(target);
  loadTuningText(text);
  fs.writeFileSync(target, text, 'utf8');
  const written = fs.lstatSync(target);
  if (written.isSymbolicLink() || !written.isFile()) throw new Error('unsafe_path');
}
