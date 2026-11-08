import { assertExtensionManifest } from '../chrome/permissions.js';
import { visibleBriefHtml } from '../briefHtml.js';

export interface ExtensionFile {
  path: string;
  content: string;
}

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function escapeText(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ESCAPE[char] ?? char);
}

const EXCLUDED_SCOPE = 'هذا الطلب خارج النطاق: لا تشغيل دوري ولا شبكة في الخلفية.';

export function extensionScopeExcluded(brief: string): boolean {
  return /(periodic|background|service worker|webhook|alarms?|remote|كل ساعة|خلفية|شبكة|تشغيل دوري)/i.test(brief);
}

function plainName(title: string): string {
  const name = title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return name || 'إضافة';
}

export function extensionFiles(title: string, brief = ''): ExtensionFile[] {
  const name = plainName(title);
  const safe = escapeText(name);
  const manifest = {
    manifest_version: 3,
    name,
    version: '0.1.0',
    action: { default_popup: 'popup.html' },
    permissions: ['activeTab', 'scripting', 'storage'],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  };
  const note = extensionScopeExcluded(brief) ? `<p id="excluded">${EXCLUDED_SCOPE}</p>` : '';
  const popup = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>${safe}</title><h1>${safe}</h1><p>يقرأ التحديد من الصفحة الحالية عند الطلب فقط ويحفظه على هذا الجهاز.</p>${visibleBriefHtml(brief)}${note}<button id="capture" type="button">احفظ النص المحدد</button><p id="result" role="status"></p><script src="popup.js"></script></html>`;
  return [
    { path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: 'popup.html', content: popup },
    { path: 'popup.js', content: popupScript() },
  ];
}

export function popupScript(): string {
  return `const result = document.querySelector('#result');
function pageUrl(url) {
  return url.startsWith('http' + '://') || url.startsWith('https' + '://');
}
function noteMap(stored) {
  const notes = stored && stored.notes && typeof stored.notes === 'object' ? stored.notes : {};
  const next = {};
  for (const key of Object.keys(notes)) {
    if (pageUrl(key) && typeof notes[key] === 'string') next[key] = notes[key].slice(0, 2000);
  }
  return next;
}
async function restore() {
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api || !api.tabs || !api.storage || !api.storage.local || !api.storage.local.get) return;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const url = tab && tab.url ? tab.url : '';
  if (!pageUrl(url)) return;
  const notes = noteMap(await api.storage.local.get('notes'));
  if (notes[url] && !result.textContent) result.textContent = notes[url];
}
globalThis.__ready = restore();
document.querySelector('#capture').addEventListener('click', async () => {
  try {
    const api = globalThis.browser ?? globalThis.chrome;
    if (!api || !api.tabs || !api.scripting || !api.storage || !api.storage.local) {
      result.textContent = 'تعذر الحفظ: missing_chrome';
      return;
    }
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const url = tab && tab.url ? tab.url : '';
    if (!tab || !tab.id || !pageUrl(url)) throw new Error('unsupported_page');
    const values = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window.getSelection() && window.getSelection().toString().slice(0, 2000)) || '',
    });
    const text = values && values[0] ? values[0].result : '';
    if (typeof text !== 'string' || !text.trim()) throw new Error('empty_selection');
    const notes = api.storage.local.get ? noteMap(await api.storage.local.get('notes')) : {};
    notes[url] = text.slice(0, 2000);
    await api.storage.local.set({ notes: notes });
    result.textContent = 'حُفظت الملاحظة محلياً.';
  } catch (error) {
    result.textContent = 'تعذر الحفظ: ' + (error instanceof Error ? error.message : 'unknown_error');
  }
});
`;
}

const EXTERNAL_SCHEME = /^(?:mailto|tel|sms|intent|market)\s*:/i;

function percentDecoded(value: string): string[] {
  const forms = [value];
  let current = value;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    forms.push(next);
    current = next;
  }
  return forms;
}

function externalScheme(value: string): boolean {
  return percentDecoded(value.trim()).some((form) => EXTERNAL_SCHEME.test(form.trim()));
}

function unsafeNavigationTarget(html: string): boolean {
  for (const tag of html.match(/<[^>]*>/g) ?? []) {
    const attr = /(?:^|[\s/])(?:formaction|href|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
    for (const match of tag.slice(1, -1).matchAll(attr)) {
      if (externalScheme(match[1] ?? match[2] ?? match[3] ?? '')) return true;
    }
  }
  return false;
}

export function unsafeExtensionPage(html: string): boolean {
  if (/https?:\/\//i.test(html) || /javascript\s*:/i.test(html)) return true;
  if (/(?:\shref|\saction)\s*=\s*['"]?\s*(?:\/\/|data:|file:|blob:)/i.test(html)) return true;
  if (unsafeNavigationTarget(html)) return true;
  if (/<[^>]*\son[a-z]+\s*=/i.test(html)) return true;
  const tags = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)];
  return tags.length !== 1 || !/^<script src="(?:\.\/)?popup\.js"><\/script>$/.test(tags[0]?.[0] ?? '');
}

export function unsafeExtensionScript(source: string): boolean {
  if (/https?:\/\//i.test(source) || /javascript\s*:/i.test(source)) return true;
  if (/(?<!:)\/\//.test(source)) return true;
  if (/(?:data:|file:|blob:)/i.test(source)) return true;
  return false;
}

export function assertLocalExtension(files: readonly ExtensionFile[]): void {
  for (const file of files) {
    if (file.path === 'popup.html' && unsafeExtensionPage(file.content)) throw new Error('unsafe_path');
    if (file.path === 'popup.js' && unsafeExtensionScript(file.content)) throw new Error('unsafe_path');
    if (/https?:\/\//i.test(file.content)) throw new Error('unsafe_path');
    if (file.path === 'manifest.json') assertExtensionManifest(JSON.parse(file.content) as unknown);
  }
}
