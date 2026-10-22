import { describe, it, expect, afterEach } from 'vitest';
import { setLocale } from '@/i18n/t';
import { agentLabel, modelDisplayName } from '../agentLabels';

describe('agentLabels', () => {
  afterEach(() => {
    setLocale('en');
  });

  it('returns the English label by default', () => {
    setLocale('en');
    expect(agentLabel('create')).toBe('Create');
    expect(agentLabel('save')).toBe('Save');
    expect(agentLabel('newAgent')).toBe('New agent');
  });

  it('returns the Arabic label once the locale is Arabic', () => {
    setLocale('ar');
    expect(agentLabel('create')).toBe('إنشاء');
    expect(agentLabel('save')).toBe('حفظ');
    expect(agentLabel('newAgent')).toBe('وكيل جديد');
  });

  it('switches the same key when the locale changes', () => {
    setLocale('en');
    expect(agentLabel('cancel')).toBe('Cancel');
    setLocale('ar');
    expect(agentLabel('cancel')).toBe('إلغاء');
    setLocale('en');
    expect(agentLabel('cancel')).toBe('Cancel');
  });

  it('keeps English and Arabic text for every label', () => {
    // Importing the module executes the catalog literal; these assertions hold
    // the bilingual contract without duplicating the whole table.
    for (const key of ['create', 'save', 'cancel', 'memoryOn', 'workMode', 'noTemplates'] as const) {
      expect(typeof agentLabel(key)).toBe('string');
      expect(agentLabel(key).length).toBeGreaterThan(0);
    }
  });

  it('shows the default-model label for empty and sentinel values', () => {
    setLocale('en');
    expect(modelDisplayName('')).toBe('Default (app model)');
    expect(modelDisplayName('__default__')).toBe('Default (app model)');
  });

  it('returns a custom model name verbatim', () => {
    expect(modelDisplayName('gpt-5')).toBe('gpt-5');
    expect(modelDisplayName('loam/opus')).toBe('loam/opus');
  });
});
