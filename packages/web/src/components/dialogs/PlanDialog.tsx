'use client';

import { useEffect, useState } from 'react';
import { Zap } from 'lucide-react';
import { t } from '@/i18n/t';
import { Button } from '@/components/ui/Button';
import { Dialog } from './Dialog';
import {
  fetchCredits, purchaseMockCredits, setMockPlan,
  type CreditLedgerEntry, type CreditPlan,
} from '@/services/creditsApi';

interface Pack {
  id: string;
  name: string;
  credits: number;
}

const PACKS: Pack[] = [
  { id: 'starter', name: 'Starter', credits: 1000 },
  { id: 'boost', name: 'Boost', credits: 5000 },
  { id: 'mega', name: 'Mega', credits: 20000 },
];

export function PlanDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [balance, setBalance] = useState<number | null>(null);
  const [plan, setPlan] = useState<CreditPlan>('free');
  const [ledger, setLedger] = useState<CreditLedgerEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchCredits()
      .then((data) => {
        if (cancelled) return;
        setBalance(data.balance);
        setPlan(data.plan);
        setLedger(data.ledger);
      })
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => { cancelled = true; };
  }, [open, order]);

  const purchase = async (packId: string) => {
    setBusy(packId);
    setError(null);
    try {
      const res = await purchaseMockCredits(packId);
      setBalance(res.balance);
      setPlan(res.plan);
      setOrder((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const togglePlan = async () => {
    setBusy('plan');
    setError(null);
    try {
      const res = await setMockPlan(plan === 'pro' ? 'free' : 'pro');
      setPlan(res.plan);
      setOrder((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('Plans and credits')} width={520}>
      <div className="mb-3 flex items-center gap-2 rounded-control bg-fill-tsp px-3 py-2 text-xs text-text-secondary">
        <Zap className="size-3.5 shrink-0 text-icon-blue" aria-hidden />
        <span>{t('Test mode - no charge')}</span>
      </div>

      <div className="mb-4 flex items-center justify-between rounded-card border border-border-main px-3 py-2.5">
        <div>
          <div className="text-sm font-medium text-text-primary">{balance === null ? '…' : balance.toLocaleString('en')}</div>
          <div className="text-xs text-text-tertiary">{t('Total credits')}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-fill-tsp px-2 py-0.5 text-xs font-medium text-text-secondary">{plan === 'pro' ? t('Pro plan') : t('Free plan')}</span>
          <Button size="sm" variant="ghost" loading={busy === 'plan'} onClick={togglePlan}>
            {plan === 'pro' ? t('Downgrade') : t('Switch to Pro')}
          </Button>
        </div>
      </div>

      <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('Buy credits')}</h3>
      <ul className="mb-4 flex flex-col gap-1.5">
        {PACKS.map((pack) => (
          <li key={pack.id} className="flex items-center justify-between rounded-control border border-border-main px-3 py-2">
            <div>
              <div className="text-sm text-text-primary">{pack.name}</div>
              <div className="text-xs text-text-tertiary">+{pack.credits.toLocaleString('en')} {t('credits')}</div>
            </div>
            <Button size="sm" variant="secondary" loading={busy === pack.id} onClick={() => void purchase(pack.id)}>
              {t('Add credits')}
            </Button>
          </li>
        ))}
      </ul>

      {error && <p className="mb-3 text-xs text-func-error">{error}</p>}

      {ledger.length > 0 && (
        <div className="mb-2">
          <h3 className="mb-1.5 text-sm font-semibold text-text-primary">{t('Recent activity')}</h3>
          <ul className="max-h-40 overflow-y-auto rounded-control border border-border-main">
            {ledger.slice(0, 8).map((entry) => (
              <li key={entry.id} className="flex items-center justify-between px-3 py-1.5 text-xs text-text-secondary">
                <span className="truncate">{entry.ref}</span>
                <span className={entry.amount >= 0 ? 'text-func-success' : 'text-func-error'}>
                  {entry.amount >= 0 ? '+' : ''}{entry.amount.toLocaleString('en')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
