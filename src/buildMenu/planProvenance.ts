import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BuildKind } from '../../packages/shared/src/buildMenu.js';
import { pageBriefText, visibleBriefHtml } from './briefHtml.js';
import { kindPlanContract } from './planGate.js';

export { pageBriefText, visibleBriefHtml };

export function writeStoredBrief(workspace: string, brief: string): void {
  const text = brief.trim();
  if (text.length < 10 || text.length > 4000) throw new Error('invalid_request');
  const file = briefFile(workspace);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  }
  fs.writeFileSync(file, `${text}\n`, { encoding: 'utf8', mode: 0o600 });
}

const HANDSET_SCHEME = /(?<![a-zA-Z])(?:mailto|tel|sms|intent|market)\s*:/i;

function decodePercentOnce(value: string): string {
  return value.replace(/%[0-9a-f]{2}/gi, (part) => decodeURIComponent(part));
}

export function assertPlanBody(body: string): void {
  const decoded = decodePercentOnce(body);
  const handset = HANDSET_SCHEME.test(body) || (decoded !== body && HANDSET_SCHEME.test(decoded));
  if (body.includes('Manus') || /https?:\/\//i.test(body) || body.includes('"command"') || handset) {
    throw new Error('invalid_request');
  }
}

export function recordPlanProvenance(workspace: string, kind: BuildKind): void {
  const contract = kindPlanContract(kind);
  const userBrief = readStoredBrief(workspace);
  const body = `${JSON.stringify({
    source: 'loam',
    model: false,
    kind: contract.kind,
    brief: contract.brief,
    acceptance: contract.acceptance,
    allowedFiles: [...contract.allowedFiles],
    permissions: contract.permissions,
    userBriefSha256: userBrief === null ? null : createHash('sha256').update(userBrief).digest('hex'),
  })}\n`;
  assertPlanBody(body);
  const root = path.resolve(workspace);
  const dir = containedDir(root, '.loam/build-menu');
  fs.mkdirSync(dir, { recursive: true });
  const realDir = fs.realpathSync(dir);
  const relativeDir = path.relative(fs.realpathSync(root), realDir);
  if (relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) throw new Error('unsafe_path');
  const file = path.join(realDir, 'plan.json');
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  }
  fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
}

function briefFile(workspace: string): string {
  const root = path.resolve(workspace);
  const dir = containedDir(root, '.loam/build-menu');
  fs.mkdirSync(dir, { recursive: true });
  const realDir = fs.realpathSync(dir);
  const relativeDir = path.relative(fs.realpathSync(root), realDir);
  if (relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) throw new Error('unsafe_path');
  return path.join(realDir, 'brief.txt');
}

export function storedBrief(workspace: string): string {
  return readStoredBrief(workspace) ?? '';
}

function readStoredBrief(workspace: string): string | null {
  const file = path.join(path.resolve(workspace), '.loam', 'build-menu', 'brief.txt');
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  const text = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (text.length < 10 || text.length > 4000) return null;
  return text;
}

function containedDir(root: string, relative: string): string {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const contained = path.relative(root, current);
    if (contained.startsWith('..') || path.isAbsolute(contained)) throw new Error('unsafe_path');
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe_path');
  }
  return current;
}
