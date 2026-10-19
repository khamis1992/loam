import { useState } from 'react';
import { useAppDispatch, useAppSelector, setLocale } from '@/store';
import { t, setLocale as setDocumentLocale } from '@/i18n/t';
import { Row, Section } from './SettingsDialog';

export function GeneralPane() {
  const locale = useAppSelector((s) => s.ui.locale);
  const dispatch = useAppDispatch();

  const handleLocale = (value: 'en' | 'ar') => {
    dispatch(setLocale(value));
    setDocumentLocale(value);
  };

  return (
    <div className="space-y-2">
      <Section title={t('Language')}>
        <Row label={t('Language')} description={t('Choose the language used in the interface.')}>
          <select
            value={locale}
            onChange={(e) => handleLocale(e.target.value as 'en' | 'ar')}
            className="h-row-sm rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary"
          >
            <option value="en">{t('English')}</option>
            <option value="ar">{t('Arabic')}</option>
          </select>
        </Row>
      </Section>

      <Section title={t('Chat preferences')}>
        <Row label={t('Default action while a task is running')} description={t('How new messages are delivered.')}>
          <select className="h-row-sm rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary">
            <option>{t('Send without interrupting')}</option>
            <option>{t('Queued')}</option>
            <option>{t('Interrupting')}</option>
          </select>
        </Row>
      </Section>

      <Section title={t('Communication preferences')}>
        <Row label={t('Browser notifications')}>
          <Switch />
        </Row>
        <Row label={t('Sound alert')}>
          <Switch />
        </Row>
        <Row label={t('Receive product updates')}>
          <Switch />
        </Row>
      </Section>
    </div>
  );
}

function Switch({ defaultOn = false }: { defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => setOn(!on)}
      className="relative h-5 w-9 rounded-full transition-colors"
      style={{ backgroundColor: on ? 'var(--icon-blue)' : 'var(--fill-tsp-white-dark)' }}
    >
      <span
        className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform"
        style={{ transform: on ? 'translateX(18px)' : 'translateX(2px)' }}
      />
    </button>
  );
}
