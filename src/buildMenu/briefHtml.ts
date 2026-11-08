const OMITTED_BRIEF = 'الموجز محفوظ في المشروع ولم يُعرض في الصفحة لأنه يحتوي عنواناً بعيداً.';

const CONTACT_SCHEME = /(?<![a-zA-Z])(?:mailto|tel|sms|intent|market)\s*(?::|%253a|%3a)/i;

function decodePercent(text: string): string {
  return text.replace(/%[0-9a-f]{2}/gi, (part) => decodeURIComponent(part));
}

function contactScheme(text: string): boolean {
  let current = text;
  for (let depth = 0; depth < 3; depth += 1) {
    if (CONTACT_SCHEME.test(current)) return true;
    if (depth === 2) break;
    const next = decodePercent(current);
    if (next === current) return false;
    current = next;
  }
  return false;
}

function remoteBrief(text: string): boolean {
  return /https?:\/\//i.test(text) || /javascript\s*:/i.test(text) || /(?:data|file|blob)\s*:/i.test(text) || /(?<!:)\/\//.test(text) || contactScheme(text);
}

export function pageBriefText(brief: string): string {
  const text = brief.trim();
  if (!text) return '';
  return remoteBrief(text) ? OMITTED_BRIEF : text;
}

export function visibleBriefHtml(brief: string): string {
  const text = pageBriefText(brief);
  if (!text) return '';
  return `<pre id="brief">${text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char))}</pre>`;
}
