import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../../policy/paths.js';
import { redactEvidence } from '../evidence.js';
import { BuildMenuError } from '../grants.js';
import { killOwnedTree, leaseEnv } from '../processLease.js';

const BLOCKED = /disable-web-security|remote-debugging-port|remote-debugging-pipe/i;

export function defaultChromeUserData(): string {
  const local = process.env.LOCALAPPDATA || process.env.HOME || '';
  return path.join(local, 'Google', 'Chrome', 'User Data');
}

export function chromeLaunchArgs(input: { profileDir: string; extensionDir: string; userDataRoot: string }): string[] {
  const profileDir = path.resolve(input.profileDir);
  const extensionDir = path.resolve(input.extensionDir);
  const userDataRoot = path.resolve(input.userDataRoot);
  if (!profileDir || isInside(userDataRoot, profileDir)) throw new BuildMenuError('unsafe_path', 400);
  if (!fs.existsSync(extensionDir) || fs.lstatSync(extensionDir).isSymbolicLink()) throw new BuildMenuError('unsafe_path', 400);
  const args = [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extensionDir}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--new-window',
    'about:blank',
  ];
  if (args.some((arg) => BLOCKED.test(arg) || /[;&|<>]/.test(arg))) throw new BuildMenuError('unsafe_path', 400);
  return args;
}

const JOB_ID = /^job_[a-z0-9_-]{1,80}$/i;
const NOTE_SCHEME = /https|javascript|mailto/i;

function unsafeNoteSegment(value: string): boolean {
  return NOTE_SCHEME.test(value) || value.includes('/') || value.includes('\\');
}

function workspaceSegments(workspace: string): string[] {
  const divided = workspace.split(/[/\\]+/).filter((part) => part.length > 0);
  const native = workspace.split(path.sep).filter((part) => part.length > 0);
  return [...divided, ...native];
}

export function writeUnpackedInstructions(workspace: string, jobId: string, opened: boolean): string {
  if (!JOB_ID.test(jobId)) throw new BuildMenuError('invalid_request', 400);
  if (unsafeNoteSegment(jobId) || workspaceSegments(workspace).some(unsafeNoteSegment)) {
    throw new BuildMenuError('unsafe_path', 400);
  }
  const root = path.resolve(workspace);
  const extensionDir = path.join(root, 'app');
  const profileDir = path.resolve(root, '.loam', 'build-menu', 'chrome-profile', jobId);
  const relative = path.relative(root, profileDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new BuildMenuError('unsafe_path', 400);
  fs.mkdirSync(profileDir, { recursive: true });
  const shared = [
    'فعّل وضع المطوّر ثم اختر Load unpacked وحدد مجلد الإضافة.',
    'صلاحية activeTab مؤقتة للصفحة الحالية فقط. لا تُمنح all_urls.',
    'لا تعطّل حماية المتصفح.',
    `المجلد: ${extensionDir}`,
  ];
  const text = (opened === true
    ? ['هذه نافذة ملف شخصي مؤقت، وليست متصفح الحساب.', 'إذا لم تظهر الإضافة، افتح chrome://extensions في هذه النافذة.', ...shared, `الملف الشخصي: ${profileDir}`]
    : ['لم تُفتح نافذة Chrome.', ...shared]).join('\n');
  const file = path.join(extensionDir, 'unpacked.txt');
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
  }
  fs.writeFileSync(file, `${text}\n`);
  return file;
}

export function chromePreviewSummary(workspace: string, url: string): string {
  const file = path.join(workspace, 'app', 'unpacked.txt');
  if (!fs.existsSync(file)) return url;
  const stat = fs.lstatSync(file);
  if (stat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
  if (stat.isSymbolicLink()) return url;
  const text = redactEvidence(fs.readFileSync(file, 'utf8')).trim();
  if (!text || /https?:\/\//i.test(text)) return url;
  return text;
}

export async function openIsolatedChrome(input: {
  executable: string;
  workspace: string;
  jobId: string;
  signal?: AbortSignal;
  spawnImpl?: typeof spawn;
}): Promise<ChildProcess> {
  if (input.signal?.aborted) throw new BuildMenuError('cancelled', 409);
  if (!fs.existsSync(input.executable)) throw new BuildMenuError('missing_requirement', 400);
  writeUnpackedInstructions(input.workspace, input.jobId, false);
  const args = chromeLaunchArgs({
    profileDir: path.join(input.workspace, '.loam', 'build-menu', 'chrome-profile', input.jobId),
    extensionDir: path.join(input.workspace, 'app'),
    userDataRoot: defaultChromeUserData(),
  });
  const child = (input.spawnImpl ?? spawn)(input.executable, args, {
    cwd: path.join(input.workspace, 'app'),
    env: leaseEnv(),
    shell: false,
    windowsHide: false,
    stdio: 'ignore',
  });
  if (input.signal?.aborted || !child.pid) {
    writeUnpackedInstructions(input.workspace, input.jobId, false);
    if (child.pid) await stopIsolatedChrome(child);
    throw new BuildMenuError(input.signal?.aborted ? 'cancelled' : 'tool_failed', input.signal?.aborted ? 409 : 500);
  }
  writeUnpackedInstructions(input.workspace, input.jobId, true);
  const onAbort = (): void => {
    input.signal?.removeEventListener('abort', onAbort);
    void stopIsolatedChrome(child);
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  child.once('exit', () => input.signal?.removeEventListener('abort', onAbort));
  return child;
}

export async function stopIsolatedChrome(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  child.kill('SIGTERM');
  if (await exitedWithin(child, 1_000)) return;
  if (child.pid !== pid || child.exitCode !== null) return;
  if (process.platform === 'win32') await killOwnedTree(pid);
  else child.kill('SIGKILL');
  await exitedWithin(child, 3_000);
}

function exitedWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode !== null || child.signalCode !== null), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
