import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Artifact, ExportKind } from '../../packages/shared/src/buildMenu.js';
import { zipBuffer, type ZipEntry } from '../preview/zip.js';
import { containsSecret } from './evidence.js';
import { BuildMenuError } from './grants.js';
import { isKernelConnectionFile, notebookExportText } from './notebooks/document.js';

const ARTIFACT_ID = /^art_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MAX_FILES = 5_000;
const MAX_BYTES = 100_000_000;

const DB_FILE = /\.(?:sqlite3?|db)(?:-wal|-shm|-journal)?$/i;
const HOME_DIR = new Set(['.ssh', '.aws', '.gnupg']);
const HOME_FILE = /^(?:id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|\.(?:npmrc|pypirc|netrc|git-credentials))$/;

const WEB_ATTR = /(?:^|[\s/])(?:src|formaction|href|action)\s*=\s*['"]?\s*(?:\/\/|https?\s*:|javascript\s*:|data\s*:|file\s*:|blob\s*:)/i;
const HANDSET_ATTR = /(?:^|[\s/])(?:formaction|href|action)\s*=\s*['"]?\s*(?:mailto|tel|sms|intent|market)\s*:/i;

function decodePercents(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function encodedRemote(html: string): boolean {
  let current = html;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (WEB_ATTR.test(current) || HANDSET_ATTR.test(current)) return true;
    if (attempt === 2) break;
    const next = decodePercents(current);
    if (next === current) break;
    current = next;
  }
  return false;
}

function remoteHtml(html: string): boolean {
  if (/javascript\s*:/i.test(html)) return true;
  if (/<script\b[^>]*\ssrc\s*=\s*['"]?\s*(?:\/\/|https?:|data:|file:|blob:)/i.test(html)) return true;
  if (/(?:\shref|\sformaction|\saction)\s*=\s*['"]?\s*(?:\/\/|https?:|javascript:|data:|file:|blob:)/i.test(html)) return true;
  return encodedRemote(html);
}

function signingMaterial(part: string): boolean {
  const name = part.toLowerCase();
  return name === 'local.properties' || name === 'google-services.json' || name.endsWith('.keystore') || name.endsWith('.jks');
}

function archiveSecret(part: string): boolean {
  const name = part.toLowerCase();
  return name === 'secrets.json' || name.endsWith('.p12') || name.endsWith('.pfx') || name.endsWith('.key');
}

function extraArchiveFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'service-account.json'
    || lower === 'cookies'
    || lower === 'login data'
    || lower === 'web data'
    || lower.endsWith('.ppk')
    || lower.endsWith('.kdbx')
    || lower.endsWith('.ovpn');
}

function denied(relative: string): boolean {
  const name = relative.replace(/\\/g, '/');
  return name.split('/').some((part) => part === 'node_modules' || part === '.git' || part === '.loam' || part === '.preview-data' || part === '.app-data' || part === 'unpacked.txt' || part === 'catchup.lock' || part === 'proposed.json' || part === 'credentials.json' || part.endsWith('.pem') || part.startsWith('.env') || DB_FILE.test(part) || HOME_DIR.has(part) || HOME_FILE.test(part) || signingMaterial(part) || archiveSecret(part));
}

export function assertRealInside(root: string, target: string): void {
  let realRoot = '';
  let realTarget = '';
  try {
    realRoot = fs.realpathSync(root);
    realTarget = fs.realpathSync(target);
  } catch {
    throw new Error('unsafe_path');
  }
  const relative = path.relative(realRoot, realTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe_path');
}

export function readProjectBytes(workspace: string, relativeName: string): Buffer {
  if (relativeName.length === 0 || relativeName.length > 200 || relativeName.includes('\\') || relativeName.startsWith('/') || /^[A-Za-z]:/.test(relativeName)) {
    throw new BuildMenuError('unsafe_path', 400);
  }
  const parts = relativeName.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) throw new BuildMenuError('unsafe_path', 400);
  const root = path.resolve(workspace, 'app');
  const absolute = path.resolve(root, ...parts);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new BuildMenuError('unsafe_path', 400);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') throw error;
    throw new BuildMenuError('unsafe_path', 400);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
  try {
    assertRealInside(root, absolute);
  } catch (error) {
    if (error instanceof Error && error.message === 'unsafe_path') throw new BuildMenuError('unsafe_path', 400);
    throw error;
  }
  return fs.readFileSync(absolute);
}

export function sourceEntries(appDir: string): ZipEntry[] {
  const root = path.resolve(appDir);
  const entries: ZipEntry[] = [];
  let bytes = 0;
  const walk = (dir: string, prefix: string): void => {
    assertRealInside(root, dir);
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      const absolute = path.join(dir, item.name);
      const stat = fs.lstatSync(absolute);
      if (item.isSymbolicLink() || stat.isSymbolicLink()) throw new Error('unsafe_path');
      if (denied(relative)) continue;
      if (item.isDirectory()) {
        if (relative.endsWith('.ipynb') || relative.endsWith('.html') || relative.endsWith('.js') || relative.endsWith('.css') || relative.endsWith('.json')) throw new Error('unsafe_path');
        walk(absolute, relative);
        continue;
      }
      if (!item.isFile()) continue;
      if (extraArchiveFile(item.name)) continue;
      if (stat.nlink > 1) throw new Error('unsafe_path');
      assertRealInside(root, absolute);
      const read = fs.readFileSync(absolute);
      if (isKernelConnectionFile(relative, read)) continue;
      const data = relative.endsWith('.ipynb') ? exportedNotebook(read) : read;
      if (relative.endsWith('.html') && remoteHtml(data.toString('utf8'))) throw new Error('unsafe_path');
      if (containsSecret(data.toString('utf8'))) continue;
      if (entries.length >= MAX_FILES || bytes + data.length > MAX_BYTES) throw new Error('tool_failed');
      bytes += data.length;
      entries.push({ name: relative, data });
    }
  };
  walk(root, '');
  return entries;
}

function exportedNotebook(data: Buffer): Buffer {
  try {
    return Buffer.from(notebookExportText(data.toString('utf8')));
  } catch (error) {
    if (error instanceof BuildMenuError) throw error;
    return data;
  }
}

function regularFile(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function clearRegularTemp(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    fs.rmSync(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export function writeAtomicFile(target: string, bytes: Buffer): void {
  const temp = `${target}.tmp`;
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
  }
  if (!clearRegularTemp(temp)) throw new BuildMenuError('unsafe_path', 400);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, bytes);
    fs.closeSync(fd);
    fd = undefined;
    if (!regularFile(temp)) throw new BuildMenuError('unsafe_path', 400);
    if (fs.existsSync(target) && !regularFile(target)) throw new BuildMenuError('unsafe_path', 400);
    const readback = createHash('sha256').update(fs.readFileSync(temp)).digest('hex');
    if (readback !== createHash('sha256').update(bytes).digest('hex')) throw new Error('tool_failed');
    let linked: fs.Stats | undefined;
    try {
      linked = fs.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (linked && linked.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
    fs.renameSync(temp, target);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* The descriptor is already closed. */ }
    }
    if (regularFile(temp)) {
      try { fs.rmSync(temp); } catch { /* Leave a file that is no longer a regular file. */ }
    }
    throw error;
  }
}

function persistArtifact(workspace: string, projectId: string, revision: number, format: ExportKind, bytes: Buffer, extension: string): Artifact {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const artifactId = `art_${randomUUID()}`;
  const dir = path.join(workspace, '.loam', 'build-menu', 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${artifactId}.${extension}`);
  writeAtomicFile(target, bytes);
  const artifact: Artifact = {
    artifactId, projectId, revision, format,
    relativePath: `.loam/build-menu/artifacts/${artifactId}.${extension}`,
    sha256, bytes: bytes.length,
  };
  writeAtomicFile(path.join(dir, `${artifactId}.json`), Buffer.from(JSON.stringify(artifact)));
  return artifact;
}

export function writeSourceArtifact(workspace: string, projectId: string, revision: number, format: ExportKind): Artifact {
  return persistArtifact(workspace, projectId, revision, format, zipBuffer(sourceEntries(path.join(workspace, 'app'))), 'zip');
}

export function writeBytesArtifact(workspace: string, projectId: string, revision: number, format: ExportKind, bytes: Buffer, extension: string): Artifact {
  return persistArtifact(workspace, projectId, revision, format, bytes, extension);
}

export function isArtifactId(value: string): boolean {
  return ARTIFACT_ID.test(value);
}

function allowedArtifactName(artifactId: string, filename: string): boolean {
  return filename === `${artifactId}.zip` || filename === `${artifactId}.ipynb` || filename === `${artifactId}.apk`;
}

export function downloadName(filename: string): string {
  if (filename.length === 0 || filename.length > 200 || filename === '.' || filename === '..') {
    throw new BuildMenuError('invalid_request', 400);
  }
  if (filename.includes('"') || filename.includes("'") || filename.includes('\r') || filename.includes('\n') || filename.includes('/') || filename.includes('\\')) {
    throw new BuildMenuError('invalid_request', 400);
  }
  if (path.win32.basename(filename) !== filename || path.posix.basename(filename) !== filename) {
    throw new BuildMenuError('invalid_request', 400);
  }
  return filename;
}

export function artifactHeaders(artifactId: string, size: number, filename = `${artifactId}.zip`): Record<string, string | number> {
  if (!isArtifactId(artifactId)) throw new BuildMenuError('invalid_request', 400);
  const name = downloadName(filename);
  if (!allowedArtifactName(artifactId, name)) throw new BuildMenuError('invalid_request', 400);
  const disposition = `attachment; filename="${name}"`;
  if (disposition.includes('\r') || disposition.includes('\n')) throw new BuildMenuError('invalid_request', 400);
  return {
    'content-type': name.endsWith('.ipynb') ? 'application/json' : name.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/zip',
    'content-length': size,
    'content-disposition': disposition,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  };
}

export function resolveArtifact(workspace: string, projectId: string, artifactId: string): { artifact: Artifact; bytes: Buffer } {
  if (!isArtifactId(artifactId)) throw new BuildMenuError('invalid_request', 400);
  const dir = path.resolve(workspace, '.loam', 'build-menu', 'artifacts');
  const metaPath = path.join(dir, `${artifactId}.json`);
  if (!fs.existsSync(metaPath)) throw new BuildMenuError('not_found', 404);
  const metaStat = fs.lstatSync(metaPath);
  if (metaStat.isSymbolicLink() || metaStat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
  const artifact = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Artifact;
  if (artifact.artifactId !== artifactId || artifact.projectId !== projectId) throw new BuildMenuError('not_found', 404);
  const filename = path.basename(artifact.relativePath);
  if (!allowedArtifactName(artifactId, filename)) throw new BuildMenuError('invalid_request', 400);
  const filePath = path.join(dir, filename);
  if (path.relative(dir, filePath).startsWith('..')) throw new BuildMenuError('invalid_request', 400);
  const fileStat = fs.lstatSync(filePath);
  if (fileStat.isSymbolicLink() || fileStat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
  const bytes = fs.readFileSync(filePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== artifact.sha256 || bytes.length !== artifact.bytes) throw new BuildMenuError('tool_failed', 500);
  return { artifact, bytes };
}
