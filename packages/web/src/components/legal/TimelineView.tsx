'use client';

import { t } from '@/i18n/t';
import type { TimelineEvent } from '@/services/legalApi';

export function TimelineView({ events }: { events: TimelineEvent[] }) {
  return (
    <section>
      <h3 className="mb-2 font-semibold">{t('Timeline')}</h3>
      <ol className="space-y-2 border-s-2 ps-3">
        {events.map((event) => (
          <li key={event.id}>
            <time dir="ltr" className="text-xs opacity-60">{event.sortDate}</time>
            <p className="text-sm">{event.description}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
