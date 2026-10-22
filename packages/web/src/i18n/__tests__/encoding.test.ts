import { describe, it, expect } from 'vitest';
import en from '../en.json';
import ar from '../ar.json';

// Sequences that only appear when UTF-8 bytes were mis-decoded as Windows-1252.
const MOJIBAKE = /Ã|Â|Ø§|Ù„|â€/;

function mojibakeEntries(catalog: Record<string, string>): string[] {
  const bad: string[] = [];
  for (const [key, value] of Object.entries(catalog)) {
    if (MOJIBAKE.test(value) || MOJIBAKE.test(key)) bad.push(key);
  }
  return bad;
}

describe('i18n catalog encoding', () => {
  it('en.json has no mojibake markers in keys or values', () => {
    expect(mojibakeEntries(en as Record<string, string>)).toEqual([]);
  });

  it('ar.json has no mojibake markers in keys or values', () => {
    expect(mojibakeEntries(ar as Record<string, string>)).toEqual([]);
  });

  it('ar.json carries real Arabic content', () => {
    const chars = Object.values(ar as Record<string, string>)
      .join('')
      .match(/[\u0600-\u06ff]/g) ?? [];
    expect(chars.length).toBeGreaterThan(5000);
  });
});
