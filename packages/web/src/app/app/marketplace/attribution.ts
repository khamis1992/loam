import { t } from '@/i18n/t';

/** URL of the bundled third-party notices file. */
export const NOTICES_PATH = '/marketplace/THIRD_PARTY_NOTICES';

export type AttributionSourceKind = 'xai' | 'botdirectory';

export interface AttributionInput {
  source: AttributionSourceKind[];
  author: { name?: string; handle?: string; url?: string; scoutedBy?: string };
  sourceUrl: string;
  license: string;
  addHref?: string;
  alsoAt?: string[];
}

export interface SourceAttribution {
  kind: AttributionSourceKind;
  contributor: string;
  contributorUrl?: string;
  sourceUrl: string;
  sourceTextLabel: string;
  licenseShort: string;
  addUrl?: string;
  scoutedBy?: string;
}

export interface EntryAttribution {
  sources: SourceAttribution[];
  internalOnly: boolean;
  licenseLine: string;
}

export function buildAttribution(entry: AttributionInput): EntryAttribution {
  const sources: SourceAttribution[] = [];
  if (entry.source.includes('botdirectory')) {
    sources.push({
      kind: 'botdirectory',
      contributor: entry.author.name || t('a botdirectory contributor'),
      contributorUrl: entry.author.url,
      sourceUrl: entry.sourceUrl,
      sourceTextLabel: 'botdirectory.ai',
      licenseShort: 'MIT',
      scoutedBy: entry.author.scoutedBy,
    });
  }
  if (entry.source.includes('xai')) {
    sources.push({
      kind: 'xai',
      contributor: entry.author.name || (entry.author.handle ? `@${entry.author.handle}` : t('Unknown author')),
      sourceUrl: entry.sourceUrl,
      sourceTextLabel: `x.ai ${t('listing')}`,
      licenseShort: t('all rights reserved'),
      addUrl: entry.addHref,
    });
  }
  return {
    sources,
    internalOnly: entry.source.includes('xai'),
    licenseLine: entry.license,
  };
}
