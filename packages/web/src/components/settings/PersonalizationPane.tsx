'use client';

import { useCallback, useEffect, useState } from 'react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { Section } from './SettingsDialog';
import { Button } from '@/components/ui/Button';

/**
 * Settings > Personalization (UNIMPLEMENTED_OPTIONS #2).
 *
 * Two free-form instruction fields persisted by the Loam server and appended to
 * every agent system prompt (src/agent/prompt.ts):
 *  - GET  /api/personalization  → load the stored instructions
 *  - POST /api/personalization  → persist edits
 *
 * Fail-safe by design: a store or network failure only surfaces as a message and
 * never blocks the settings dialog.
 */

interface Personalization {
  aboutMe: string;
  howToRespond: string;
  updatedAt: string;
}

const MAX_LEN = 8000;

export function PersonalizationPane() {
  const [aboutMe, setAboutMe] = useState('');
  const [howToRespond, setHowToRespond] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/personalization`, { headers: await getApiHeaders() });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { personalization?: Personalization };
      setAboutMe(data.personalization?.aboutMe ?? '');
      setHowToRespond(data.personalization?.howToRespond ?? '');
      setNotice(null);
    } catch {
      setNotice({ kind: 'error', text: t('Could not load your instructions') });
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch(`${getApiBase()}/api/personalization`, {
        method: 'POST',
        headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({ aboutMe, howToRespond }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { personalization?: Personalization };
      setAboutMe(data.personalization?.aboutMe ?? aboutMe);
      setHowToRespond(data.personalization?.howToRespond ?? howToRespond);
      setNotice({ kind: 'ok', text: t('Instructions saved') });
    } catch {
      setNotice({ kind: 'error', text: t('Could not save your instructions') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <Section title={t('About you')}>
        <div className="py-1">
          <p className="mb-2 text-xs text-text-tertiary">{t('Describe yourself so Loam can tailor its work to you.')}</p>
          <label htmlFor="personalization-about" className="sr-only">{t('About you')}</label>
          <textarea
            id="personalization-about"
            value={aboutMe}
            rows={5}
            maxLength={MAX_LEN}
            placeholder={t('e.g. I work in finance and prefer concise summaries.')}
            onChange={(e) => setAboutMe(e.target.value)}
            disabled={!loaded || saving}
            className="w-full rounded-control border border-border-main bg-fill-tsp px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary disabled:opacity-60"
          />
        </div>
      </Section>

      <Section title={t('How to respond')}>
        <div className="py-1">
          <p className="mb-2 text-xs text-text-tertiary">{t('Tell Loam how it should behave in every task.')}</p>
          <label htmlFor="personalization-response" className="sr-only">{t('How to respond')}</label>
          <textarea
            id="personalization-response"
            value={howToRespond}
            rows={5}
            maxLength={MAX_LEN}
            placeholder={t('e.g. Always cite sources and keep answers under three sentences.')}
            onChange={(e) => setHowToRespond(e.target.value)}
            disabled={!loaded || saving}
            className="w-full rounded-control border border-border-main bg-fill-tsp px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary disabled:opacity-60"
          />
        </div>
      </Section>

      <div className="flex items-center gap-3 pt-2">
        <Button variant="primary" size="sm" loading={saving} disabled={!loaded} onClick={() => void save()}>
          {t('Save')}
        </Button>
        {notice && (
          <span className={notice.kind === 'ok' ? 'text-sm text-function-success' : 'text-sm text-function-error'}>{notice.text}</span>
        )}
      </div>
    </div>
  );
}
