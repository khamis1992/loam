import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppProject } from '../../appbuilder/types.js';
import { ROOT as APP_ROOT } from '../../config.js';
import { desktopTemplateTitle, isDesktopTemplateId } from './catalog.js';
import { readDesktopVerification } from './project.js';
import { taskPath } from '../../server/taskWorkspace.js';

const exec = promisify(execFile);
const rootRequire = createRequire(path.join(APP_ROOT, 'package.json'));

export interface DesktopPackage {
  projectId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  builtAt: string;
  signed: false;
}

function packageEvidencePath(project: AppProject): string {
  return path.join(project.workspaceDir, '.loam', 'packs', 'loam-desktop', 'package.json');
}

function fileName(project: AppProject): string {
  const template = project.features[0] ?? 'file-organizer';
  return `Loam-${template}-Setup-0.1.0.exe`;
}

export function readDesktopPackage(project: AppProject): DesktopPackage | null {
  const file = packageEvidencePath(project);
  if (!fs.existsSync(file)) return null;
  const info = JSON.parse(fs.readFileSync(file, 'utf8')) as DesktopPackage;
  if (info.projectId !== project.id || info.fileName !== fileName(project) || info.signed !== false) throw new Error('desktop_package_mismatch');
  return info;
}

export function desktopReleaseFile(project: AppProject): string {
  const info = readDesktopPackage(project);
  if (!info) throw new Error('desktop_package_required');
  return taskPath(project.workspaceDir, path.join(project.appDir, 'release', info.fileName));
}

export function clearDesktopPackage(project: AppProject): void {
  fs.rmSync(packageEvidencePath(project), { force: true });
}

function runBuilder(appDir: string, configPath: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const builderRoot = path.dirname(rootRequire.resolve('electron-builder/package.json'));
    const child = spawn(process.execPath, [path.join(builderRoot, 'out', 'cli', 'cli.js'), '--win', 'nsis', '--publish', 'never', '--config', configPath], {
      cwd: appDir,
      windowsHide: true,
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      output += '\nDesktop packaging timed out.';
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill();
    }, 600_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, output: `${output}\n${error.message}` });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

export async function packageDesktopProject(project: AppProject, destinationWorkspace: string): Promise<DesktopPackage> {
  readDesktopVerification(project);
  const appDir = path.join(project.workspaceDir, project.appDir);
  const template = isDesktopTemplateId(project.features[0]) ? project.features[0] : 'file-organizer';
  const artifact = fileName(project);
  const electron = rootRequire('electron') as string;
  const config = {
    appId: `app.loam.generated.${project.id.replace(/[^a-z0-9]/g, '')}`,
    productName: desktopTemplateTitle(template as never),
    directories: { output: 'release' },
    files: ['dist/**/*', 'electron/**/*', 'desktop-app.json', 'fixtures/**/*', 'package.json'],
    asar: true,
    electronDist: path.dirname(electron),
    electronVersion: rootRequire('electron/package.json').version as string,
    npmRebuild: false,
    win: { target: 'nsis', icon: path.join(APP_ROOT, 'electron', 'assets', 'loam.ico') },
    nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false, artifactName: artifact },
  };
  const configPath = path.join(appDir, 'electron-builder.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  const result = await runBuilder(appDir, configPath);
  if (result.code !== 0) throw new Error(`desktop_packaging_failed: ${result.output.slice(-6000)}`);
  const release = path.join(appDir, 'release', artifact);
  if (!fs.existsSync(release)) throw new Error('desktop_installer_missing');
  const bytes = fs.readFileSync(release);
  const info: DesktopPackage = {
    projectId: project.id,
    fileName: artifact,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    builtAt: new Date().toISOString(),
    signed: false,
  };
  const destination = taskPath(destinationWorkspace, `uploads/${artifact}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(release, destination);
  const evidence = packageEvidencePath(project);
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.writeFileSync(evidence, JSON.stringify(info, null, 2));
  return info;
}

export async function revealDesktopProject(project: AppProject): Promise<void> {
  const file = desktopReleaseFile(project);
  if (!fs.existsSync(file)) throw new Error('desktop_installer_missing');
  try {
    await exec('explorer.exe', [`/select,${file}`], { windowsHide: true });
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || ![0, 1].includes(Number((error as { code?: number }).code))) throw error;
  }
}
