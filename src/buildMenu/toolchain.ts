import fs from 'node:fs';
import path from 'node:path';
import type { Requirement } from '../../packages/shared/src/buildMenu.js';

const SHELLS = new Set(['cmd.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe', 'sh.exe', 'cmd', 'powershell', 'pwsh', 'bash', 'sh']);

export function findElectron(root = process.cwd()): string | null {
  const candidates = [
    path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  ];
  return candidates.find((file) => fs.existsSync(file) && !SHELLS.has(path.basename(file).toLowerCase())) ?? null;
}

export function nodeSupported(version = process.versions.node): boolean {
  const match = /^v?(\d+)\./.exec(version);
  if (!match) return false;
  return Number(match[1]) >= 24;
}

export function absentRequirements(required: readonly Requirement[], platform = process.platform): Requirement[] {
  return required.filter((item) => !present(item, platform));
}

function present(item: Requirement, platform: NodeJS.Platform): boolean {
  switch (item) {
    case 'node':
      return nodeSupported() && fs.existsSync(process.execPath);
    case 'electron':
      return findElectron() !== null;
    case 'python-container':
      return false;
    case 'android-sdk':
      return Boolean(process.env.ANDROID_HOME && fs.existsSync(process.env.ANDROID_HOME));
    case 'macos-xcode':
      return platform === 'darwin';
    case 'chromium':
      return findChrome() !== null;
    default: {
      const unknown: never = item;
      return unknown;
    }
  }
}

export function findChrome(): string | null {
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}
