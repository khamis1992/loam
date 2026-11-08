import fs from 'node:fs';
import path from 'node:path';
import { routineSendRequested } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { authorizeStep, type RoutineEffect } from './policy.js';

export interface MailConnector {
  send(message: { to: string; body: string }): void;
}

export interface RoutineResult {
  outcome: 'local-report' | 'approval_required';
}

export function recordPreview(workspace: string): number {
  const spec = readSpec(workspace);
  const previewCount = Number(spec.previewCount ?? 0) + 1;
  writeSpec(workspace, { ...spec, previewCount, enabled: spec.enabled === true });
  return previewCount;
}

export function activateLocalReports(workspace: string): void {
  const spec = readSpec(workspace);
  if (spec.send !== false || spec.dryRun !== true || Number(spec.previewCount ?? 0) < 3) {
    throw new BuildMenuError('approval_required', 403);
  }
  if (authorizeStep('external-send') !== 'approval-required') throw new BuildMenuError('tool_failed', 500);
  writeSpec(workspace, { ...spec, enabled: true });
}

export function disableLocalReports(workspace: string): void {
  const spec = readSpec(workspace);
  writeSpec(workspace, { ...spec, enabled: false, paused: false });
}

export function pauseLocalReports(workspace: string): void {
  const spec = readSpec(workspace);
  if (spec.enabled !== true || spec.send !== false || spec.dryRun !== true) {
    throw new BuildMenuError('approval_required', 403);
  }
  writeSpec(workspace, { ...spec, paused: true });
}

export function resumeLocalReports(workspace: string): void {
  const spec = readSpec(workspace);
  if (spec.enabled !== true || spec.send !== false || spec.dryRun !== true || spec.paused !== true) {
    throw new BuildMenuError('approval_required', 403);
  }
  writeSpec(workspace, { ...spec, paused: false });
}

const PROJECT_FILES = new Set(['automation.json', 'runs.jsonl', 'local-report.txt', 'proposed.json', 'catchup.json', 'schedule.txt', 'preview.html']);

function fileStat(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
    if (code === 'ENOENT') return null;
    throw new BuildMenuError('unsafe_path', 400);
  }
}

function assertInside(root: string, target: string): void {
  let relative = '';
  try {
    relative = path.relative(fs.realpathSync(root), fs.realpathSync(target));
  } catch {
    throw new BuildMenuError('unsafe_path', 400);
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new BuildMenuError('unsafe_path', 400);
}

const DRY_RUN_TEXT_FILES = new Set(['schedule.txt', 'preview.html', 'local-report.txt']);
const LITERAL_SCHEME = /javascript:|https?:\/\/|data:|file:|blob:|(?:mailto|tel|sms|intent|market):/i;
const ENCODED_SCHEME = /(?:javascript|https?|data|file|blob|mailto|tel|sms|intent|market)%3a/i;
const QUOTE_SPLIT_SCHEME = /(?:['"]\s*)?(?:javascript|https?|data|file|blob|mailto|tel|sms|intent|market)\s*['"]\s*\+\s*['"]\s*:?\/\//i;
const QUOTE_SPLIT_COLON = /(?:['"]\s*)?(?:javascript|data|file|blob|mailto|tel|sms|intent|market)\s*['"]\s*\+\s*['"]\s*:/i;
const PROTOCOL_RELATIVE = /(?<!:)\/\/[A-Za-z0-9]/;
const WEBHOOK_URL = /\bwebhook\b[\s"'()[\]=:]*?(?:(?:javascript|https?|data|file|blob|mailto|tel|sms|intent|market)\s*:|\/\/)/i;
const WEBHOOK_QUOTE = /\bwebhook\b\s*['"]\s*\+\s*['"]\s*(?:(?:javascript|https?|data|file|blob|mailto|tel|sms|intent|market)\s*:|:?\/\/)/i;

function percentDecode(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function blockedDryRunText(text: string): boolean {
  return LITERAL_SCHEME.test(text)
    || ENCODED_SCHEME.test(text)
    || QUOTE_SPLIT_SCHEME.test(text)
    || QUOTE_SPLIT_COLON.test(text)
    || PROTOCOL_RELATIVE.test(text)
    || WEBHOOK_URL.test(text)
    || WEBHOOK_QUOTE.test(text);
}

function assertDryRunText(name: string, text: string): void {
  if (!DRY_RUN_TEXT_FILES.has(name)) return;
  let decoded = text;
  for (let pass = 0; pass < 3; pass += 1) {
    if (blockedDryRunText(decoded)) throw new BuildMenuError('unsafe_path', 400);
    const next = percentDecode(decoded);
    if (next === decoded) return;
    decoded = next;
  }
}

function nodeCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function assertExclusiveReport(file: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return;
    throw error;
  }
  if (stat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
}

export function writeProjectText(workspace: string, name: string, text: string, append = false): void {
  if (!PROJECT_FILES.has(name)) throw new BuildMenuError('unsafe_path', 400);
  const root = path.resolve(workspace);
  const rootStat = fileStat(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new BuildMenuError('unsafe_path', 400);
  const dir = path.join(root, 'app');
  const existingDir = fileStat(dir);
  if (existingDir) {
    if (existingDir.isSymbolicLink() || !existingDir.isDirectory()) throw new BuildMenuError('unsafe_path', 400);
  } else {
    try {
      fs.mkdirSync(dir);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
      if (code !== 'EEXIST') throw new BuildMenuError('unsafe_path', 400);
    }
  }
  const dirStat = fileStat(dir);
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new BuildMenuError('unsafe_path', 400);
  assertInside(root, dir);
  const file = path.join(dir, name);
  if (name === 'local-report.txt' || append) assertExclusiveReport(file);
  const existingFile = fileStat(file);
  if (existingFile && (existingFile.isSymbolicLink() || !existingFile.isFile())) throw new BuildMenuError('unsafe_path', 400);
  assertDryRunText(name, text);
  if (append) fs.appendFileSync(file, text);
  else fs.writeFileSync(file, text);
  const written = fileStat(file);
  if (!written || written.isSymbolicLink() || !written.isFile()) throw new BuildMenuError('unsafe_path', 400);
  assertInside(root, file);
}

export function runRoutine(input: {
  workspace: string;
  runId: string;
  dueAt: string;
  prompt: string;
  connector: MailConnector;
}): RoutineResult {
  if (/FULL_AUTO/i.test(input.prompt)) {
    writeRun(input.workspace, { runId: input.runId, dueAt: input.dueAt, timezone: 'Asia/Qatar', outcome: 'approval_required' });
    throw new BuildMenuError('approval_required', 403);
  }
  const effect = classifyPrompt(input.prompt);
  if (authorizeStep(effect) !== 'allowed') {
    writeProjectText(input.workspace, 'proposed.json', `${JSON.stringify(proposalFor(effect, input.prompt))}\n`);
    writeRun(input.workspace, { runId: input.runId, dueAt: input.dueAt, timezone: 'Asia/Qatar', outcome: 'approval_required' });
    return { outcome: 'approval_required' };
  }
  writeProjectText(input.workspace, 'local-report.txt', `تقرير محلي\n${input.dueAt}\n`);
  writeRun(input.workspace, { runId: input.runId, dueAt: input.dueAt, timezone: 'Asia/Qatar', outcome: 'local-report' });
  return { outcome: 'local-report' };
}

function requestedEffect(prompt: string): 'publish' | 'purchase' | 'delete' | null {
  const text = prompt
    .replace(/do not (?:send|publish|purchase|buy|delete)(?:\s*,\s*(?:or\s+)?(?:send|publish|purchase|buy|delete))*/gi, ' ')
    .replace(/لا\s*(?:ترسل|تنشر|تشتر|تحذف)/g, ' ');
  if (/\bpublish\b|انشر/i.test(text)) return 'publish';
  if (/\b(?:purchase|buy)\b|اشتر/i.test(text)) return 'purchase';
  if (/\bdelete\b|احذف/i.test(text)) return 'delete';
  return null;
}

type SendProposal = { recipient: string; body: string; status: 'approval_required' };
type EffectProposal = { effect: 'publish' | 'purchase' | 'delete'; status: 'approval_required' };

function proposalFor(effect: RoutineEffect, prompt: string): SendProposal | EffectProposal {
  switch (effect) {
    case 'local-report':
      throw new BuildMenuError('tool_failed', 500);
    case 'external-send': {
      const recipient = prompt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? '';
      return { recipient, body: prompt, status: 'approval_required' };
    }
    case 'publish':
    case 'purchase':
    case 'delete':
      return { effect, status: 'approval_required' };
    default: {
      const unknown: never = effect;
      return unknown;
    }
  }
}

function classifyPrompt(prompt: string): 'local-report' | 'external-send' | 'publish' | 'purchase' | 'delete' {
  const effect = requestedEffect(prompt);
  if (effect) return effect;
  return routineSendRequested(prompt) ? 'external-send' : 'local-report';
}

function readSpec(workspace: string): { send?: boolean; dryRun?: boolean; enabled?: boolean; previewCount?: number; paused?: boolean } {
  const file = path.join(workspace, 'app', 'automation.json');
  assertExclusiveReport(file);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as { send?: boolean; dryRun?: boolean; enabled?: boolean; previewCount?: number; paused?: boolean };
}

function writeSpec(workspace: string, spec: { send?: boolean; dryRun?: boolean; enabled?: boolean; previewCount?: number; paused?: boolean }): void {
  writeProjectText(workspace, 'automation.json', `${JSON.stringify(spec, null, 2)}\n`);
}

function writeRun(workspace: string, entry: { runId: string; dueAt: string; timezone: 'Asia/Qatar'; outcome: RoutineResult['outcome'] }): void {
  writeProjectText(workspace, 'runs.jsonl', `${JSON.stringify(entry)}\n`, true);
}
