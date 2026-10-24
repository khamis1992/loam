'use client';

import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { Section, Row } from './SettingsDialog';
import {
  listHandoffs, listWikiPages, resolveHandoff, setWikiEnabled, wikiStatus,
  type Handoff, type WikiPageMeta,
} from '@/services/wikiApi';

/** Project wiki and handoffs, shown inside the Memory settings pane. */
export function WikiSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pages, setPages] = useState<WikiPageMeta[]>([]);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await wikiStatus();
      setEnabled(s.enabled);
      if (s.enabled) {
        const [p, h] = await Promise.all([listWikiPages(), listHandoffs('open')]);
        setPages(p.pages);
        setHandoffs(h.handoffs);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = async () => {
    try {
      setEnabled((await setWikiEnabled(!enabled)).enabled);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const resolve = async (id: string, to: 'accepted' | 'dismissed') => {
    try {
      await resolveHandoff(id, to);
      setHandoffs((list) => list.filter((h) => h.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Section title={t('Project wiki')}>
      {enabled === null && !error ? (
        <div className="flex items-center gap-2 py-4 text-text-secondary">
          <Loader2 className="size-4 animate-spin" /> {t('Loading')}
        </div>
      ) : (
        <>
          <Row label={t('Wiki state')} description={t('Keeps session summaries, notes and handoffs for this project on this device.')}>
            <button
              type="button"
              onClick={() => void toggle()}
              className={clsx('rounded-full px-2 py-0.5 text-[10px] font-medium', enabled ? 'bg-function-success-tsp text-function-success' : 'bg-fill-tsp text-text-tertiary')}
            >
              {enabled ? t('Wiki on') : t('Wiki off')}
            </button>
          </Row>
          {error && <p className="py-2 text-xs text-function-error">{error}</p>}
          {enabled && (
            <>
              <Row label={t('Wiki pages')} description={t('Pages stored for this project.')}>
                <span className="text-sm text-text-primary">{pages.length}</span>
              </Row>
              {pages.slice(0, 20).map((p) => (
                <div key={`${p.kind}/${p.id}`} className="flex items-center gap-2 py-1 text-sm text-text-primary">
                  <BookOpen className="size-4 shrink-0 text-text-tertiary" />
                  <span className="truncate">{p.title}</span>
                  <span className="rounded-full bg-fill-tsp px-1.5 py-0.5 text-[10px] text-text-secondary">{p.kind}</span>
                </div>
              ))}
              <p className="pt-3 text-xs font-medium text-text-secondary">{t('Open handoffs')}</p>
              {handoffs.length === 0 ? (
                <p className="py-2 text-sm text-text-tertiary">{t('No open handoffs.')}</p>
              ) : (
                handoffs.map((h) => (
                  <div key={h.id} className="flex items-center justify-between gap-2 py-1">
                    <span className="truncate text-sm text-text-primary">{h.title}</span>
                    <span className="flex gap-1">
                      <button type="button" className="rounded-full bg-fill-tsp px-2 py-0.5 text-[10px] text-text-secondary" onClick={() => void resolve(h.id, 'accepted')}>{t('Accept')}</button>
                      <button type="button" className="rounded-full bg-fill-tsp px-2 py-0.5 text-[10px] text-text-secondary" onClick={() => void resolve(h.id, 'dismissed')}>{t('Dismiss')}</button>
                    </span>
                  </div>
                ))
              )}
            </>
          )}
        </>
      )}
    </Section>
  );
}
