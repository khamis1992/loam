import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  timeout: 10 * 60 * 1000,
  windowsHide: true,
  shell: process.platform === 'win32',
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) process.stderr.write(`${result.error.message}\n`);
if (result.status !== 0) process.exit(result.status ?? 1);

if (!process.env.LOAM_ROOT) throw new Error('LOAM_ROOT is required to share the installed Electron runtime');
const rootRequire = createRequire(path.join(process.env.LOAM_ROOT, 'package.json'));
const sharedVersion = rootRequire('electron/package.json').version;
const projectPackage = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const requiredMajor = Number(/^(\d+)/.exec(projectPackage.devDependencies.electron.replace(/^[^\d]*/, ''))?.[1]);
if (Number(sharedVersion.split('.')[0]) !== requiredMajor) throw new Error(`Electron ${sharedVersion} does not satisfy ${projectPackage.devDependencies.electron}`);
rootRequire('electron');
console.log(`Using Loam Electron ${sharedVersion}`);
