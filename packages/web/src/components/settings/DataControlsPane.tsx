import { useState } from 'react';
import { t } from '@/i18n/t';
import { Row, Section } from './SettingsDialog';
import { EmptyState } from './EmptyState';
import { Button } from '@/components/ui/Button';

export function DataControlsPane() {
  const [days, setDays] = useState('30');

  return (
    <div className="space-y-2">
      <Section title={t('Worktree management')}>
        <Row label={t('Auto-clean worktrees')} description={t('Remove temporary worktrees older than the selected days.')}>
          <select
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="h-row-sm rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary"
          >
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
          </select>
        </Row>
        <Row label={t('Clean up now')} description={t('Manually clean up temporary worktrees.')}>
          <Button variant="secondary" size="sm">{t('Clean up')}</Button>
        </Row>
      </Section>

      <Section title={t('Data retention')}>
        <EmptyState title={t('Coming soon')} />
      </Section>
    </div>
  );
}
