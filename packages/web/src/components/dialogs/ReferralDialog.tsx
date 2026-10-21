'use client';

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { t } from '@/i18n/t';
import { Button } from '@/components/ui/Button';
import { Dialog } from './Dialog';
import { createReferral, redeemReferralCode, type ReferralInfo, type ReferralRedeem } from '@/services/creditsApi';

export function ReferralDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [referral, setReferral] = useState<ReferralInfo | null>(null);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReferralRedeem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    createReferral()
      .then((info) => { if (!cancelled) setReferral(info); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [open]);

  const copy = async (text: string, kind: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard unavailable; leave text selected
    }
  };

  const redeem = async () => {
    const code = inputValue.trim();
    if (!code) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await redeemReferralCode(code));
      setInputValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('Share Loam with a friend')} width={480}>
      <p className="mb-4 text-sm text-text-secondary">{t('Get 500 credits each')}</p>

      {!referral ? (
        error
          ? <p className="text-xs text-func-error">{error}</p>
          : <p className="text-xs text-text-tertiary">…</p>
      ) : (
        <div className="mb-4 space-y-2">
          <label className="block">
            <span className="mb-1 block text-xs text-text-tertiary">{t('Your referral code')}</span>
            <div className="flex items-center gap-1">
              <input
                readOnly
                value={referral.code}
                className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-2 text-sm text-text-primary"
              />
              <Button size="sm" variant="ghost" aria-label={t('Copy code')} onClick={() => void copy(referral.code, 'code')}>
                {copied === 'code' ? <Check className="size-3.5 text-func-success" /> : <Copy className="size-3.5" />}
              </Button>
            </div>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-text-tertiary">{t('Referral link')}</span>
            <div className="flex items-center gap-1">
              <input
                readOnly
                value={referral.link}
                className="h-row-sm w-full truncate rounded-control border border-border-main bg-fill-tsp px-2 text-sm text-text-primary"
              />
              <Button size="sm" variant="ghost" aria-label={t('Copy link')} onClick={() => void copy(referral.link, 'link')}>
                {copied === 'link' ? <Check className="size-3.5 text-func-success" /> : <Copy className="size-3.5" />}
              </Button>
            </div>
          </label>
        </div>
      )}

      <div className="mb-1 rounded-card border border-border-main p-3">
        <span className="mb-2 block text-xs text-text-tertiary">{t('Redeem a code')}</span>
        <div className="flex items-center gap-1.5">
          <input
            value={inputValue}
            placeholder="LOAM-XXXXXX"
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void redeem(); }}
            className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-2 text-sm text-text-primary placeholder:text-text-tertiary"
          />
          <Button size="sm" variant="primary" loading={busy} onClick={() => void redeem()} disabled={!inputValue.trim()}>
            {t('Redeem')}
          </Button>
        </div>
        {result && !result.alreadyRedeemed && (
          <p className="mt-2 text-xs text-func-success">{t('+{n} credits added', { n: 500 })}</p>
        )}
        {result?.alreadyRedeemed && (
          <p className="mt-2 text-xs text-text-tertiary">{t('This code has already been redeemed')}</p>
        )}
        {error && <p className="mt-2 text-xs text-func-error">{error}</p>}
      </div>
    </Dialog>
  );
}
