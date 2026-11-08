import { nextCronRun } from '../../server/scheduleTime.js';
import { visibleBriefHtml } from '../planProvenance.js';

export function upcomingRuns(cron: string, from: Date, count = 3, until?: string): Date[] {
  if (count !== 3) throw new Error('invalid_request');
  const end = until === undefined ? null : Date.parse(until);
  if (until !== undefined && !Number.isFinite(end)) throw new Error('invalid_request');
  const runs: Date[] = [];
  let cursor = from;
  for (let index = 0; index < count; index += 1) {
    const next = nextCronRun(cron, cursor, 'Asia/Qatar');
    if (end !== null && next.getTime() > end) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
}

export function routineUntil(brief: string): string | undefined {
  const match = /\d{4}-\d{2}-\d{2}/.exec(brief);
  if (!match) return undefined;
  const day = match[0];
  const parsed = new Date(`${day}T23:59:59.999Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return undefined;
  return parsed.toISOString();
}

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const CONTACT_SCHEME = /(?<![a-zA-Z])(?:mailto|tel|sms|intent|market)\s*:/i;

function decodePercent(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (_part, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function unsafeSchedulePage(html: string): boolean {
  if (/https?:\/\//i.test(html) || html.includes('<script')) return true;
  let current = html;
  for (let depth = 0; depth < 3; depth += 1) {
    if (CONTACT_SCHEME.test(current)) return true;
    if (depth === 2) break;
    const decoded = decodePercent(current);
    if (decoded === current) return false;
    current = decoded;
  }
  return false;
}

export function schedulePage(card: string, sendBlocked = false, brief = ''): string {
  const block = sendBlocked ? '<p id="send-block">الإرسال متوقف حتى موافقة منفصلة. لم تُرسل رسالة.</p>' : '';
  const html = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>تقرير محلي</title>${block}${visibleBriefHtml(brief)}<pre>${escapeText(card)}</pre></html>`;
  if (unsafeSchedulePage(html)) throw new Error('unsafe_path');
  return html;
}

export function scheduleCard(runs: readonly Date[], until?: string, paused = false, enabled = false): string {
  const state = paused ? 'التقارير المحلية متوقفة مؤقتاً' : enabled ? 'التقارير المحلية مفعّلة' : 'التقارير المحلية متوقفة';
  const lines = [
    'ماذا: تقرير محلي',
    'متى: 09:00 Asia/Qatar',
    'أين: هذا الجهاز',
    'الصلاحيات: تقرير محلي فقط؛ الإرسال يحتاج موافقة',
    state,
    ...(until ? [`حتى: ${until}`] : []),
    ...runs.map((run, index) => `${index + 1}. ${run.toISOString()}`),
  ];
  const text = `${lines.join('\n')}\n`;
  if (/oauth|hmac|api[_-]?key|password|bearer|secret/i.test(text)) throw new Error('unsafe_path');
  return text;
}

function escapeText(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ESCAPE[char] ?? char);
}

export const routineReadme = [
  'التقرير يبقى على هذا الجهاز.',
  'الحزمة لا تحتوي مفاتيح OAuth أو HMAC.',
  'إغلاق التطبيق يوقف التشغيل، ولا يوجد تشغيل والجهاز مغلق.',
  '',
].join('\n');
