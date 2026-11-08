import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../../policy/paths.js';
import { BuildMenuError } from '../grants.js';
import { readManifest } from '../manifest.js';

const POINTER_NAME = /^app_[a-z2-7]{12}\.json$/;
const NONCE = /^[a-f0-9]{16}$/;
const CELL_ID = /^[A-Za-z0-9_-]{1,80}$/;
let registryDir: string | null = null;

export function configureKernelRecovery(dir: string | null): void {
  registryDir = dir;
}

export function rememberRunningLease(workspace: string, record: { nonce: string; projectId: string; jobId: string; cellId: string }): void {
  if (!NONCE.test(record.nonce) || !CELL_ID.test(record.cellId)) throw new BuildMenuError('invalid_request', 400);
  writeRegular(leasePath(workspace), `${JSON.stringify({ ...record, activeCellJobId: record.jobId, phase: 'running' })}\n`);
  if (!registryDir || !/^app_[a-z2-7]{12}$/.test(record.projectId)) return;
  writeRegular(path.join(registryDir, `${record.projectId}.json`), `${JSON.stringify({ workspace: path.resolve(workspace) })}\n`);
}

export function releaseActiveKernelCell(workspace: string, record: { nonce: string; projectId: string; cellId: string }): void {
  if (!NONCE.test(record.nonce) || !CELL_ID.test(record.cellId)) throw new BuildMenuError('invalid_request', 400);
  writeRegular(leasePath(workspace), `${JSON.stringify({
    nonce: record.nonce,
    projectId: record.projectId,
    jobId: '',
    cellId: record.cellId,
    activeCellJobId: null,
    phase: 'running',
  })}\n`);
}

export function forgetKernelLease(workspace: string, projectId: string): void {
  removeRegular(leasePath(workspace));
  if (!registryDir || !/^app_[a-z2-7]{12}$/.test(projectId)) return;
  removeRegular(path.join(registryDir, `${projectId}.json`));
}

export function recoverKernelLease(workspace: string): boolean {
  const file = leasePath(workspace);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (missingFile(error)) return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new BuildMenuError('unsafe_path', 400);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    nonce?: unknown;
    cellId?: unknown;
    phase?: unknown;
    projectId?: unknown;
    jobId?: unknown;
    activeCellJobId?: unknown;
  };
  if (typeof raw.nonce !== 'string' || !NONCE.test(raw.nonce) || typeof raw.cellId !== 'string' || !CELL_ID.test(raw.cellId)) return false;
  if (raw.phase === 'interrupted') return false;
  const idle = Object.hasOwn(raw, 'activeCellJobId') && (raw.activeCellJobId === null || raw.activeCellJobId === '');
  if (!idle) markCellInterrupted(workspace, raw.cellId);
  writeRegular(file, `${JSON.stringify({ nonce: raw.nonce, projectId: raw.projectId ?? '', jobId: raw.jobId ?? '', cellId: raw.cellId, phase: 'interrupted' })}\n`);
  return true;
}

export function recoverRememberedKernels(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  const rootStat = fs.lstatSync(dir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new BuildMenuError('unsafe_path', 400);
  const boundary = notebookProject(dir);
  let count = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!POINTER_NAME.test(name)) continue;
    const pointer = path.join(dir, name);
    const stat = fs.lstatSync(pointer);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const parsed = JSON.parse(fs.readFileSync(pointer, 'utf8')) as { workspace?: unknown };
    if (typeof parsed.workspace !== 'string' || !path.isAbsolute(parsed.workspace)) continue;
    if (boundary && !insideNotebook(boundary, parsed.workspace)) continue;
    const projectId = name.slice(0, -'.json'.length);
    if (!ownedNotebook(parsed.workspace, projectId)) continue;
    if (recoverKernelLease(parsed.workspace)) count += 1;
  }
  return count;
}

function notebookProject(registryDir: string): string | null {
  const resolved = path.resolve(registryDir);
  const suffix = path.join('.loam', 'build-menu', 'kernel-leases');
  const fold = process.platform === 'win32' ? (value: string) => value.toLowerCase() : (value: string) => value;
  const haystack = fold(resolved);
  const needle = fold(suffix);
  const start = haystack.length - needle.length;
  if (start <= 0 || haystack.slice(start) !== needle || haystack[start - 1] !== path.sep) return null;
  const trimmed = resolved.slice(0, start).replace(/[\\/]+$/, '');
  if (!trimmed || trimmed.endsWith(':')) return null;
  return trimmed;
}

function insideNotebook(boundary: string, workspace: string): boolean {
  const resolved = path.resolve(workspace);
  if (!isInside(boundary, resolved)) return false;
  try {
    return isInside(fs.realpathSync(boundary), fs.realpathSync(resolved));
  } catch {
    return false;
  }
}

function ownedNotebook(workspace: string, projectId: string): boolean {
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
    return manifest?.projectId === projectId && manifest.selection.kind === 'notebook';
  } catch {
    return false;
  }
}

function leasePath(workspace: string): string {
  return path.join(workspace, '.loam', 'build-menu', 'kernel-lease.json');
}

function markCellInterrupted(workspace: string, cellId: string): void {
  const file = path.join(workspace, 'app', 'notebook.ipynb');
  if (!writableFile(file)) return;
  const notebook = JSON.parse(fs.readFileSync(file, 'utf8')) as { cells?: Array<{ id?: string; source?: unknown; outputs?: unknown[] }> };
  const cell = notebook.cells?.find((item) => item.id === cellId);
  if (!cell) return;
  cell.outputs = [{ output_type: 'error', ename: 'interrupted', evalue: 'interrupted' }];
  if (!writableFile(file)) return;
  fs.writeFileSync(file, `${JSON.stringify(notebook, null, 2)}\n`);
}

function writeRegular(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writableFile(file);
  fs.writeFileSync(file, text);
}

function writableFile(file: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (missingFile(error)) return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
  return true;
}

function missingFile(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : '';
  return code === 'ENOENT';
}

function removeRegular(file: string): void {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return;
  fs.rmSync(file);
}
