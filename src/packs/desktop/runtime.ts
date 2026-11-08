import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import type { AppProject } from '../../appbuilder/types.js';
import { recordRuntimeError } from '../../appbuilder/runtimeErrors.js';
import { ROOT as APP_ROOT } from '../../config.js';

const exec = promisify(execFile);
const rootRequire = createRequire(path.join(APP_ROOT, 'package.json'));

export interface DesktopRuntime {
  pid: number;
  projectId: string;
  workspaceDir: string;
  logPath: string;
  debugPort: number;
}

export function runtimePath(project: AppProject): string {
  return path.join(project.workspaceDir, '.loam', 'runtime', 'process.json');
}

export function debugPort(project: AppProject): number {
  return 20_000 + (createHash('sha256').update(project.id).digest().readUInt16BE(0) % 20_000);
}

export async function launchDesktopRuntime(project: AppProject): Promise<DesktopRuntime> {
  const file = runtimePath(project);
  if (fs.existsSync(file)) {
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as DesktopRuntime;
    try {
      process.kill(current.pid, 0);
      return current;
    } catch {
      fs.rmSync(file, { force: true });
    }
  }
  const runtimeDir = path.dirname(file);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const logPath = path.join(runtimeDir, 'output.log');
  const output = fs.openSync(logPath, 'a');
  const executable = rootRequire('electron') as string;
  const child = spawn(executable, ['.'], {
    cwd: path.join(project.workspaceDir, project.appDir),
    env: {
      ...process.env,
      LOAM_USER_DATA_DIR: path.join(runtimeDir, 'profile'),
      LOAM_ACCEPTANCE_DEBUG_PORT: String(debugPort(project)),
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  if (!child.pid) throw new Error('desktop_launch_failed');
  child.stdout.on('data', (chunk: Buffer) => fs.writeSync(output, chunk));
  child.stderr.on('data', (chunk: Buffer) => {
    fs.writeSync(output, chunk);
    const message = chunk.toString().trim();
    if (message) recordRuntimeError(project.id, { kind: 'error', message, stack: null, source: null, url: null });
  });
  child.once('error', (error) => {
    recordRuntimeError(project.id, { kind: 'error', message: error.message, stack: error.stack ?? null, source: null, url: null });
  });
  child.unref();
  const runtime: DesktopRuntime = { pid: child.pid, projectId: project.id, workspaceDir: project.workspaceDir, logPath, debugPort: debugPort(project) };
  fs.writeFileSync(file, JSON.stringify(runtime, null, 2));
  return runtime;
}

export async function stopDesktopRuntime(project: AppProject): Promise<void> {
  const file = runtimePath(project);
  if (!fs.existsSync(file)) return;
  const runtime = JSON.parse(fs.readFileSync(file, 'utf8')) as DesktopRuntime;
  if (runtime.projectId !== project.id || runtime.workspaceDir !== project.workspaceDir) throw new Error('desktop_runtime_mismatch');
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId=${runtime.pid}" | Select-Object -ExpandProperty ExecutablePath`], { windowsHide: true });
    if (!stdout.trim()) {
      fs.rmSync(file, { force: true });
      return;
    }
    if (stdout.trim().toLowerCase() !== rootRequire('electron').toLowerCase()) throw new Error('desktop_runtime_command_mismatch');
    await exec('taskkill', ['/PID', String(runtime.pid), '/T', '/F'], { windowsHide: true });
  } else {
    process.kill(runtime.pid, 'SIGTERM');
  }
  fs.rmSync(file, { force: true });
}
