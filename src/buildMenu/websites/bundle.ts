import fs from 'node:fs';
import path from 'node:path';
import { BuildMenuError } from '../grants.js';
import { assertFrozenWebsiteTemplate } from './templateLock.js';

const BUILD_LOG_MAX = 2_000;
const BLOCKED_BUILD_LINE = 'لم يبدأ بناء القالب. لا توجد حزمة مقفلة، ولم يُنزَّل شيء، ولم يُستخدم نشر سحابي.\n';
const FAILED_BUILD_LINE = 'فشل بناء القالب. لم يُنشأ أرشيف جديد، ولم يُستخدم نشر سحابي.\n';

export function recordBlockedWebsiteBuild(workspace: string): void {
  appendBuildLog(workspace, BLOCKED_BUILD_LINE);
}

export function recordWebsiteBuildFailure(workspace: string): void {
  appendBuildLog(workspace, FAILED_BUILD_LINE);
}

const CONTACT_SCHEME = /(?:mailto|tel|sms|intent|market)\s*:/i;

function outsideLocalPage(html: string): boolean {
  if (contactScheme(html)) return true;
  const tags = /<(a|form|button|input|base|area)\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html)) !== null) {
    const name = (match[1] ?? '').toLowerCase();
    const attrs = match[2] ?? '';
    const target = attr(attrs, 'formaction') ?? attr(attrs, 'action') ?? attr(attrs, 'href');
    if (target !== undefined && !staysOnPage(target)) return true;
    if (name === 'form' && isPost(attr(attrs, 'method'))) return true;
    if ((name === 'button' || name === 'input') && isPost(attr(attrs, 'formmethod'))) return true;
  }
  return false;
}

function staysOnPage(value: string): boolean {
  const target = normalizeTarget(value);
  return target.length === 0 || target.startsWith('#');
}

function contactScheme(html: string): boolean {
  let current = html;
  for (let depth = 0; depth < 3; depth += 1) {
    if (CONTACT_SCHEME.test(current) || CONTACT_SCHEME.test(joinQuoteSplits(current))) return true;
    const decoded = decodePercentBytes(current);
    if (decoded === current) return false;
    current = decoded;
  }
  return false;
}

function decodePercentBytes(value: string): string {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  return value.replace(/%([0-9a-f]{2})/gi, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function joinQuoteSplits(value: string): string {
  const plain = value
    .replace(/&quot;/gi, '"')
    .replace(/&#x0*22;/gi, '"')
    .replace(/&#0*34;/g, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&#0*39;/g, "'");
  return plain.replace(/['"`]\s*\+\s*['"`]/g, '').replace(/['"`]/g, '');
}

function isPost(value: string | undefined): boolean {
  return value !== undefined && normalizeTarget(value).toLowerCase() === 'post';
}

function normalizeTarget(value: string): string {
  const decoded = value
    .replace(/&#x([0-9a-f]{1,6});?/gi, (whole, hex: string) => codePoint(Number.parseInt(hex, 16), whole))
    .replace(/&#([0-9]{1,7});?/g, (whole, num: string) => codePoint(Number.parseInt(num, 10), whole))
    .replace(/&amp;/gi, '&')
    .replace(/&colon;/gi, ':')
    .replace(/&sol;/gi, '/');
  return decoded.replace(/\\/g, '/').replace(/[\u0000-\u0020]+/g, '');
}

function codePoint(code: number, fallback: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return fallback;
  return String.fromCodePoint(code);
}

function attr(attrs: string, name: string): string | undefined {
  const matched = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i').exec(attrs);
  if (!matched) return undefined;
  return matched[1] ?? matched[2] ?? matched[3] ?? '';
}

function lstatOrAbsent(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertNoSymlink(workspace: string, target: string): void {
  const root = path.resolve(workspace);
  const absolute = path.resolve(target);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new BuildMenuError('unsafe_path', 400);
  let current = root;
  for (const part of relative.split(path.sep)) {
    if (part.length === 0 || part === '.' || part === '..') throw new BuildMenuError('unsafe_path', 400);
    current = path.join(current, part);
    const stat = lstatOrAbsent(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new BuildMenuError('unsafe_path', 400);
  }
}

function assertDirectory(workspace: string, target: string): void {
  assertNoSymlink(workspace, target);
  const stat = lstatOrAbsent(target);
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new BuildMenuError('unsafe_path', 400);
}

function assertRegularFile(workspace: string, target: string): void {
  assertNoSymlink(workspace, target);
  const stat = lstatOrAbsent(target);
  if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1)) throw new BuildMenuError('unsafe_path', 400);
}

function appendBuildLog(workspace: string, line: string): void {
  const loam = path.join(workspace, '.loam');
  const dir = path.join(loam, 'build-menu');
  const file = path.join(dir, 'build.log');
  assertDirectory(workspace, loam);
  assertDirectory(workspace, dir);
  assertRegularFile(workspace, file);
  fs.mkdirSync(dir, { recursive: true });
  assertDirectory(workspace, dir);
  assertRegularFile(workspace, file);
  const previous = lstatOrAbsent(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, `${previous}${line}`.slice(-BUILD_LOG_MAX));
}

const LOCAL_SCRIPT = '<script src="./page.js"></script>';

export function unsafeWebsitePreview(html: string): boolean {
  if (/https?:\/\//i.test(html) || /javascript:/i.test(html)) return true;
  if (/(?:\ssrc|\shref|\saction|\sformaction)\s*=\s*['"]?\s*(?:\/\/|data:|file:|blob:)/i.test(html)) return true;
  if (/\son[a-z]+\s*=/i.test(html)) return true;
  if (/<script\b[^>]+>/i.test(html)) return true;
  if (outsideLocalPage(html)) return true;
  return false;
}

export function unsafeWebsiteDocument(html: string): boolean {
  const without = html.replaceAll(LOCAL_SCRIPT, '');
  return without.includes('<script') || unsafeWebsitePreview(without);
}

export function buildWebsiteBundle(workspace: string): void {
  assertFrozenWebsiteTemplate(workspace);
  const preview = path.join(workspace, 'app', 'preview.html');
  if (!fs.existsSync(preview)) throw new BuildMenuError('tool_failed', 500);
  const previewStat = fs.lstatSync(preview);
  if (!previewStat.isFile() || previewStat.isSymbolicLink()) throw new BuildMenuError('tool_failed', 500);
  if (previewStat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
  const html = fs.readFileSync(preview, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) throw new BuildMenuError('tool_failed', 500);
  const source = scripts[0]?.[1] ?? '';
  const page = html.replace(/<script>[\s\S]*?<\/script>/, LOCAL_SCRIPT);
  if (unsafeWebsitePreview(html) || unsafeWebsitePreview(source) || unsafeWebsiteDocument(page)) {
    throw new BuildMenuError('unsafe_path', 400);
  }
  const dist = path.join(workspace, 'app', 'dist');
  const scriptPath = path.join(dist, 'page.js');
  const indexPath = path.join(dist, 'index.html');
  assertDirectory(workspace, path.join(workspace, 'app'));
  assertDirectory(workspace, dist);
  assertRegularFile(workspace, scriptPath);
  assertRegularFile(workspace, indexPath);
  fs.mkdirSync(dist, { recursive: true });
  assertDirectory(workspace, dist);
  assertRegularFile(workspace, scriptPath);
  assertRegularFile(workspace, indexPath);
  fs.writeFileSync(scriptPath, source);
  fs.writeFileSync(indexPath, page);
}
