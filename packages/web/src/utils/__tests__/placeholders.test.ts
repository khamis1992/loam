import { describe, it, expect } from 'vitest';

import { isCorruptedPlaceholder } from '../placeholders';

describe('isCorruptedPlaceholder', () => {
  it('flags pure question-mark placeholders', () => {
    expect(isCorruptedPlaceholder('?????')).toBe(true);
    expect(isCorruptedPlaceholder('????? ??????')).toBe(true);
    expect(isCorruptedPlaceholder(' ? ? ? ')).toBe(true);
  });

  it('does not flag real, readable text', () => {
    expect(isCorruptedPlaceholder('مشروع عربي')).toBe(false);
    expect(isCorruptedPlaceholder('Qatar plans')).toBe(false);
    expect(isCorruptedPlaceholder('plan?')).toBe(false);
    expect(isCorruptedPlaceholder('')).toBe(false);
    expect(isCorruptedPlaceholder('   ')).toBe(false);
  });
});
