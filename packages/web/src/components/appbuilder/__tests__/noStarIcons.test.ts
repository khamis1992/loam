import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Cap G §4.16 gate: the App Builder surface never uses a Sparkles or Star icon —
 *  the Loam brand rule (MISSING §0.1). Scans every source file under this folder. */
const FORBIDDEN = [/Sparkles/, /\bStar\b/, /lucide-react\/.*star/i, /from 'lucide-react'.*\bStar\b/];

describe('appbuilder noStarIcons', () => {
  it('uses no Sparkles/Star icon anywhere in the App Builder sources', () => {
    const dir = join(__dirname, '..');
    // The gate file itself names the forbidden words; scan sources only.
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .map(String)
      .filter((f) => /\.[jt]sx?$/.test(f) && !f.includes('__tests__'));
    expect(files.length).toBeGreaterThan(0);
    for (const rel of files) {
      const text = readFileSync(join(dir, String(rel)), 'utf8');
      for (const re of FORBIDDEN) expect(text.match(re), `${rel} must not match ${re}`).toBeNull();
    }
  });
});
