import { z } from 'zod';
import { BUILD_KINDS, type BuildKind } from '../../packages/shared/src/buildMenu.js';
import { automationsBrief } from './automations/profile.js';
import { assertExtensionManifest } from './chrome/permissions.js';
import { unsafeExtensionPage } from './extensions/source.js';
import { chromeBrief } from './chrome/profile.js';
import { desktopBrief } from './desktop/profile.js';
import { unsafeGamePage } from './games/page.js';
import { gamesBrief } from './games/profile.js';
import { checkedTuning } from './games/tuning.js';
import { BuildMenuError } from './grants.js';
import { mobileBrief } from './mobile/profile.js';
import { installsPackage } from './notebooks/installGuard.js';
import { notebooksBrief } from './notebooks/profile.js';
import { safariBrief } from './safari/profile.js';
import { unsafeWebsitePreview } from './websites/bundle.js';
import { websitesBrief } from './websites/profile.js';
import { widgetBrief } from './widget/profile.js';

const FROZEN = new Set([
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'electron/main.cjs',
  'electron/preload.cjs',
  'electron/notes.cjs',
  'electron/notes-preload.cjs',
  'electron/widget-geometry.cjs',
  'electron/navigation.cjs',
  'electron/userData.cjs',
]);

const planSchema = z.object({
  kind: z.enum(['website', 'desktop', 'widget', 'automation', 'notebook', 'mobile', 'chrome-extension', 'safari-extension', 'game']),
  files: z.array(z.object({
    path: z.string().min(1).max(120),
    content: z.string().max(100_000),
  }).strict()).max(8),
}).strict();

export interface KindPlanContract {
  kind: BuildKind;
  brief: string;
  acceptance: string;
  allowedFiles: readonly string[];
  permissions: string;
}

export interface AcceptedPlanFile {
  path: string;
  content: string;
}

export function kindPlanContract(kind: BuildKind): KindPlanContract {
  switch (kind) {
    case 'website':
      return contract(kind, websitesBrief, 'الصفحة المحلية تعمل بلا شبكة، والسلة والحجز والمحادثة تبقى على هذا الجهاز.', 'لا دفع ولا مفاتيح ولا سكربت تثبيت.');
    case 'desktop':
      return contract(kind, desktopBrief, 'النافذة المحلية تحفظ ملاحظة واحدة بلا Node في الصفحة، والناتج portable غير موقّع.', 'لا autostart ولا جسر Loam ولا تنفيذ main مولّد.');
    case 'widget':
      return contract(kind, widgetBrief, 'الويدجت يبقى حتى الإنهاء من الشريط، والتشغيل مع الإقلاع مغلق.', 'لا طلب شبكة ولا صلاحيات عامة.');
    case 'automation':
      return contract(kind, automationsBrief, 'المعاينة dry-run بلا إرسال، والجدول بتوقيت Asia/Qatar.', 'لا إرسال ولا نشر ولا حذف ملفات.');
    case 'notebook':
      return contract(kind, notebooksBrief, 'الخلية تُحرَّر وتُصدَّر، والتثبيت والشبكة مرفوضان.', 'لا pip ولا صورة latest ولا شبكة الحاوية.');
    case 'mobile':
      return contract(kind, mobileBrief, 'المحاكاة صفحة ويب، وملف APK لا يُدّعى بلا بناء حقيقي.', 'لا sync ولا دفع ولا توقيع متجر.');
    case 'chrome-extension':
      return contract(kind, chromeBrief, 'الصلاحيات activeTab وscripting وstorage فقط.', 'لا all_urls ولا background ولا تحميل على ملف المستخدم.');
    case 'safari-extension':
      return contract(kind, safariBrief, 'على Windows المصدر فقط، ولا يُدّعى اختبار Safari.', 'لا تحويل Xcode على غير macOS ولا رفع متجر.');
    case 'game':
      return contract(kind, gamesBrief, 'اللعبة لوحة محلية بهدفين، والأصول هندسية محلية.', 'لا أصول خارجية ولا موسيقى مجهولة الترخيص.');
    default: {
      const unknown: never = kind;
      throw new BuildMenuError(`missing_requirement:${String(unknown)}`, 400);
    }
  }
}

export function parseUntrustedPlan(raw: unknown): { kind: BuildKind; files: AcceptedPlanFile[] } {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) throw new BuildMenuError('invalid_request', 400);
  const kind = parsed.data.kind;
  if (!BUILD_KINDS.includes(kind)) throw new BuildMenuError('invalid_request', 400);
  const allowed = new Set(kindPlanContract(kind).allowedFiles);
  const seen = new Set<string>();
  const files: AcceptedPlanFile[] = [];
  for (const file of parsed.data.files) {
    const relative = gatedPath(file.path, allowed);
    if (seen.has(relative)) throw new BuildMenuError('invalid_request', 400);
    seen.add(relative);
    inspectContent(kind, relative, file.content);
    files.push({ path: relative, content: file.content });
  }
  return { kind, files };
}

function contract(kind: BuildKind, brief: string, acceptance: string, permissions: string): KindPlanContract {
  return { kind, brief, acceptance, allowedFiles: allowedFiles(kind), permissions };
}

function allowedFiles(kind: BuildKind): readonly string[] {
  switch (kind) {
    case 'website':
      return ['app/preview.html', 'app/loam-website.json'];
    case 'desktop':
    case 'widget':
      return ['app/dist/index.html'];
    case 'automation':
      return ['app/preview.html', 'app/schedule.txt', 'app/README.md'];
    case 'notebook':
      return ['app/notebook.ipynb'];
    case 'mobile':
      return ['app/simulation.html'];
    case 'chrome-extension':
    case 'safari-extension':
      return ['app/popup.html', 'app/manifest.json'];
    case 'game':
      return ['app/index.html', 'app/tuning.json', 'app/LICENSE', 'app/assets/manifest.json'];
    default: {
      const unknown: never = kind;
      throw new BuildMenuError(`missing_requirement:${String(unknown)}`, 400);
    }
  }
}

function gatedPath(value: string, allowed: ReadonlySet<string>): string {
  if (value.includes('\\') || value.startsWith('/') || value.includes('..') || /^[A-Za-z]:/.test(value)) {
    throw new BuildMenuError('unsafe_path', 400);
  }
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new BuildMenuError('unsafe_path', 400);
  const relative = parts.join('/');
  const underApp = relative.startsWith('app/') ? relative.slice(4) : relative;
  if (FROZEN.has(underApp) || underApp.startsWith('electron/')) throw new BuildMenuError('invalid_request', 400);
  if (!allowed.has(relative)) throw new BuildMenuError('invalid_request', 400);
  return relative;
}

function inspectContent(kind: BuildKind, relative: string, content: string): void {
  if (/"preinstall"\s*:/.test(content) || /"postinstall"\s*:/.test(content) || /"prepare"\s*:/.test(content)) {
    throw new BuildMenuError('approval_required', 403);
  }
  switch (kind) {
    case 'website':
      refuseRemote(content);
      if (relative.endsWith('.html') && unsafeWebsitePreview(content)) throw new BuildMenuError('unsafe_path', 400);
      if (relative.endsWith('loam-website.json')) assertWebsiteMeta(content);
      return;
    case 'mobile':
      refuseRemote(content);
      if (relative.endsWith('.html') && unsafeLocalPage(content)) throw new BuildMenuError('unsafe_path', 400);
      return;
    case 'desktop':
    case 'widget':
      refuseRemote(content);
      if (/child_process|nodeIntegration|postMessage|\brequire\s*\(/.test(content)) throw new BuildMenuError('invalid_request', 400);
      if (relative.endsWith('.html') && unsafeLocalPage(content)) throw new BuildMenuError('unsafe_path', 400);
      return;
    case 'automation':
      refuseRemote(content);
      if (/"send"\s*:\s*true/.test(content)) throw new BuildMenuError('approval_required', 403);
      if (relative.endsWith('.html') && unsafeLocalPage(content)) throw new BuildMenuError('unsafe_path', 400);
      return;
    case 'notebook':
      assertNotebook(content);
      return;
    case 'chrome-extension':
    case 'safari-extension':
      if (relative.endsWith('manifest.json')) assertManifest(content);
      else {
        refuseRemote(content);
        if (relative.endsWith('popup.html') && unsafeExtensionPage(content)) throw new BuildMenuError('unsafe_path', 400);
      }
      return;
    case 'game':
      refuseRemote(content);
      if (relative.endsWith('index.html') && unsafeGamePage(content)) throw new BuildMenuError('unsafe_path', 400);
      if (relative.endsWith('tuning.json')) assertTuning(content);
      if (relative.endsWith('assets/manifest.json')) assertAssets(content);
      return;
    default: {
      const unknown: never = kind;
      throw new BuildMenuError(`missing_requirement:${String(unknown)}`, 400);
    }
  }
}

function unsafeLocalPage(content: string): boolean {
  const decoded = decodeMarkup(content);
  if (remoteUrl(decoded)) return true;
  const compact = decoded.replace(/[\u0000-\u0020]+/g, '');
  if (compact !== decoded && remoteUrl(compact)) return true;
  const outside = decoded.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  return /\son[a-z]+\s*=/i.test(outside);
}

function remoteUrl(content: string): boolean {
  if (splitScheme(content)) return true;
  if (/javascript\s*:/i.test(content)) return true;
  if (/(?:https?|wss?|ftp):\/\//i.test(content)) return true;
  if (/<script\b[^>]*\ssrc\s*=\s*['"]?\s*(?:\/\/|https?:|data:|file:|blob:)/i.test(content)) return true;
  if (/(?:\shref|\ssrc|\ssrcset|\saction|\sformaction|\sposter|\sdata|\sbackground)\s*=\s*['"]?\s*(?:\/\/|https?:|javascript:|data:|file:|blob:|mailto\s*:|tel\s*:|sms\s*:|intent\s*:|market\s*:)/i.test(content)) return true;
  if (/url\(\s*['"]?\s*(?:\/\/|https?:|javascript:|data:|file:|blob:)/i.test(content)) return true;
  if (/(?:fetch|WebSocket|import)\s*\(\s*['"`]\s*(?:\/\/|javascript:|https?:|wss?:|ftp:|data:|file:|blob:|mailto\s*:|tel\s*:|sms\s*:|intent\s*:|market\s*:)/i.test(content)) return true;
  if (/\bimport\s+['"`]\s*(?:mailto\s*:|tel\s*:|sms\s*:|intent\s*:|market\s*:)/i.test(content)) return true;
  if (/\bfrom\s*['"`]\s*(?:\/\/|javascript:|https?:|wss?:|ftp:|data:|file:|blob:|mailto\s*:|tel\s*:|sms\s*:|intent\s*:|market\s*:)/i.test(content)) return true;
  return protocolRelative(content);
}

function protocolRelative(content: string): boolean {
  return /(?:^|["'`(=,\s>])\/\/(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/i.test(content)
    || /(?:^|["'`(=,\s>])\/\/[A-Za-z0-9-]+\//.test(content)
    || /(?:^|["'`(=,\s>])\/\/(?:\d{1,3}\.){3}\d{1,3}\b/.test(content)
    || /(?:^|["'`(=,\s>])\/\/localhost\b/i.test(content);
}

function splitScheme(content: string): boolean {
  return /\b(?:https?|wss?|ftp)\s*['"`]\s*\+\s*['"`]\s*:\/\//i.test(content)
    || /\b(?:javascript|data|file|blob|mailto|tel|sms|intent|market)\s*['"`]\s*\+\s*['"`]\s*:/i.test(content);
}

function decodeMarkup(value: string): string {
  const decoded = value
    .replace(/&#x([0-9a-f]{1,6});?/gi, (whole, hex: string) => codePoint(Number.parseInt(hex, 16), whole))
    .replace(/&#([0-9]{1,7});?/g, (whole, num: string) => codePoint(Number.parseInt(num, 10), whole))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&colon;/gi, ':')
    .replace(/&sol;/gi, '/')
    .replaceAll('\u0000', '');
  return unfoldSchemePercents(decoded).replace(/\\/g, '/');
}

function unfoldSchemePercents(value: string): string {
  let current = value;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!/%(?:25|2f|3a)/i.test(current)) break;
    const next = current.replace(/%(25|2f|3a)/gi, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === current) break;
    current = next;
  }
  return current;
}

function codePoint(code: number, fallback: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return fallback;
  return String.fromCodePoint(code);
}

function refuseRemote(content: string): void {
  if (/https?:\/\//i.test(content)) throw new BuildMenuError('unsafe_path', 400);
}

function assertWebsiteMeta(content: string): void {
  const parsed = parseObject(content);
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'subtype') throw new BuildMenuError('invalid_request', 400);
  if (!['landing', 'store', 'booking', 'chatbot'].includes(String(parsed.subtype))) {
    throw new BuildMenuError('invalid_request', 400);
  }
}

function assertNotebook(content: string): void {
  if (installsPackage(content) || /python:latest|--network\b|docker\s+pull/i.test(content)) {
    throw new BuildMenuError('approval_required', 403);
  }
  const parsed = parseObject(content);
  const cells = parsed.cells;
  if (!Array.isArray(cells)) throw new BuildMenuError('invalid_request', 400);
  for (const cell of cells) {
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) throw new BuildMenuError('invalid_request', 400);
    const source = (cell as { source?: unknown }).source;
    const text = Array.isArray(source) ? source.join('') : typeof source === 'string' ? source : '';
    if (installsPackage(text)) throw new BuildMenuError('approval_required', 403);
  }
}

function assertManifest(content: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new BuildMenuError('invalid_request', 400);
  }
  try {
    assertExtensionManifest(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'permission_requires_review' || message === 'host_requires_review') {
      throw new BuildMenuError('approval_required', 403);
    }
    throw new BuildMenuError('invalid_request', 400);
  }
}

function assertTuning(content: string): void {
  const parsed = parseObject(content);
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || typeof parsed.speed !== 'number' || typeof parsed.gravity !== 'number') {
    throw new BuildMenuError('invalid_request', 400);
  }
  try {
    checkedTuning({ speed: parsed.speed, gravity: parsed.gravity });
  } catch {
    throw new BuildMenuError('invalid_request', 400);
  }
}

function assertAssets(content: string): void {
  const parsed = parseObject(content);
  const assets = parsed.assets;
  if (!Array.isArray(assets) || assets.length > 8) throw new BuildMenuError('invalid_request', 400);
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) throw new BuildMenuError('invalid_request', 400);
    const record = asset as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 4 || record.source !== 'local-geometry' || record.license !== 'local') {
      throw new BuildMenuError('invalid_request', 400);
    }
    if (typeof record.path !== 'string' || record.path.includes('..') || record.path.startsWith('/') || record.path.includes('\\')) {
      throw new BuildMenuError('unsafe_path', 400);
    }
    if (typeof record.evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.evidenceSha256)) {
      throw new BuildMenuError('invalid_request', 400);
    }
  }
}

function parseObject(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new BuildMenuError('invalid_request', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BuildMenuError('invalid_request', 400);
  return parsed as Record<string, unknown>;
}
