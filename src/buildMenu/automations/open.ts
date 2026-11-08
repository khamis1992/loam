import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../../policy/paths.js';
import { BuildMenuError } from '../grants.js';
import { readManifest } from '../manifest.js';
import { catchUpLocalReport, type CatchUpResult } from './catchup.js';
import { activateLocalReports, disableLocalReports, pauseLocalReports, resumeLocalReports, type MailConnector } from './run.js';

const POINTER_NAME = /^app_[a-z2-7]{12}\.json$/;
let registryDir: string | null = null;

export function configureOpenRoutines(dir: string | null): void {
  registryDir = dir;
}

export function rememberOpenRoutine(registryDir: string, projectId: string, workspace: string): void {
  if (!/^app_[a-z2-7]{12}$/.test(projectId)) throw new BuildMenuError('invalid_request', 400);
  const root = path.resolve(registryDir);
  const target = path.resolve(workspace);
  if (!path.isAbsolute(target) || root === target || root.startsWith(`${target}${path.sep}`)) {
    throw new BuildMenuError('unsafe_path', 400);
  }
  const targetStat = fs.lstatSync(target);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new BuildMenuError('unsafe_path', 400);
  fs.mkdirSync(root, { recursive: true });
  const created = fs.lstatSync(root);
  if (!created.isDirectory() || created.isSymbolicLink()) throw new BuildMenuError('unsafe_path', 400);
  const pointer = path.join(root, `${projectId}.json`);
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(pointer);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
    if (code !== 'ENOENT') throw new BuildMenuError('unsafe_path', 400);
  }
  if (existing && (existing.isSymbolicLink() || existing.isDirectory() || existing.nlink > 1)) {
    throw new BuildMenuError('unsafe_path', 400);
  }
  fs.writeFileSync(pointer, `${JSON.stringify({ workspace: target })}\n`);
}

export function forgetOpenRoutine(registry: string, projectId: string): void {
  if (!/^app_[a-z2-7]{12}$/.test(projectId)) return;
  const file = path.join(path.resolve(registry), `${projectId}.json`);
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return;
  fs.rmSync(file);
}

export function activateOpenedRoutine(workspace: string): void {
  activateLocalReports(workspace);
  if (!registryDir) return;
  const manifest = readManifest(workspace);
  if (!manifest || manifest.selection.kind !== 'automation') return;
  rememberOpenRoutine(registryDir, manifest.projectId, workspace);
}

export function pauseOpenedRoutine(workspace: string): void {
  pauseLocalReports(workspace);
}

export function resumeOpenedRoutine(workspace: string): void {
  resumeLocalReports(workspace);
}

export function disableOpenedRoutine(workspace: string): void {
  disableLocalReports(workspace);
  if (!registryDir) return;
  const manifest = readManifest(workspace);
  if (!manifest) return;
  forgetOpenRoutine(registryDir, manifest.projectId);
}

function ownedAutomation(workspace: string, projectId: string): boolean {
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
    return manifest?.projectId === projectId && manifest.selection.kind === 'automation';
  } catch {
    return false;
  }
}

function openRegistryWorkspace(registryDir: string): string | null {
  const resolved = path.resolve(registryDir);
  const suffix = path.join('.loam', 'build-menu', 'open-routines');
  const fold = process.platform === 'win32' ? (value: string) => value.toLowerCase() : (value: string) => value;
  const haystack = fold(resolved);
  const needle = fold(suffix);
  const start = haystack.length - needle.length;
  if (start <= 0 || haystack.slice(start) !== needle || haystack[start - 1] !== path.sep) return null;
  const trimmed = resolved.slice(0, start).replace(/[\\/]+$/, '');
  if (!trimmed || trimmed.endsWith(':')) return null;
  return trimmed;
}

/** Runs only when a process calls it. A closed process never reaches this function. */
export function openRememberedRoutines(input: {
  registryDir: string;
  now: Date;
  connector: MailConnector;
}): CatchUpResult[] {
  if (!fs.existsSync(input.registryDir)) return [];
  const rootStat = fs.lstatSync(input.registryDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
  const boundary = openRegistryWorkspace(input.registryDir);
  const results: CatchUpResult[] = [];
  for (const name of fs.readdirSync(input.registryDir)) {
    if (!POINTER_NAME.test(name)) continue;
    const pointer = path.join(input.registryDir, name);
    try {
      const pointerStat = fs.lstatSync(pointer);
      if (!pointerStat.isFile() || pointerStat.isSymbolicLink() || pointerStat.nlink > 1) continue;
      const parsed = JSON.parse(fs.readFileSync(pointer, 'utf8')) as { workspace?: unknown };
      if (typeof parsed.workspace !== 'string' || !path.isAbsolute(parsed.workspace)) continue;
      if (boundary && !isInside(boundary, parsed.workspace)) continue;
      const workspaceStat = fs.lstatSync(parsed.workspace);
      if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) continue;
      const projectId = name.slice(0, -'.json'.length);
      if (!ownedAutomation(parsed.workspace, projectId)) {
        results.push({ ran: false, dueAt: null });
        continue;
      }
      results.push(catchUpLocalReport({
        workspace: parsed.workspace,
        now: input.now,
        connector: input.connector,
      }));
    } catch (error) {
      if (error instanceof BuildMenuError || error instanceof SyntaxError) {
        results.push({ ran: false, dueAt: null });
        continue;
      }
      throw error;
    }
  }
  return results;
}
