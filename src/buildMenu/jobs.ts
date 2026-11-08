import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD_KINDS, type BuildJobContext, type BuildManifest, type JobPhase, type JobSnapshot, type StartBuildRequest } from '../../packages/shared/src/buildMenu.js';
import { isInside } from '../policy/paths.js';
import { nextPhase } from './lifecycle.js';
import { redactEvidence, writeJobEvidence } from './evidence.js';
import { BuildMenuError, consumeGrant, grantedCellHash } from './grants.js';
import { configureRevisionGuard, readManifest } from './manifest.js';
import { readCellSource } from './notebooks/kernel.js';
import { PACKAGE_TIMEOUT_MS } from './deadlines.js';

export interface JobHooks {
  scaffold(ctx: BuildJobContext): Promise<void>;
  run?(ctx: BuildJobContext): Promise<void>;
}

interface StoredJob {
  id: string;
  projectId: string;
  revision: number;
  workspace: string;
  kind: BuildManifest['selection']['kind'];
  action: StartBuildRequest['operation']['action'];
  phase: JobSnapshot['phase'];
  code?: string;
  message?: string;
}

const jobs = new Map<string, StoredJob>();
const logs = new Map<string, string[]>();
const idempotency = new Map<string, { jobId: string; fingerprint: string }>();
const controllers = new Map<string, AbortController>();
const packageTimers = new Map<string, ReturnType<typeof setTimeout>>();
let packageTimeoutMs = PACKAGE_TIMEOUT_MS;
const MAX_LOG_LINES = 500;
const MAX_LOG_BYTES = 2048;
const JOB_ID = /^job_[a-z0-9_-]{1,80}$/i;
const PROJECT_ID = /^app_[a-z2-7]{12}$/;
const POINTER_NAME = /^app_[a-z2-7]{12}\.json$/;
let jobRegistryDir: string | null = null;
const KINDS = new Set<string>(BUILD_KINDS);
const ACTIONS = new Set<string>(['generate', 'preview', 'package', 'kernel-execute']);
const PHASES = new Set<string>(['queued', 'starting', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted']);

interface ActiveJobRecord {
  schemaVersion: 1;
  jobId: string;
  projectId: string;
  revision: number;
  kind: BuildManifest['selection']['kind'];
  action: StartBuildRequest['operation']['action'];
  phase: JobPhase;
}

function sameWorkspace(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (process.platform === 'win32') return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  return resolvedLeft === resolvedRight;
}

function workspaceHasActiveJob(workspace: string): boolean {
  for (const job of jobs.values()) {
    if (job.phase !== 'queued' && job.phase !== 'starting' && job.phase !== 'running' && job.phase !== 'stopping') continue;
    if (sameWorkspace(job.workspace, workspace)) return true;
  }
  return false;
}

configureRevisionGuard(workspaceHasActiveJob);

function projectIsBusy(projectId: string): boolean {
  for (const job of jobs.values()) {
    if (job.projectId !== projectId) continue;
    if (job.phase === 'queued' || job.phase === 'starting' || job.phase === 'running' || job.phase === 'stopping') return true;
  }
  return false;
}

function requestFingerprint(request: StartBuildRequest): string {
  return JSON.stringify({
    revision: request.expectedRevision,
    planSha256: request.planSha256,
    operation: request.operation,
  });
}

function cellHash(workspace: string, cellId: string): string {
  return createHash('sha256').update(readCellSource(workspace, cellId)).digest('hex');
}

function snapshot(job: StoredJob): JobSnapshot {
  if (job.phase === 'failed') {
    return { phase: 'failed', jobId: job.id, revision: job.revision, code: job.code ?? 'tool_failed', message: redactEvidence(job.message ?? 'failed') };
  }
  return { phase: job.phase, jobId: job.id, revision: job.revision };
}

export function configurePackageTimeout(ms: number | null): void {
  packageTimeoutMs = ms === null ? PACKAGE_TIMEOUT_MS : ms;
}

function clearPackageTimer(jobId: string): void {
  const timer = packageTimers.get(jobId);
  if (!timer) return;
  clearTimeout(timer);
  packageTimers.delete(jobId);
}

function armPackageTimer(job: StoredJob, controller: AbortController): void {
  if (job.action !== 'package') return;
  const timer = setTimeout(() => {
    packageTimers.delete(job.id);
    controller.abort();
    if (job.phase === 'cancelled' || job.phase === 'completed' || job.phase === 'failed' || job.phase === 'interrupted') return;
    if (job.phase === 'queued') {
      job.phase = 'cancelled';
      job.message = 'cancelled';
      commit(job);
      return;
    }
    if (job.phase === 'stopping') {
      settle(job, 'stopped');
      return;
    }
    settle(job, 'cancel');
    settle(job, 'stopped');
    job.message = 'cancelled';
  }, packageTimeoutMs);
  packageTimers.set(job.id, timer);
}

function settle(job: StoredJob, event: 'ready' | 'error' | 'cancel' | 'stopped' | 'complete'): void {
  if (job.phase === 'cancelled' || job.phase === 'completed' || job.phase === 'failed' || job.phase === 'interrupted') return;
  try {
    job.phase = nextPhase(job.phase, event);
  } catch {
    return;
  }
  commit(job);
  if (job.phase === 'cancelled') recordCancellation(job.projectId, job.id);
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function lstatOrMissing(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function assertNotHardLinked(file: string): void {
  const stat = lstatOrMissing(file);
  if (stat && !stat.isSymbolicLink() && stat.isFile() && stat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
}

function activeJobFile(workspace: string): string {
  const root = path.resolve(workspace);
  const file = path.join(root, '.loam', 'build-menu', 'active-job.json');
  if (!isInside(root, file)) throw new BuildMenuError('unsafe_path', 400);
  let cursor = root;
  for (const part of ['.loam', 'build-menu', 'active-job.json']) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) return file;
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new BuildMenuError('unsafe_path', 400);
  }
  return file;
}

function rememberJob(job: StoredJob): void {
  let temp: string | null = null;
  try {
    const root = path.resolve(job.workspace);
    if (!fs.existsSync(root)) return;
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;
    let file: string;
    try {
      file = activeJobFile(root);
    } catch (error) {
      if (errorCode(error) === 'EPERM') throw error;
      return;
    }
    const current = lstatOrMissing(file);
    if (current && (current.isSymbolicLink() || !current.isFile())) return;
    assertNotHardLinked(file);
    const pointer = jobPointerFile(job.projectId);
    if (pointer) assertNotHardLinked(pointer);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    temp = path.join(dir, `.active-job.${process.pid}.${randomUUID()}.tmp`);
    const body: ActiveJobRecord = {
      schemaVersion: 1,
      jobId: job.id,
      projectId: job.projectId,
      revision: job.revision,
      kind: job.kind,
      action: job.action,
      phase: job.phase,
    };
    fs.writeFileSync(temp, `${JSON.stringify(body)}\n`, { flag: 'wx' });
    assertNotHardLinked(file);
    fs.renameSync(temp, file);
    temp = null;
    writeJobPointer(job);
  } catch (error) {
    if (temp) {
      try { fs.rmSync(temp, { force: true }); } catch { /* the temp file is disposable */ }
    }
    if (errorCode(error) === 'EPERM') throw error;
    if (error instanceof BuildMenuError && error.message === 'unsafe_path') throw error;
  }
}

function forgetJob(job: StoredJob): void {
  try {
    const file = activeJobFile(job.workspace);
    if (!fs.existsSync(file)) return;
    const current = fs.lstatSync(file);
    if (current.isSymbolicLink() || !current.isFile()) return;
    if (current.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { jobId?: unknown };
    if (saved.jobId !== job.id) return;
    fs.rmSync(file);
    removeJobPointer(job.projectId);
  } catch (error) {
    if (errorCode(error) === 'EPERM') throw error;
    if (error instanceof BuildMenuError && error.message === 'unsafe_path') throw error;
    // A stuck sidecar must not undo a finished in-memory job.
  }
}

function commit(job: StoredJob): void {
  if (job.phase === 'queued' || job.phase === 'starting' || job.phase === 'running' || job.phase === 'stopping') {
    rememberJob(job);
    return;
  }
  forgetJob(job);
}

function readActiveRecord(file: string): ActiveJobRecord | null {
  const stat = lstatOrMissing(file);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (errorCode(error) === 'EPERM') throw error;
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return null;
  if (typeof raw.jobId !== 'string' || !JOB_ID.test(raw.jobId)) return null;
  if (typeof raw.projectId !== 'string' || !PROJECT_ID.test(raw.projectId)) return null;
  if (typeof raw.revision !== 'number' || !Number.isInteger(raw.revision) || raw.revision < 1) return null;
  if (typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return null;
  if (typeof raw.action !== 'string' || !ACTIONS.has(raw.action)) return null;
  if (typeof raw.phase !== 'string' || !PHASES.has(raw.phase)) return null;
  return {
    schemaVersion: 1,
    jobId: raw.jobId,
    projectId: raw.projectId,
    revision: raw.revision,
    kind: raw.kind as ActiveJobRecord['kind'],
    action: raw.action as ActiveJobRecord['action'],
    phase: raw.phase as JobPhase,
  };
}

export function configureJobRecovery(dir: string | null): void {
  jobRegistryDir = dir;
}

export function recoverRememberedJobs(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  const rootStat = fs.lstatSync(dir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new BuildMenuError('unsafe_path', 400);
  let count = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!POINTER_NAME.test(name)) continue;
    const pointer = path.join(dir, name);
    const stat = fs.lstatSync(pointer);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    if (stat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
    let parsed: { workspace?: unknown };
    try {
      parsed = JSON.parse(fs.readFileSync(pointer, 'utf8')) as { workspace?: unknown };
    } catch (error) {
      if (errorCode(error) === 'EPERM') throw error;
      continue;
    }
    if (typeof parsed.workspace !== 'string' || !path.isAbsolute(parsed.workspace)) continue;
    const projectId = name.slice(0, -'.json'.length);
    if (!ownedJobWorkspace(parsed.workspace, projectId)) continue;
    if (recoverActiveJob(parsed.workspace)) count += 1;
  }
  return count;
}

function ownedJobWorkspace(workspace: string, projectId: string): boolean {
  let resolved: string;
  try {
    resolved = path.resolve(workspace);
    const real = fs.realpathSync(resolved);
    const left = process.platform === 'win32' ? real.toLowerCase() : real;
    const right = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (left !== right) return false;
  } catch {
    return false;
  }
  try {
    const manifest = readManifest(resolved);
    return manifest?.projectId === projectId;
  } catch {
    return false;
  }
}

function jobPointerFile(projectId: string): string | null {
  if (!jobRegistryDir || !PROJECT_ID.test(projectId)) return null;
  return path.join(path.resolve(jobRegistryDir), `${projectId}.json`);
}

function writeJobPointer(job: StoredJob): void {
  const file = jobPointerFile(job.projectId);
  if (!file || !jobRegistryDir) return;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const created = fs.lstatSync(dir);
  if (!created.isDirectory() || created.isSymbolicLink()) return;
  const current = lstatOrMissing(file);
  if (current && (current.isSymbolicLink() || !current.isFile())) return;
  assertNotHardLinked(file);
  fs.writeFileSync(file, `${JSON.stringify({ workspace: path.resolve(job.workspace) })}\n`);
}

function removeJobPointer(projectId: string): void {
  if (!jobRegistryDir || !PROJECT_ID.test(projectId)) return;
  const file = path.join(path.resolve(jobRegistryDir), `${projectId}.json`);
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return;
  fs.rmSync(file);
}

/** Marks the project sidecar job interrupted. A saved pid is not ownership and is not signaled. */
export function recoverActiveJob(workspace: string): boolean {
  const file = activeJobFile(workspace);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (errorCode(error) === 'EPERM') throw error;
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
  const record = readActiveRecord(file);
  if (!record) return false;
  let phase: JobPhase;
  try {
    phase = nextPhase(record.phase, 'recover');
  } catch {
    return false;
  }
  const dir = path.dirname(file);
  const temp = path.join(dir, `.active-job.${process.pid}.${randomUUID()}.tmp`);
  const next: ActiveJobRecord = { ...record, phase };
  fs.writeFileSync(temp, `${JSON.stringify(next)}\n`, { flag: 'wx' });
  try {
    assertNotHardLinked(file);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* the temp file is disposable */ }
    throw error;
  }
  const memory = jobs.get(record.jobId);
  if (memory && memory.projectId === record.projectId && sameWorkspace(memory.workspace, workspace)) {
    clearPackageTimer(memory.id);
    controllers.get(memory.id)?.abort();
    if (memory.phase === 'queued' || memory.phase === 'starting' || memory.phase === 'running' || memory.phase === 'stopping') {
      memory.phase = nextPhase(memory.phase, 'recover');
    }
  }
  return true;
}

export function startJob(
  request: StartBuildRequest,
  sessionId: string,
  manifest: BuildManifest,
  workspace: string,
  hooks: JobHooks,
): JobSnapshot {
  if (!sessionId) throw new BuildMenuError('unauthenticated', 403);
  if (request.projectId !== manifest.projectId) throw new BuildMenuError('approval_required', 403);
  const idemKey = `${sessionId}\0${request.projectId}\0${request.idempotencyKey}`;
  const fingerprint = requestFingerprint(request);
  const previous = idempotency.get(idemKey);
  if (previous) {
    const existing = jobs.get(previous.jobId);
    if (!existing || existing.projectId !== request.projectId) throw new BuildMenuError('approval_required', 403);
    if (previous.fingerprint !== fingerprint) throw new BuildMenuError('invalid_request', 400);
    return snapshot(existing);
  }
  if (manifest.revision !== request.expectedRevision) throw new BuildMenuError('stale_revision', 409);
  if (projectIsBusy(request.projectId)) throw new BuildMenuError('busy', 409);
  const cellId = request.operation.action === 'kernel-execute' ? request.operation.cellId : undefined;
  const approvedHash = cellId
    ? grantedCellHash({ grantId: request.grantId, sessionId, projectId: request.projectId, cellId })
    : undefined;
  if (approvedHash && cellId && cellHash(workspace, cellId) !== approvedHash) {
    throw new BuildMenuError('stale_revision', 409);
  }
  consumeGrant({ ...request, sessionId });
  const job: StoredJob = {
    id: `job_${randomUUID()}`,
    projectId: request.projectId,
    revision: request.expectedRevision,
    workspace,
    kind: manifest.selection.kind,
    action: request.operation.action,
    phase: 'queued',
  };
  const controller = new AbortController();
  jobs.set(job.id, job);
  controllers.set(job.id, controller);
  idempotency.set(idemKey, { jobId: job.id, fingerprint });
  armPackageTimer(job, controller);
  commit(job);
  const ctx: BuildJobContext = { manifest, workspace, jobId: job.id, operation: request.operation, signal: controller.signal };
  queueMicrotask(() => {
    if (job.phase !== 'queued') {
      clearPackageTimer(job.id);
      return;
    }
    if (approvedHash && cellId) {
      try {
        if (cellHash(workspace, cellId) !== approvedHash) {
          job.code = 'stale_revision';
          job.message = 'stale_revision';
          settle(job, 'error');
          return;
        }
      } catch (error) {
        job.code = error instanceof BuildMenuError ? error.message : 'tool_failed';
        job.message = error instanceof Error ? error.message : 'tool_failed';
        settle(job, 'error');
        return;
      }
    }
    job.phase = 'starting';
    commit(job);
    const task = hooks.run
      ? hooks.run(ctx)
      : request.operation.action === 'generate'
        ? hooks.scaffold(ctx)
        : Promise.reject(new BuildMenuError('unsupported_operation', 400));
    task.then(() => {
      if (controller.signal.aborted) {
        settle(job, 'stopped');
        return;
      }
      const stored = readManifest(job.workspace);
      if (stored && stored.revision !== job.revision) {
        job.code = 'stale_revision';
        job.message = 'stale_revision';
        settle(job, 'error');
        return;
      }
      settle(job, 'ready');
      if (job.action !== 'preview') settle(job, 'complete');
    }).catch((error: unknown) => {
      job.code = error instanceof BuildMenuError ? error.message : 'tool_failed';
      job.message = error instanceof Error ? error.message : String(error);
      appendJobLog(job.id, job.message);
      settle(job, 'error');
    }).finally(() => clearPackageTimer(job.id));
  });
  return snapshot(job);
}

export function cancelJob(projectId: string, jobId: string): JobSnapshot {
  const job = jobs.get(jobId);
  if (!job || job.projectId !== projectId) throw new BuildMenuError('invalid_request', 404);
  clearPackageTimer(jobId);
  controllers.get(jobId)?.abort();
  if (job.phase === 'cancelled') return snapshot(job);
  if (job.phase === 'queued') {
    job.phase = 'cancelled';
    commit(job);
    recordCancellation(projectId, jobId);
    return snapshot(job);
  }
  settle(job, 'cancel');
  return snapshot(job);
}

export function recordCancellation(projectId: string, jobId: string): void {
  const job = jobs.get(jobId);
  if (!job || job.projectId !== projectId || job.phase !== 'cancelled') return;
  try {
    writeJobEvidence(job.workspace, job.id, {
      jobId: job.id,
      projectId: job.projectId,
      revision: job.revision,
      kind: job.kind,
      action: job.action,
      phase: 'cancelled',
      summary: 'cancelled',
    });
  } catch {
    // A missing evidence folder must not undo the cancellation.
  }
}

export function notePreviewCrashed(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job || job.phase === 'cancelled' || job.phase === 'completed' || job.phase === 'failed' || job.phase === 'interrupted') return;
  appendJobLog(jobId, 'preview exited');
  job.code = 'tool_failed';
  job.message = 'preview_exited';
  settle(job, 'error');
  try {
    writeJobEvidence(job.workspace, job.id, {
      jobId: job.id,
      projectId: job.projectId,
      revision: job.revision,
      kind: job.kind,
      action: job.action,
      phase: 'failed',
      summary: 'preview_exited',
    });
  } catch {
    // A missing evidence folder must not undo the recorded failure.
  }
}

export function noteReady(jobId: string, revision: number): void {
  const job = jobs.get(jobId);
  if (!job || job.revision !== revision) return;
  const stored = readManifest(job.workspace);
  if (stored && stored.revision !== job.revision) return;
  settle(job, 'ready');
}

export function readJob(projectId: string, jobId: string): JobSnapshot {
  const job = jobs.get(jobId);
  if (!job || job.projectId !== projectId) throw new BuildMenuError('invalid_request', 404);
  return snapshot(job);
}

export function appendJobLog(jobId: string, line: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  const list = logs.get(jobId) ?? [];
  list.push(boundLogLine(line));
  if (list.length > MAX_LOG_LINES) list.splice(0, list.length - MAX_LOG_LINES);
  logs.set(jobId, list);
}

export function readJobLog(projectId: string, jobId: string): string[] {
  const job = jobs.get(jobId);
  if (!job || job.projectId !== projectId) throw new BuildMenuError('invalid_request', 404);
  return [...(logs.get(jobId) ?? [])];
}

function boundLogLine(line: string): string {
  const redacted = redactEvidence(line);
  if (Buffer.byteLength(redacted) <= MAX_LOG_BYTES) return redacted;
  let end = redacted.length;
  while (end > 0 && Buffer.byteLength(redacted.slice(0, end)) > MAX_LOG_BYTES) end -= 1;
  return redacted.slice(0, end);
}

export function resetJobs(): void {
  for (const timer of packageTimers.values()) clearTimeout(timer);
  packageTimers.clear();
  for (const controller of controllers.values()) controller.abort();
  jobs.clear();
  logs.clear();
  idempotency.clear();
  controllers.clear();
}
