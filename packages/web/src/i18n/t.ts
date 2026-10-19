import { en } from './en';
import { ar } from './ar';
import { createElement, Fragment, type ReactNode } from 'react';

export type Locale = 'en' | 'ar';
const catalogs: Record<Locale, Record<string, string>> = { en, ar };
export const PRODUCT = 'Agent Studio';
export const isRtl = (l: Locale) => l === 'ar';

let current: Locale = 'en';
export function setLocale(l: Locale) {
  current = l;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = l;
    document.documentElement.dir = isRtl(l) ? 'rtl' : 'ltr';
  }
}
export function getLocale(): Locale {
  return current;
}

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const template = catalogs[current][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) =>
    name === 'product' ? PRODUCT : String(vars[name] ?? `{${name}}`),
  );
}

export function tRich(
  key: string,
  tags: Record<string, (children: string) => ReactNode>,
  vars?: Record<string, string | number>,
): ReactNode {
  const parts: ReactNode[] = [];
  const re = /<(\w+)>(.*?)<\/\1>/g;
  const text = t(key, vars);
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    parts.push(text.slice(last, m.index));
    const render = tags[m[1]];
    parts.push(render ? createElement(Fragment, { key: m.index }, render(m[2])) : m[2]);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return createElement(Fragment, null, ...parts);
}
