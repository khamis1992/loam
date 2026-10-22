import { describe, it, expect } from 'vitest';

import { dedupeBrandLabel, LOAM_MODES } from '../modeLabels';
import { PRODUCT } from '../../../i18n/t';

describe('ModeChip brand dedupe', () => {
  it('keeps the brand exactly once for every mode label', () => {
    for (const mode of LOAM_MODES) {
      const brandFull = `${PRODUCT} ${mode.label}`;
      expect(dedupeBrandLabel(brandFull)).toBe(brandFull);
      expect(dedupeBrandLabel(`${PRODUCT} ${brandFull}`)).toBe(brandFull);
    }
  });

  it('collapses duplicated brand prefixes', () => {
    expect(dedupeBrandLabel('Loam Loam')).toBe('Loam');
    expect(dedupeBrandLabel('Loam Loam Build')).toBe('Loam Build');
    expect(dedupeBrandLabel('  Loam Loam Loam Build ')).toBe('Loam Build');
  });

  it('leaves plain mode labels untouched', () => {
    expect(dedupeBrandLabel('Build')).toBe('Build');
    expect(dedupeBrandLabel('Loam Antique')).toBe('Loam Antique');
    expect(dedupeBrandLabel('لوام بناء')).toBe('لوام بناء');
  });

  it('handles empty and brand-only labels', () => {
    expect(dedupeBrandLabel('')).toBe('');
    expect(dedupeBrandLabel('Loam')).toBe('Loam');
    expect(dedupeBrandLabel('Loam Loam Loam')).toBe('Loam');
  });
});
