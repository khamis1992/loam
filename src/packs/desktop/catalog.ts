export const DESKTOP_TEMPLATE_IDS = ['file-organizer', 'habit-tracker', 'markdown-editor', 'password-manager', 'photo-sorter'] as const;

export type DesktopTemplateId = (typeof DESKTOP_TEMPLATE_IDS)[number];

const TITLES: Record<DesktopTemplateId, string> = {
  'file-organizer': 'Loam File Organizer',
  'habit-tracker': 'Loam Habit Tracker',
  'markdown-editor': 'Loam Markdown Editor',
  'password-manager': 'Loam Password Manager',
  'photo-sorter': 'Loam Photo Sorter',
};

export function isDesktopTemplateId(value: unknown): value is DesktopTemplateId {
  return typeof value === 'string' && DESKTOP_TEMPLATE_IDS.includes(value as DesktopTemplateId);
}

export function desktopTemplateTitle(template: DesktopTemplateId): string {
  return TITLES[template];
}

export function desktopTemplateForPrompt(prompt: string): DesktopTemplateId | undefined {
  const text = prompt.toLowerCase();
  if (/file organizer|downloads folder|منظم\s*ملفات|تنظيم\s*(?:الملفات|التنزيلات)/i.test(text)) return 'file-organizer';
  if (/habit tracker|weekly streaks|متتبع\s*عادات|تتبع\s*العادات|السلاسل\s*الأسبوعية/i.test(text)) return 'habit-tracker';
  if (/markdown editor|محرر\s*markdown|محرر\s*مارك\s*داون/i.test(text)) return 'markdown-editor';
  if (/password manager|encrypted local storage|مدير\s*كلمات\s*(?:المرور|السر)|تخزين\s*مشفر/i.test(text)) return 'password-manager';
  if (/photo sorter|duplicate detection|فارز\s*الصور|فرز\s*الصور|كشف\s*التكرار/i.test(text)) return 'photo-sorter';
  return undefined;
}
