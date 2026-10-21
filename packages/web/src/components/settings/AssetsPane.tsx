import { useCallback, useEffect, useState } from 'react';
import { t } from '@/i18n/t';
import { Row, Section } from './SettingsDialog';
import { Button } from '@/components/ui/Button';
import {
  fetchAssets,
  injectMockInboundEmail,
  setAssetsEmailAlias,
  setAssetsPhoneNumber,
  setAssetsWalletPlaceholder,
  type AssetsSnapshot,
  type InboundEmail,
} from '@/services/creditsApi';

interface InjectDraft {
  from: string;
  subject: string;
  body: string;
}

const EMPTY_DRAFT: InjectDraft = { from: '', subject: '', body: '' };

type AssetField = 'alias' | 'phone' | 'wallet';

/**
 * Settings > Assets (Email / Phone / Wallet), OPD option #8.
 *
 * Everything here is a local mock: the server stores an inbound email alias, a
 * phone number and a wallet/billing placeholder, but no real telephony or
 * billing provider is connected. Notes state which external provider a real
 * deployment would need.
 */
export function AssetsPane({ kind }: { kind: 'Email' | 'Phone' | 'Wallet' }) {
  const [assets, setAssets] = useState<AssetsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<InjectDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [alias, setAlias] = useState('');
  const [phone, setPhone] = useState('');
  const [wallet, setWallet] = useState('');
  const [saving, setSaving] = useState<AssetField | null>(null);

  const load = useCallback(() => {
    fetchAssets()
      .then((data) => {
        setAssets(data);
        setAlias(data.email.address);
        setPhone(data.phone.number);
        setWallet(data.wallet.placeholder);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(load, [load]);

  const save = async (field: AssetField) => {
    setSaving(field);
    setNotice(null);
    setError(null);
    try {
      if (field === 'alias') await setAssetsEmailAlias(alias);
      else if (field === 'phone') await setAssetsPhoneNumber(phone);
      else await setAssetsWalletPlaceholder(wallet);
      setNotice(t('Saved'));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const inject = async () => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const { message } = await injectMockInboundEmail(draft);
      setNotice(t('Added mock message from {from}', { from: message.from }));
      setDraft(EMPTY_DRAFT);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!assets) {
    return <p className="text-sm text-text-tertiary">{error ?? '…'}</p>;
  }

  const status = (
    <>
      {notice && <p className="text-sm text-text-tertiary">{notice}</p>}
      {error && <p className="text-sm text-func-error">{error}</p>}
    </>
  );

  if (kind === 'Email') {
    return (
      <div className="space-y-2">
        <Section title={t('Mock email address')}>
          <Row label={t('Address')} description={t('Messages sent to this address appear in the mock inbox.')}>
            <span className="text-sm text-text-secondary">{assets.email.address}</span>
          </Row>
          <Row label={t('Provider')} description={t('For real use you would connect: {provider}', { provider: assets.email.realProvider })}>
            <span className="rounded-full bg-fill-tsp px-2 py-0.5 text-xs text-text-secondary">{t('Mock')}</span>
          </Row>
        </Section>
        <Section title={t('Inbound email alias')}>
          <div className="flex flex-col gap-2 py-2">
            <input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder={t('name@example.com')}
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-2 text-sm text-text-primary placeholder:text-text-tertiary"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" loading={saving === 'alias'} onClick={() => void save('alias')} disabled={!alias.trim()}>
                {t('Save alias')}
              </Button>
            </div>
          </div>
        </Section>
        <Section title={t('Mock inbox')}>
          {assets.email.inbox.length === 0 && <p className="py-2 text-sm text-text-tertiary">{t('No messages')}</p>}
          {assets.email.inbox.length > 0 && (
            <ul className="divide-y divide-border-main">
              {assets.email.inbox.map((message: InboundEmail) => (
                <li key={message.id} className="py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm text-text-primary">{message.subject}</span>
                    <span className="shrink-0 text-xs text-text-tertiary">{new Date(message.receivedAt).toLocaleString()}</span>
                  </div>
                  <div className="truncate text-xs text-text-tertiary">{t('From {from}', { from: message.from })}</div>
                  {message.body && <div className="mt-0.5 text-xs text-text-secondary">{message.body}</div>}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title={t('Add a test message')}>
          <div className="flex flex-col gap-2 py-2">
            <input
              value={draft.from}
              placeholder={t('From')}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-2 text-sm text-text-primary placeholder:text-text-tertiary"
            />
            <input
              value={draft.subject}
              placeholder={t('Subject')}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-2 text-sm text-text-primary placeholder:text-text-tertiary"
            />
            <textarea
              value={draft.body}
              placeholder={t('Body')}
              rows={2}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              className="w-full rounded-control border border-border-main bg-fill-tsp px-2 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" loading={busy} onClick={() => void inject()} disabled={!draft.from.trim() || !draft.subject.trim()}>
                {t('Add to inbox')}
              </Button>
            </div>
          </div>
        </Section>
        {status}
      </div>
    );
  }

  if (kind === 'Phone') {
    return (
      <div className="space-y-2">
        <Section title={t('Mock phone number')}>
          <Row label={t('Number')} description={t('A fictional 555-01xx number; nothing is dialed or received.')}>
            <span className="text-sm text-text-secondary">{assets.phone.number}</span>
          </Row>
          <Row label={t('Provider')} description={t('For real use you would connect: {provider}', { provider: assets.phone.realProvider })}>
            <span className="rounded-full bg-fill-tsp px-2 py-0.5 text-xs text-text-secondary">
              {assets.phone.connected ? t('Connected') : t('Not connected')}
            </span>
          </Row>
        </Section>
        <Section title={t('Phone number')}>
          <div className="flex flex-col gap-2 py-2">
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={t('+1 (555) 010-0000')}
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-2 text-sm text-text-primary placeholder:text-text-tertiary"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" loading={saving === 'phone'} onClick={() => void save('phone')} disabled={!phone.trim()}>
                {t('Save number')}
              </Button>
            </div>
          </div>
        </Section>
        {status}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Section title={t('Wallet')}>
        <Row label={t('Balance')} description={t('The mock wallet holds the same credit balance as your plan.')}>
          <span className="text-sm font-medium text-text-primary">{assets.wallet.balance.toLocaleString('en')} {t('credits')}</span>
        </Row>
        <Row label={t('Provider')} description={t('For real use you would connect: {provider}', { provider: assets.wallet.realProvider })}>
          <span className="rounded-full bg-fill-tsp px-2 py-0.5 text-xs text-text-secondary">
            {assets.wallet.connected ? t('Connected') : t('Not connected')}
          </span>
        </Row>
      </Section>
      <Section title={t('Billing placeholder')}>
        <div className="flex flex-col gap-2 py-2">
          <input
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            placeholder={t('e.g. Stripe customer id')}
            className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-2 text-sm text-text-primary placeholder:text-text-tertiary"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" loading={saving === 'wallet'} onClick={() => void save('wallet')}>
              {t('Save placeholder')}
            </Button>
          </div>
        </div>
      </Section>
      {status}
    </div>
  );
}
