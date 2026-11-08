import fs from 'node:fs';
import path from 'node:path';

const CSV_NAME = /^app\/inbox\/[a-z0-9][a-z0-9-]{0,40}\.csv$/;
const MAX_CSV = 2_000_000;
const REMOTE_SCHEME = /(?:^|[^A-Za-z0-9])(?:mailto|tel|sms|intent|market|javascript)\s*:|(?:^|[^A-Za-z0-9])https\s*:/i;
const HYPERLINK_FORMULA = /[=+\-@]\s*HYPERLINK\s*\(/i;

export function copyApprovedCsv(workspace: string, sourceRelative: string): string {
  const normalized = sourceRelative.replace(/\\/g, '/');
  if (!CSV_NAME.test(normalized)) throw new Error('unsafe_path');
  const root = path.resolve(workspace);
  const source = path.resolve(root, ...normalized.split('/'));
  if (!source.startsWith(`${root}${path.sep}`)) throw new Error('unsafe_path');
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > MAX_CSV) throw new Error('unsafe_path');
  assertProjectFile(root, source);
  const text = fs.readFileSync(source, 'utf8');
  if (remoteCsv(text) || remoteCsv(percentDecodeOnce(text))) throw new Error('unsafe_path');
  const name = path.basename(source);
  const dataDir = path.join(root, 'app', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dataStat = fs.lstatSync(dataDir);
  if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) throw new Error('unsafe_path');
  assertProjectFile(root, dataDir);
  const destination = path.join(dataDir, name);
  if (fs.existsSync(destination)) {
    const destStat = fs.lstatSync(destination);
    if (destStat.isSymbolicLink() || !destStat.isFile() || destStat.nlink > 1) throw new Error('unsafe_path');
    assertProjectFile(root, destination);
  }
  fs.copyFileSync(source, destination);
  const written = fs.lstatSync(destination);
  if (written.isSymbolicLink() || !written.isFile()) throw new Error('unsafe_path');
  assertProjectFile(root, destination);
  return `app/data/${name}`;
}

const DATA_NAME = /^[a-z0-9][a-z0-9-]{0,40}\.csv$/;

function remoteCsv(text: string): boolean {
  return REMOTE_SCHEME.test(text) || HYPERLINK_FORMULA.test(text);
}

function percentDecodeOnce(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

export function localCsvText(workspace: string): { name: string; text: string } | null {
  const dir = path.resolve(workspace, 'app', 'data');
  if (!fs.existsSync(dir)) return null;
  const dirStat = fs.lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('unsafe_path');
  assertProjectFile(path.resolve(workspace), dir);
  const name = fs.readdirSync(dir).filter((item) => DATA_NAME.test(item)).sort()[0];
  if (!name) return null;
  const file = path.join(dir, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > MAX_CSV) throw new Error('unsafe_path');
  assertProjectFile(path.resolve(workspace), file);
  return { name, text: fs.readFileSync(file, 'utf8') };
}

export function assertProjectFile(root: string, target: string): void {
  let realRoot = '';
  let realTarget = '';
  try {
    realRoot = fs.realpathSync(root);
    realTarget = fs.realpathSync(target);
  } catch {
    throw new Error('unsafe_path');
  }
  const relative = path.relative(realRoot, realTarget);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe_path');
}
