'use client';

import { ExternalLink } from 'lucide-react';
import { t } from '@/i18n/t';
import type { AttributionInput, SourceAttribution } from './attribution';
import { buildAttribution, NOTICES_PATH } from './attribution';

function SourceAttributionLine({ from }: { from: SourceAttribution }) {
  if (from.kind === 'botdirectory') {
    return (
      <p>
        {t('Prompt contributed by')} {from.contributor}
        {from.contributorUrl && (
          <>
            {' '}
            <a href={from.contributorUrl} target="_blank" rel="noreferrer" className="underline hover:text-text-secondary">
              {t('profile')}
            </a>
          </>
        )}
        {' · '}
        <a href={from.sourceUrl} target="_blank" rel="noreferrer" className="underline hover:text-text-secondary">
          {from.sourceTextLabel}
        </a>
        {' · '}
        {from.licenseShort}
        {from.scoutedBy && <> · {t('scouted by {name}', { name: from.scoutedBy })}</>}
      </p>
    );
  }
  return (
    <p>
      {t('By {author}', { author: from.contributor })}
      {' · '}
      <a href={from.sourceUrl} target="_blank" rel="noreferrer" className="underline hover:text-text-secondary">
        {from.sourceTextLabel}
        <ExternalLink className="ms-1 inline size-3" aria-hidden />
      </a>
      {from.addUrl && (
        <>
          {' · '}
          <a href={from.addUrl} target="_blank" rel="noreferrer" className="underline hover:text-text-secondary">
            {t('Add on x.ai')}
          </a>
        </>
      )}
      {' · '}
      {from.licenseShort}
    </p>
  );
}

export function EntryAttribution({ entry }: { entry: AttributionInput }) {
  const { sources, internalOnly, licenseLine } = buildAttribution(entry);
  return (
    <section className="mt-7">
      <h3 className="border-b border-border-main pb-2 text-sm font-semibold text-text-primary">{t('Source')}</h3>
      <div className="mt-3 space-y-2 text-[12.5px] leading-6 text-text-tertiary">
        {sources.map((from) => (
          <SourceAttributionLine key={from.kind} from={from} />
        ))}
        {entry.alsoAt?.map((url) => (
          <p key={url}>
            {t('Also listed at')}{' '}
            <a href={url} target="_blank" rel="noreferrer" className="underline hover:text-text-secondary">
              {url}
            </a>
          </p>
        ))}
        <p className="font-mono text-[11.5px] text-text-tertiary">{licenseLine}</p>
        {internalOnly && (
          <p>
            {t(
              'Internal build only: x.ai marketplace content ships with this personal build and is not licensed for redistribution.',
            )}{' '}
            <a href={NOTICES_PATH} target="_blank" rel="noreferrer" className="underline hover:text-text-secondary">
              {t('Third-party notices')}
            </a>
          </p>
        )}
      </div>
    </section>
  );
}
