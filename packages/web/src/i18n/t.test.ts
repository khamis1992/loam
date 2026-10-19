// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, Fragment, type ReactNode } from 'react';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { t, tRich, setLocale, getLocale, isRtl, PRODUCT } from './t';
import en from './en.json';
import ar from './ar.json';
import { useLocale } from '../hooks/useLocale';
import { renderHook } from './test-utils';
import { auditComponentSource } from './audit.mjs';

describe('i18n', () => {
  beforeEach(() => {
    setLocale('en');
  });

  afterEach(() => {
    setLocale('en');
  });

  it('t() interpolates {product} and other variables', () => {
    expect(t('Sign in to {product}')).toBe(`Sign in to ${PRODUCT}`);
    expect(t('{name} is thinking', { name: 'Ada' })).toBe('Ada is thinking');
    expect(t('Worked for {duration}', { duration: '12s' })).toBe('Worked for 12s');
  });

  it('t() leaves missing variable placeholders intact', () => {
    expect(t('Worked for {duration}')).toBe('Worked for {duration}');
  });

  it('tRich() maps tags to React elements', () => {
    const tags = {
      terms: (children: string): ReactNode => createElement('a', { href: '/terms' }, children),
      privacy: (children: string): ReactNode => createElement('a', { href: '/privacy' }, children),
    };
    const node = tRich(
      'By continuing, you agree to our <terms>Terms of Service</terms> and have read our <privacy>Privacy Policy</privacy>.',
      tags,
    );
    const html = renderToStaticMarkup(node as any);
    expect(html).toContain('<a href="/terms">Terms of Service</a>');
    expect(html).toContain('<a href="/privacy">Privacy Policy</a>');
  });

  it('catalogs contain every §5.8 key in both locales', () => {
    const enCatalog: Record<string, string> = en;
    const arCatalog: Record<string, string> = ar;
    const enKeys = Object.keys(enCatalog).sort();
    const arKeys = Object.keys(arCatalog).sort();
    expect(arKeys).toEqual(enKeys);
    for (const key of enKeys) {
      expect(enCatalog[key]).toBeTruthy();
      expect(arCatalog[key]).toBeTruthy();
    }
  });

  it('setLocale updates document dir immediately (no reload)', () => {
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
    setLocale('ar');
    expect(getLocale()).toBe('ar');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(isRtl('ar')).toBe(true);
    setLocale('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('useLocale reflects locale and direction changes', () => {
    const { result } = renderHook(() => useLocale());
    expect(result.current.locale).toBe('en');
    expect(result.current.dir).toBe('ltr');
    expect(result.current.isRtl).toBe(false);

    act(() => {
      result.current.setLocale('ar');
    });
    expect(result.current.locale).toBe('ar');
    expect(result.current.dir).toBe('rtl');
    expect(result.current.isRtl).toBe(true);
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('auditComponentSource flags hard-coded JSX text', () => {
    const source = `export function X() { return <div>Hello world</div>; }`;
    const findings = auditComponentSource(source);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].text).toContain('Hello world');
  });

  it('auditComponentSource ignores whitelisted attributes and t() calls', () => {
    const source = `
      export function X() {
        return (
          <button className="px-2" aria-hidden="true" onClick={() => {}} title={t('Close')}>
            {t('Close')}
          </button>
        );
      }
    `;
    const findings = auditComponentSource(source);
    expect(findings).toHaveLength(0);
  });

  it('auditComponentSource flags hard-coded aria-label values', () => {
    const source = `export function X() { return <button aria-label="Close">✕</button>; }`;
    const findings = auditComponentSource(source);
    expect(findings.length).toBeGreaterThan(0);
  });
});
