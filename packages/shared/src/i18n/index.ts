import en from './en.json' with { type: 'json' };
import ar from './ar.json' with { type: 'json' };

export type Locale = 'en' | 'ar';

export const catalogs: Record<Locale, Record<string, string>> = { en, ar };

export const PRODUCT = 'Agent Studio';

export const isRtl = (l: Locale) => l === 'ar';

export function t(
  key: string,
  vars: Record<string, string | number> = {},
  locale: Locale = 'en',
): string {
  const template = catalogs[locale][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) =>
    name === 'product' ? PRODUCT : String(vars[name] ?? `{${name}}`),
  );
}
