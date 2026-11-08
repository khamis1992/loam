import fs from 'node:fs';
import path from 'node:path';
import { nextCronRun } from '../../server/scheduleTime.js';
import { BuildMenuError } from '../grants.js';
import { runRoutine, writeProjectText, type MailConnector } from './run.js';

const WEEK_MS = 7 * 86_400_000;
const LOOKBACK_MS = 8 * 86_400_000;

interface RoutineFile {
  cron?: string;
  timezone?: string;
  send?: boolean;
  dryRun?: boolean;
  enabled?: boolean;
  paused?: boolean;
  until?: string;
  scheduleId?: string;
  prompt?: string;
}

interface CatchUpMarker {
  dedupeKey: string;
  lastDueAt: string;
}

export interface CatchUpResult {
  ran: boolean;
  dueAt: string | null;
}

/** One open tick. A closed process never calls this, so nothing runs while Loam is shut. */
export function catchUpLocalReport(input: {
  workspace: string;
  now: Date;
  connector: MailConnector;
}): CatchUpResult {
  const spec = readSpec(input.workspace);
  if (spec.enabled !== true || spec.paused === true) return { ran: false, dueAt: null };
  if (spec.send !== false || spec.dryRun !== true) throw new BuildMenuError('approval_required', 403);
  if (spec.cron !== '0 9 * * 1' || spec.timezone !== 'Asia/Qatar') throw new BuildMenuError('invalid_request', 400);
  const end = readUntil(spec.until);
  if (end !== null && input.now.getTime() > end) return { ran: false, dueAt: null };
  const due = latestDue(spec.cron, input.now);
  if (!due || (end !== null && due.getTime() > end)) return { ran: false, dueAt: null };
  const dueAt = due.toISOString();
  const scheduleId = typeof spec.scheduleId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(spec.scheduleId) ? spec.scheduleId : 'local';
  const dedupeKey = `${scheduleId}\u0000${dueAt}`;
  if (readMarker(input.workspace)?.dedupeKey === dedupeKey) return { ran: false, dueAt };
  if (!claimRun(input.workspace)) return { ran: false, dueAt };
  try {
    writeMarker(input.workspace, { dedupeKey, lastDueAt: dueAt });
    runRoutine({
      workspace: input.workspace,
      runId: `catch_${due.getTime()}`,
      dueAt,
      prompt: spec.prompt ?? 'dry-run local report only. Do not send, publish, purchase, or delete.',
      connector: input.connector,
    });
    return { ran: true, dueAt };
  } finally {
    releaseRun(input.workspace);
  }
}

function readUntil(until: string | undefined): number | null {
  if (until === undefined) return null;
  if (typeof until !== 'string') throw new BuildMenuError('invalid_request', 400);
  const end = Date.parse(until);
  if (!Number.isFinite(end)) throw new BuildMenuError('invalid_request', 400);
  return end;
}

function latestDue(cron: string, now: Date): Date | null {
  let cursor = new Date(now.getTime() - LOOKBACK_MS);
  let latest: Date | null = null;
  for (let index = 0; index < 4; index += 1) {
    const next = nextCronRun(cron, cursor, 'Asia/Qatar');
    if (next.getTime() > now.getTime()) break;
    if (latest && next.getTime() - latest.getTime() > WEEK_MS) break;
    latest = next;
    cursor = next;
  }
  return latest;
}

function readSpec(workspace: string): RoutineFile {
  const file = path.join(workspace, 'app', 'automation.json');
  assertReadableFile(file);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as RoutineFile;
}

function markerPath(workspace: string): string {
  return path.join(workspace, 'app', 'catchup.json');
}

function readMarker(workspace: string): CatchUpMarker | null {
  const file = markerPath(workspace);
  if (!fs.existsSync(file)) return null;
  assertReadableFile(file);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as CatchUpMarker;
}

const held = new Set<string>();

function workspaceKey(workspace: string): string {
  const resolved = path.resolve(workspace);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function holdCatchUp(workspace: string): () => void {
  const key = workspaceKey(workspace);
  held.add(key);
  return () => { held.delete(key); };
}

function claimRun(workspace: string): boolean {
  const key = workspaceKey(workspace);
  if (held.has(key)) return false;
  const lock = path.join(workspace, 'app', 'catchup.lock');
  if (fs.existsSync(lock)) {
    assertRegularFile(lock);
    fs.rmSync(lock);
  }
  try {
    fs.closeSync(fs.openSync(lock, 'wx'));
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
    if (code === 'EEXIST') return false;
    throw error;
  }
  held.add(key);
  return true;
}

function releaseRun(workspace: string): void {
  held.delete(workspaceKey(workspace));
  const lock = path.join(workspace, 'app', 'catchup.lock');
  if (!fs.existsSync(lock)) return;
  const stat = fs.lstatSync(lock);
  if (stat.isSymbolicLink() || !stat.isFile()) return;
  fs.rmSync(lock);
}

function assertRegularFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new BuildMenuError('unsafe_path', 400);
}

function assertReadableFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
}

function writeMarker(workspace: string, marker: CatchUpMarker): void {
  writeProjectText(workspace, 'catchup.json', `${JSON.stringify(marker)}\n`);
}
