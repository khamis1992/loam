import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../policy/paths.js';
import { BuildMenuError } from './grants.js';

const JOB_ID = /^job_[a-z0-9_-]{1,80}$/i;
const SECRET_SOURCE = String.raw`[A-Za-z0-9_.-]*?(?:api[_-]?key|token|password|secret|authorization|bearer|grant[_-]?id)\s*[:=]\s*\S+|sk-[a-z0-9]{8,}|bearer\s+\S+`;
const SECRET = new RegExp(SECRET_SOURCE, 'gi');
const LOCAL_PATH = /(?<=^|[\s"'=])(?:[A-Za-z]:[\\/][^\s"'<>|*?\r\n]+|\\\\[^\s"'<>|*?\r\n]+|\/(?:Users|home)\/[^\s"'<>|*?\r\n]+)/g;
const REMOTE_SCHEME = /https?:\/\/|javascript:|(?:https?|javascript)%3a|(?:data|file|blob):|(?<![a-z])(?:mailto|tel|sms|intent|market)(?::|%(?:25)?3a)/i;
const PATH_FIELD = /screenshot|^(?:file(?:[_-]?path)?|filepath|path)$/i;

function containsRemoteScheme(value: string): boolean {
  let current = value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (REMOTE_SCHEME.test(current)) return true;
    if (attempt === 2) break;
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return false;
}

function unsafeScreenshotOrFilePath(record: Readonly<Record<string, string | number>>): boolean {
  return Object.entries(record).some(([key, value]) => typeof value === 'string' && PATH_FIELD.test(key) && containsRemoteScheme(value));
}

export function containsSecret(value: string): boolean {
  return new RegExp(SECRET_SOURCE, 'i').test(value);
}

export function redactEvidence(value: string): string {
  return value.replace(SECRET, '[redacted]').replace(LOCAL_PATH, '[path]');
}

export function writeJobEvidence(workspace: string, jobId: string, record: Readonly<Record<string, string | number>>): void {
  if (!JOB_ID.test(jobId)) throw new BuildMenuError('invalid_request', 400);
  if (unsafeScreenshotOrFilePath(record)) throw new BuildMenuError('unsafe_path', 400);
  const root = path.resolve(workspace, '.loam', 'build-menu', 'evidence');
  const dir = path.resolve(root, jobId);
  if (!isInside(root, dir)) throw new BuildMenuError('unsafe_path', 400);
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(dir)) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BuildMenuError('unsafe_path', 400);
  }
  fs.mkdirSync(dir, { recursive: true });
  const cleaned: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (/secret|token|password|authorization|key/i.test(key)) continue;
    cleaned[key] = typeof value === 'string' ? redactEvidence(value) : value;
  }
  const body = `${JSON.stringify(cleaned, null, 2)}\n`;
  if (/sk-[a-z0-9]{8,}|bearer\s+\S+/i.test(body)) throw new BuildMenuError('unsafe_path', 400);
  const target = path.join(dir, 'result.json');
  if (fs.existsSync(target)) {
    const targetStat = fs.lstatSync(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
  }
  fs.writeFileSync(target, body);
}
