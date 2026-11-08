import fs from 'node:fs';
import path from 'node:path';
import { popupScript } from '../extensions/source.js';

export function conversionCapability(platform: string, xcodeAvailable: boolean): 'source-only' | 'missing-xcode' | 'convertible' {
  if (platform !== 'darwin') return 'source-only';
  return xcodeAvailable ? 'convertible' : 'missing-xcode';
}

export function xcodeOnThisMachine(): boolean {
  return process.platform === 'darwin' && fs.existsSync('/usr/bin/xcodebuild');
}

export function currentConversion(): 'source-only' | 'missing-xcode' | 'convertible' {
  return conversionCapability(process.platform, xcodeOnThisMachine());
}

const SAFARI_PREVIEW_NOTE = 'تصدير المصدر على هذا الجهاز مكتمل. لم يُختبر Safari نفسه.';

export function safariPreviewHtml(html: string): string {
  if (!html.includes('<button id="capture"')) throw new Error('tool_failed');
  const next = html.includes('id="safari-untested"')
    ? html
    : html.replace('<button id="capture"', `<p id="safari-untested">${SAFARI_PREVIEW_NOTE}</p><button id="capture"`);
  if (remotePopupScript(next)) throw new Error('unsafe_path');
  return next;
}

const POPUP_SCHEME_LITERAL = /(?:^|[^A-Za-z0-9])(?:mailto|tel|sms|intent|market|javascript|data|file|blob)\s*:/i;
const POPUP_SCHEME_ENCODED = /(?:^|[^A-Za-z0-9])(?:mailto|tel|sms|intent|market|javascript|data|file|blob)\s*%(?:25)*3a/i;
const POPUP_SCHEME_SPLIT = /(?:^|[^A-Za-z0-9])(?:mailto|tel|sms|intent|market|javascript|data|file|blob)\s*['"]\s*\+\s*['"]\s*(?::|%(?:25)*3a)/i;

function remotePopupScript(html: string): boolean {
  if (/https?:\/\//i.test(html) || /javascript\s*:/i.test(html) || /javascript\s*%3a/i.test(html)) return true;
  if (POPUP_SCHEME_LITERAL.test(html) || POPUP_SCHEME_ENCODED.test(html) || POPUP_SCHEME_SPLIT.test(html)) return true;
  if (/<script\b[^>]*\bsrc\s*=\s*['"]?\s*(?:\/\/|https?:|javascript:|data\s*:|file\s*:|blob\s*:)/i.test(html)) return true;
  if (/(?:^|[\s/>.])(?:formaction|href|action)\s*=\s*['"]?\s*(?:data\s*:|file\s*:|blob\s*:)/i.test(html)) return true;
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = match[1] ?? '';
    if (/(?:https?:)?\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i.test(body)) return true;
  }
  return false;
}

const CONVERSION_KEYS = ['conversion', 'platform', 'safariTested'];

export function assertSafariHandoff(workspace: string): void {
  let conversion: unknown;
  try {
    conversion = JSON.parse(readOwnedText(workspace, 'conversion.json')) as unknown;
  } catch (error) {
    if (error instanceof Error && (error.message === 'unsafe_path' || error.message === 'invalid_request' || error.message === 'unsupported_platform')) throw error;
    throw new Error('unsafe_path');
  }
  if (!conversion || typeof conversion !== 'object' || Array.isArray(conversion)) throw new Error('unsafe_path');
  const record = conversion as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== CONVERSION_KEYS.length || keys.some((key, index) => key !== CONVERSION_KEYS[index])) {
    throw new Error('invalid_request');
  }
  if (record.safariTested !== false) throw new Error('invalid_request');
  if (record.platform !== process.platform || record.conversion !== currentConversion()) throw new Error('unsupported_platform');
  if (readOwnedText(workspace, 'popup.js') !== popupScript()) throw new Error('invalid_request');
  if (readOwnedText(workspace, 'README-mac.md') !== macHandoffNote()) throw new Error('invalid_request');
  const html = readOwnedText(workspace, 'popup.html');
  if (!html.includes(`<p id="safari-untested">${SAFARI_PREVIEW_NOTE}</p>`)) throw new Error('invalid_request');
  if (safariPreviewHtml(html) !== html) throw new Error('unsafe_path');
}

function readOwnedText(workspace: string, name: string): string {
  const absolute = path.join(workspace, 'app', name);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    throw new Error('unsafe_path');
  }
  if (stat.isSymbolicLink() || stat.isDirectory() || !stat.isFile()) throw new Error('unsafe_path');
  return fs.readFileSync(absolute, 'utf8');
}

export function macHandoffNote(): string {
  const text = [
    'تصدير هذا المجلد على Windows مكتمل كمصدر.',
    'اختبار Safari غير مؤكد، ولا تُعرض الشارتان معاً كنجاح واحد.',
    'هذا ليس مشروع Xcode ولا إضافة موقّعة.',
    'المسار المتوقع على Mac: مجلد جديد فارغ يختاره المستلم. لا يُستبدل هذا المجلد.',
    'الحزمة لا تحتوي أسراراً أو حسابات.',
    'popup.js هو نفس مصدر إضافة Chrome.',
    '',
  ].join('\n');
  if (/https?:\/\//i.test(text) || /api[_-]?key|password|token|secret/i.test(text)) throw new Error('unsafe_path');
  return text;
}

