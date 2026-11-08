import type { LegalPack } from '@/services/legalApi';

export interface PackAttestationInput {
  firstReviewer: string;
  secondReviewer: string;
  rightsBasis: string;
  rightsReference: string;
  rightsConfirmedBy: string;
  attestedAt?: string;
}

export function canonicalLegalText(pack: LegalPack): string {
  return JSON.stringify({ legislation: pack.legislation, articles: pack.articles, amends: pack.amends ?? [], repeals: pack.repeals ?? [] });
}

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function attestLegalPack(pack: LegalPack, sourceFile: File, input: PackAttestationInput): Promise<LegalPack> {
  const firstReviewer = input.firstReviewer.trim();
  const secondReviewer = input.secondReviewer.trim();
  if (!firstReviewer || !secondReviewer || firstReviewer.localeCompare(secondReviewer, undefined, { sensitivity: 'base' }) === 0) throw new Error('Two different source reviewers are required');
  if (!input.rightsBasis.trim() || !input.rightsReference.trim() || !input.rightsConfirmedBy.trim()) throw new Error('Source usage rights details are required');
  const attestedAt = input.attestedAt ?? new Date().toISOString();
  const [sourceSha256, reviewedTextSha256] = await Promise.all([sha256Hex(await sourceFile.arrayBuffer()), sha256Hex(canonicalLegalText(pack))]);
  return {
    ...pack,
    source: {
      ...pack.source,
      sourceSha256, reviewedTextSha256,
      verifiedBy: firstReviewer, verifiedAt: attestedAt,
      secondVerifiedBy: secondReviewer, secondVerifiedAt: attestedAt,
      usageRights: { basis: input.rightsBasis.trim(), reference: input.rightsReference.trim(), confirmedBy: input.rightsConfirmedBy.trim(), confirmedAt: attestedAt },
    },
  };
}
