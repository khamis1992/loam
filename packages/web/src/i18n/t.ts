import en from './en.json';
import ar from './ar.json';
import { createElement, Fragment, type ReactNode } from 'react';

export type Locale = 'en' | 'ar';
const catalogs: Record<Locale, Record<string, string>> = { en, ar };
export const PRODUCT = 'Agent Studio';
export const isRtl = (l: Locale) => l === 'ar';

let current: Locale = 'en';

export function getLocale(): Locale {
  return current;
}

export function setLocale(l: Locale) {
  current = l;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = l;
    document.documentElement.dir = isRtl(l) ? 'rtl' : 'ltr';
  }
}

/** Keys are English source strings (matches the original catalog design). */
export function t(key: string, vars: Record<string, string | number> = {}): string {
  const template = catalogs[current][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) =>
    name === 'product' ? PRODUCT : String(vars[name] ?? `{${name}}`),
  );
}

/** Rich variant: <tag>text</tag> segments are rendered by `tags[tag]`. */
export function tRich(
  key: string,
  tags: Record<string, (children: string) => ReactNode>,
  vars?: Record<string, string | number>,
): ReactNode {
  const parts: ReactNode[] = [];
  const re = /<(\w+)>(.*?)<\/\1>/g;
  const text = t(key, vars);
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    parts.push(text.slice(last, m.index));
    const render = tags[m[1]];
    parts.push(render ? createElement(Fragment, { key: m.index }, render(m[2])) : m[2]);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return createElement(Fragment, null, ...parts);
}
