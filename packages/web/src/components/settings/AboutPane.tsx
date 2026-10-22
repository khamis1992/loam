'use client';

import { t, PRODUCT } from '@/i18n/t';
import { Row, Section } from './SettingsDialog';

export function AboutPane() {
  const version =
    (typeof window !== 'undefined' && (window as any).desktopSync?.appVersion) ||
    '0.0.0';

  return (
    <div className="space-y-2">
      <Section title={t('About')}>
        <Row label={t('Version')} description={`${PRODUCT} ${version}`}>
          <span className="text-sm text-text-secondary">{version}</span>
        </Row>
      </Section>
    </div>
  );
}
