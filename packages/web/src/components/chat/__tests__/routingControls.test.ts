import { describe, it, expect } from 'vitest';

import {
  EFFORT_OPTIONS,
  OUTPUT_TYPE_LABEL,
  OUTPUT_TYPE_OPTIONS,
  normalizeEffort,
  normalizeOutputType,
  routingExtData,
} from '../routingControls';
import { OUTPUT_TYPES } from '@shared/socket';

describe('composer routing controls', () => {
  it('offers exactly the six output types the server accepts', () => {
    expect(OUTPUT_TYPES).toEqual(['auto', 'text', 'image', 'video', 'slides', 'website']);
    expect(OUTPUT_TYPE_OPTIONS.map((option) => option.value)).toEqual([...OUTPUT_TYPES]);
    // Every option must have a label, or the select renders a blank row.
    for (const option of OUTPUT_TYPE_OPTIONS) {
      expect(OUTPUT_TYPE_LABEL[option.value]).toBeTruthy();
    }
    expect(OUTPUT_TYPE_LABEL.auto).toBe('Auto (agent decides)');
    expect(OUTPUT_TYPE_LABEL.slides).toBe('Slides');
  });

  it('offers Fast and Max plus an unset entry', () => {
    expect(EFFORT_OPTIONS.map((option) => option.value)).toEqual(['', 'fast', 'max']);
  });

  it('normalizes the backend spellings case-insensitively', () => {
    expect(normalizeOutputType('Slides')).toBe('slides');
    expect(normalizeOutputType('  website ')).toBe('website');
    expect(normalizeOutputType('pdf')).toBeUndefined();
    expect(normalizeOutputType(undefined)).toBeUndefined();
    expect(normalizeOutputType(42)).toBeUndefined();
  });

  it('normalizes effort aliases and rejects unknown levels', () => {
    expect(normalizeEffort('Fast')).toBe('fast');
    expect(normalizeEffort('quick')).toBe('fast');
    expect(normalizeEffort('maximum')).toBe('max');
    expect(normalizeEffort('best')).toBe('max');
    expect(normalizeEffort('medium')).toBe('');
    expect(normalizeEffort('')).toBe('');
    expect(normalizeEffort(null)).toBe('');
  });

  it('omits unchanged values so a plain run keeps its payload shape', () => {
    // "auto" is the default, so it must not be sent; an unset effort must not be
    // sent either. A run that never touched the selectors produces an empty object,
    // exactly as it did before N10.
    expect(routingExtData({ outputType: 'auto', effort: '' })).toEqual({});
    expect(routingExtData({})).toEqual({});
    expect(routingExtData({ outputType: 'slides' })).toEqual({ outputType: 'slides' });
    expect(routingExtData({ effort: 'fast' })).toEqual({ effort: 'fast' });
  });

  it('only sends A/B arms when the run asked to compare models', () => {
    const arms = ['glm-5.4-flash:cloud', 'qwen3-coder-30b'];
    expect(routingExtData({ compareModels: true, abModels: arms })).toEqual({ abModels: arms });
    expect(routingExtData({ compareModels: false, abModels: arms })).toEqual({});
    expect(routingExtData({ compareModels: true, abModels: [] })).toEqual({});
  });

  it('sends the arms as a copy so the caller array is never shared', () => {
    const arms = ['model-a', 'model-b'];
    const ext = routingExtData({ compareModels: true, abModels: arms });
    expect(ext.abModels).toEqual(['model-a', 'model-b']);
    expect(ext.abModels).not.toBe(arms);
  });
});
