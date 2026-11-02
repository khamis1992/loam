'use client';

import { useState } from 'react';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { t } from '@/i18n/t';
import { Section, Row } from './SettingsDialog';

const MODES = ['build', 'write', 'data', 'legal', 'research', 'ask'] as const;
type ModeName = (typeof MODES)[number];
type ReviewMode = 'off' | 'read' | 'run';

const DEFAULTS: Record<ModeName, ReviewMode> = {
  build: 'read',
  write: 'read',
  data: 'read',
  legal: 'read',
  research: 'off',
  ask: 'off',
};

export function SecondLookPane() {
  const [modes, setModes] = useState<Record<ModeName, ReviewMode>>(DEFAULTS);
  const [saved, setSaved] = useState(false);

  function setMode(name: ModeName, value: ReviewMode) {
    if (name === 'legal' && value === 'run') return;
    setModes((current) => ({ ...current, [name]: value }));
    setSaved(false);
  }

  async function save() {
    const headers = await getApiHeaders();
    await fetch(`${getApiBase()}/api/recall/settings`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ reviewModes: modes }),
    });
    setSaved(true);
  }

  return (
    <div dir="auto">
      <Section title={t('Second Look')}>
        <p className="py-2 text-xs text-text-tertiary">{t('A fresh review after a turn that edits files. Findings are a note, not a block. Legal mode never runs probes.')}</p>
        {MODES.map((name) => (
          <Row key={name} label={t(name)} description={name === 'legal' ? t('Read only') : t('Review mode')}>
            <select
              aria-label={name}
              value={modes[name]}
              onChange={(event) => setMode(name, event.target.value as ReviewMode)}
              className="rounded-control border border-border-main bg-bg-menu px-2 py-1 text-sm"
            >
              <option value="off">{t('Off')}</option>
              <option value="read">{t('Read')}</option>
              {name === 'legal' ? null : <option value="run">{t('Run')}</option>}
            </select>
          </Row>
        ))}
        <button type="button" onClick={() => void save()} className="mt-3 rounded-control bg-fill-tsp px-3 py-1 text-sm">{t('Save')}</button>
        {saved ? <p className="mt-2 text-xs text-text-tertiary">{t('Saved')}</p> : null}
      </Section>
    </div>
  );
}
