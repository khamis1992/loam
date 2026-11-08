import fs from 'node:fs';
import path from 'node:path';
import { BuildMenuError } from '../grants.js';
import { authorizeStep } from './policy.js';

export interface DryRunSchedule {
  id: string;
  enabled: boolean;
}

const REMOTE_TOKENS = ['mailto', 'tel', 'sms', 'intent', 'market', 'https', 'javascript'] as const;

export function registerDryRun(
  workspace: string,
  add: (row: { prompt: string; cron: string; timezone: string; enabled: false }) => DryRunSchedule,
): { scheduleId: string; enabled: false } {
  const file = path.join(workspace, 'app', 'automation.json');
  const spec = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    cron?: string;
    timezone?: string;
    send?: boolean;
    dryRun?: boolean;
    scheduleId?: string;
    prompt?: unknown;
  };
  if (spec.send !== false || spec.dryRun !== true) throw new BuildMenuError('approval_required', 403);
  if (authorizeStep('external-send') !== 'approval-required' || authorizeStep('local-report') !== 'allowed') {
    throw new BuildMenuError('tool_failed', 500);
  }
  if (remoteField(spec.prompt) || remoteField(spec.cron)) throw new BuildMenuError('unsafe_path', 400);
  if (spec.scheduleId) return { scheduleId: spec.scheduleId, enabled: false };
  if (spec.cron !== '0 9 * * 1' || spec.timezone !== 'Asia/Qatar') throw new BuildMenuError('invalid_request', 400);
  assertExclusiveSpec(file);
  const created = add({
    prompt: 'dry-run local report only. Do not send, publish, purchase, or delete.',
    cron: spec.cron,
    timezone: spec.timezone,
    enabled: false,
  });
  if (created.enabled !== false) throw new BuildMenuError('tool_failed', 500);
  fs.writeFileSync(file, `${JSON.stringify({ ...spec, scheduleId: created.id }, null, 2)}\n`);
  return { scheduleId: created.id, enabled: false };
}

function assertExclusiveSpec(file: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return;
    throw error;
  }
  if (stat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
}

function nodeCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function remoteField(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (hasRemoteToken(value)) return true;
  const decoded = decodeOnce(value);
  return decoded !== value && hasRemoteToken(decoded);
}

function hasRemoteToken(value: string): boolean {
  const lower = value.toLowerCase();
  return REMOTE_TOKENS.some((token) => lower.includes(token));
}

function decodeOnce(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}
