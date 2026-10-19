import { useAppSelector } from '@/store';
import { t } from '@/i18n/t';
import { Row, Section } from './SettingsDialog';

export function UsagePane() {
  const user = useAppSelector((s) => s.auth.user);
  const credits = { totalCredits: 18100, freeCredits: 300, refreshCredits: 300, maxRefreshCredits: 300 };

  return (
    <div className="space-y-2">
      <Section title={t('Credits')}>
        <Row label={t('Total credits')} description={t('Credits available to use across all tasks.')}>
          <span className="text-sm font-medium text-text-primary">{credits.totalCredits.toLocaleString()}</span>
        </Row>
        <Row label={t('Free credits')} description={t('Complimentary credits that refresh periodically.')}>
          <span className="text-sm text-text-secondary">{credits.freeCredits}</span>
        </Row>
        <Row label={t('Refresh credits')} description={t('Credits restored on your next refresh.')}>
          <span className="text-sm text-text-secondary">{credits.refreshCredits} / {credits.maxRefreshCredits}</span>
        </Row>
      </Section>

      <Section title={t('Usage')}>
        <Row label={t('Tasks completed')} description={t('Total tasks completed this billing period.')}>
          <span className="text-sm text-text-secondary">0</span>
        </Row>
      </Section>
    </div>
  );
}
