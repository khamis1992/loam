import { describe, it, expect } from 'vitest';
import { t, tRich, setLocale, PRODUCT, isRtl } from '../t';
import { createElement, Fragment } from 'react';

describe('i18n t()', () => {
  it('interpolates variables and {product}', () => {
    setLocale('en');
    expect(t('Sign in to {product}', { product: PRODUCT })).toBe('Sign in to Loam');
    expect(t('Worked for {duration}', { duration: '12s' })).toBe('Worked for 12s');
  });

  it('falls back to key when missing', () => {
    setLocale('en');
    expect(t('__missing__')).toBe('__missing__');
  });

  it('renders Arabic with correct placeholder', () => {
    setLocale('ar');
    expect(t('Sign in to {product}', { product: PRODUCT })).toBe('تسجيل الدخول إلى Loam');
    setLocale('en');
  });

  it('detects RTL for ar', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en')).toBe(false);
  });
});
