import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveWrite } from '../../policy/paths.js';
import { unsafeGamePage } from './page.js';

export interface AssetRecord {
  path: string;
  source: 'local-geometry';
  license: 'local';
  evidenceSha256: string;
}

export interface ListedGameAsset {
  path: string;
  source: string;
  license: string;
  evidenceSha256: string;
}

export const GAME_LICENSE = 'Local geometric fixture. No third-party assets are included.\n';

const DECODE_PASSES = 2;
const COLON_SCHEME = /(?:mailto|tel|sms|intent|market|javascript|data|file|blob)\s*:/i;
const WEB_SCHEME = /https?:\/\//i;
const DOUBLE_SLASH = /\/\//;

function decodePercent(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function stripNull(value: string): string {
  return value.split('\0').join('');
}

function hasScheme(value: string): boolean {
  return COLON_SCHEME.test(value) || WEB_SCHEME.test(value) || DOUBLE_SLASH.test(value);
}

function remoteText(value: string): boolean {
  let current = value;
  for (let pass = 0; pass <= DECODE_PASSES; pass += 1) {
    const normalized = stripNull(current);
    if (hasScheme(normalized)) return true;
    if (pass === DECODE_PASSES) break;
    const decoded = decodePercent(normalized);
    if (decoded === normalized) break;
    current = decoded;
  }
  return false;
}

function localGameAssetPath(filePath: string): boolean {
  if (remoteText(filePath)) return false;
  if (filePath.length < 1 || filePath.length > 80) return false;
  if (filePath.includes('\\') || filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath)) return false;
  const parts = filePath.split('/');
  return parts.every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== '.' && part !== '..');
}

function staysInGameFolder(gameFolder: string, filePath: string): boolean {
  if (!localGameAssetPath(filePath)) return false;
  const root = path.resolve(gameFolder);
  const target = path.resolve(root, ...filePath.split('/'));
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function listedGameAsset(gameFolder: string, entry: unknown): ListedGameAsset {
  if (!isRecord(entry)) throw new Error('missing_license');
  if (typeof entry.license !== 'string' || entry.license.trim().length === 0) throw new Error('missing_license');
  const license = entry.license.trim();
  if (remoteText(license)) throw new Error('unsafe_path');
  const filePath = entry.path;
  if (typeof filePath !== 'string' || !staysInGameFolder(gameFolder, filePath)) throw new Error('unsafe_path');
  if (typeof entry.source !== 'string' || entry.source.trim().length === 0 || remoteText(entry.source)) throw new Error('unsafe_path');
  const evidenceSha256 = entry.evidenceSha256;
  if (typeof evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidenceSha256)) throw new Error('unsafe_path');
  return { path: filePath, source: entry.source.trim(), license, evidenceSha256 };
}

function assertListedAssetBytes(gameFolder: string, asset: ListedGameAsset): void {
  let target: string;
  try {
    target = resolveWrite(gameFolder, asset.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') throw error;
    throw new Error('unsafe_path');
  }
  let bytes: Buffer;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
    bytes = fs.readFileSync(target);
  } catch (error) {
    if (error instanceof Error && error.message === 'unsafe_path') throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') throw error;
    throw new Error('unsafe_path');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== asset.evidenceSha256) throw new Error('unsafe_path');
}

function writeManifest(gameFolder: string, body: string): void {
  let target: string;
  try {
    target = resolveWrite(gameFolder, path.join('assets', 'manifest.json'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') throw error;
    throw new Error('unsafe_path');
  }
  const dir = path.dirname(target);
  if (fs.existsSync(dir)) {
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('unsafe_path');
  }
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, body);
}

export function writeListedGameAssets(gameFolder: string, entries: readonly unknown[]): void {
  if (!Array.isArray(entries)) throw new Error('missing_license');
  const assets = entries.map((entry) => listedGameAsset(gameFolder, entry));
  for (const asset of assets) assertListedAssetBytes(gameFolder, asset);
  const body = `${JSON.stringify({ assets }, null, 2)}\n`;
  if (remoteText(body) || remoteText(GAME_LICENSE)) throw new Error('unsafe_path');
  writeManifest(gameFolder, body);
}

export function gameAssetManifest(files: readonly { path: string; text: string }[]): string {
  if (files.some((file) => !localGameAssetPath(file.path))) throw new Error('unsafe_path');
  if (files.some((file) => unsafeGamePage(file.text))) throw new Error('unsafe_path');
  const assets: AssetRecord[] = files.map((file) => ({
    path: file.path,
    source: 'local-geometry',
    license: 'local',
    evidenceSha256: createHash('sha256').update(file.text).digest('hex'),
  }));
  const body = `${JSON.stringify({ assets }, null, 2)}\n`;
  if (remoteText(body) || remoteText(GAME_LICENSE)) throw new Error('unsafe_path');
  return body;
}
