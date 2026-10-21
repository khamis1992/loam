import { describe, expect, it } from 'vitest';
import { buildAttribution, NOTICES_PATH } from './attribution';

describe('buildAttribution', () => {
  it('always exposes the bundled notices path', () => {
    expect(NOTICES_PATH).toBe('/marketplace/THIRD_PARTY_NOTICES');
  });

  it('builds botdirectory attribution with contributor, source URL and MIT license', () => {
    const result = buildAttribution({
      source: ['botdirectory'],
      author: { name: 'benln', url: 'https://x.com/benln', scoutedBy: 'elie' },
      sourceUrl: 'https://botdirectory.ai/bots/accountingbot/',
      license: 'MIT (Copyright (c) 2026 Inbox Zero Inc.)',
    });
    expect(result.internalOnly).toBe(false);
    expect(result.licenseLine).toBe('MIT (Copyright (c) 2026 Inbox Zero Inc.)');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      kind: 'botdirectory',
      contributor: 'benln',
      contributorUrl: 'https://x.com/benln',
      sourceUrl: 'https://botdirectory.ai/bots/accountingbot/',
      sourceTextLabel: 'botdirectory.ai',
      licenseShort: 'MIT',
      scoutedBy: 'elie',
    });
  });

  it('builds x.ai attribution as internal-only with all-rights-reserved license', () => {
    const result = buildAttribution({
      source: ['xai'],
      author: { name: 'Miguel Cruz', handle: 'cruzmiguel000' },
      sourceUrl: 'https://x.ai/bot/marketplace/bots/fuse',
      license: 'proprietary/unspecified (x.ai marketplace; no license published)',
      addHref: '/bot/fuse-share',
    });
    expect(result.internalOnly).toBe(true);
    expect(result.sources[0]).toMatchObject({
      kind: 'xai',
      contributor: 'Miguel Cruz',
      licenseShort: 'all rights reserved',
      addUrl: '/bot/fuse-share',
    });
    expect(result.sources[0]?.sourceTextLabel).toContain('x.ai');
  });

  it('includes both sources for a merged entry, botdirectory first', () => {
    const result = buildAttribution({
      source: ['xai', 'botdirectory'],
      author: { name: 'sam' },
      sourceUrl: 'https://botdirectory.ai/bots/sam/',
      license: 'MIT',
    });
    expect(result.sources.map((item) => item.kind)).toEqual(['botdirectory', 'xai']);
    expect(result.internalOnly).toBe(true);
  });

  it('falls back to anonymous contributor text when names are missing', () => {
    expect(
      buildAttribution({ source: ['botdirectory'], author: {}, sourceUrl: '', license: 'MIT' }).sources[0]?.contributor,
    ).toBe('a botdirectory contributor');
    expect(
      buildAttribution({ source: ['xai'], author: {}, sourceUrl: '', license: '' }).sources[0]?.contributor,
    ).toBe('Unknown author');
  });
});
