import { useRouter } from 'next/navigation';
import { useAppSelector, useAppDispatch } from '@/store';
import { t, PRODUCT } from '@/i18n/t';
import { Row, Section } from './SettingsDialog';
import { Button } from '@/components/ui/Button';
import { logoutAndRedirect } from '@/services/desktopApis';

export function AccountPane() {
  const user = useAppSelector((s) => s.auth.user);
  const router = useRouter();
  const dispatch = useAppDispatch();
  const name = user?.displayname || 'Demo User';
  const email = user?.email || 'demo@example.com';

  return (
    <div className="space-y-2">
      <Section title={t('Account')}>
        <Row label={t('Name')} description={name}>
          <span className="text-sm text-text-secondary">{name}</span>
        </Row>
        <Row label={t('Email')} description={email}>
          <span className="text-sm text-text-secondary">{email}</span>
        </Row>
      </Section>

      <Section title={t('Plan')}>
        <Row label={t('Current plan')} description={t('Free plan')}>
          <Button variant="primary" size="sm">{t('Upgrade')}</Button>
        </Row>
      </Section>

      <Section title={t('Danger zone')}>
        <Row label={t('Log out')} description={t('Sign out of {product}.', { product: PRODUCT })}>
          <Button variant="ghost" size="sm" onClick={() => { void logoutAndRedirect(router, dispatch); }}>{t('Log out')}</Button>
        </Row>
        <Row label={t('Delete account')} description={t('Permanently remove your account.')}>
          <Button variant="danger" size="sm">{t('Delete account')}</Button>
        </Row>
      </Section>
    </div>
  );
}
