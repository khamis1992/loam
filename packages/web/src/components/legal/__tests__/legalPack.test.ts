import { describe, expect, it } from 'vitest';
import { attestLegalPack, canonicalLegalText } from '../legalPack';
import type { LegalPack } from '@/services/legalApi';

const pack: LegalPack = {
  format: 'loam-legal-pack/1',
  legislation: { type: 'law', year: 2096, number: 1, titleAr: 'قانون اختباري', effectiveDate: '2096-01-01' },
  source: { provenance: 'official_gazette', retrievedAt: '2096-01-02' },
  articles: [{ label: '1', text: 'نص اختباري' }],
};

const input = { firstReviewer: 'مراجع أول', secondReviewer: 'مراجع ثان', rightsBasis: 'fixture', rightsReference: 'TEST', rightsConfirmedBy: 'مسؤول الحقوق', attestedAt: '2096-01-03T00:00:00.000Z' };

describe('official pack attestation', () => {
  it('hashes the exact canonical text and original source and records two reviewers', async () => {
    const source = new File(['official source'], 'law.txt');
    const attested = await attestLegalPack(pack, source, input);
    expect(attested.source.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(attested.source.reviewedTextSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(attested.source.verifiedBy).toBe(input.firstReviewer);
    expect(attested.source.secondVerifiedBy).toBe(input.secondReviewer);
    expect(attested.source.usageRights?.reference).toBe('TEST');
    expect(canonicalLegalText(attested)).toBe(canonicalLegalText(pack));
  });

  it('refuses one-person approval or missing rights', async () => {
    const source = new File(['official source'], 'law.txt');
    await expect(attestLegalPack(pack, source, { ...input, secondReviewer: input.firstReviewer })).rejects.toThrow('Two different');
    await expect(attestLegalPack(pack, source, { ...input, rightsReference: '' })).rejects.toThrow('rights');
  });
});
