'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Smartphone } from 'lucide-react';
import { t } from '@/i18n/t';
import { Dialog } from '@/components/ui/Dialog';
import { getApiBase, getSessionToken } from '@/services/rpc';
import { desktopApis } from '@/services/desktopApis';

export function PhoneControlDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [host, setHost] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const hostname = window.location.hostname;
    setHost(['agent', 'localhost', '127.0.0.1', ''].includes(hostname) ? '' : hostname);
    setCopied(false);
    setError(null);
  }, [open]);

  const remoteUrl = async (): Promise<string> => {
    const normalized = host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!normalized || !/^[a-z0-9.-]+$/i.test(normalized)) throw new Error(t('Enter a valid Loam address'));
    const token = await getSessionToken();
    if (!token) throw new Error(t('Local access is unavailable'));
    const base = new URL(getApiBase());
    base.hostname = normalized;
    base.pathname = '/remote';
    base.search = `?t=${encodeURIComponent(token)}`;
    return base.toString();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(await remoteUrl());
      setCopied(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openRemote = async () => {
    try {
      await desktopApis.system.openExternal(await remoteUrl());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('Control from your phone')} width={520}>
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-xl bg-fill-tsp p-4">
          <Smartphone className="mt-0.5 size-5 shrink-0 text-text-secondary" />
          <div>
            <p className="text-sm font-medium text-text-primary">{t('Open Loam Remote on your phone')}</p>
            <p className="mt-1 text-[13px] leading-5 text-text-secondary">{t('Use the same local network or Tailscale. Your install token is included only in the copied link and is never shown here.')}</p>
          </div>
        </div>
        <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
          {t('Loam address')}
          <input
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="192.168.1.20 or your-tailscale-host"
            dir="ltr"
            className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
          />
        </label>
        {error && <p role="alert" className="text-xs text-func-error">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => void copy()} className="flex items-center gap-1.5 rounded-control border border-border-main px-3 py-1.5 text-sm text-text-secondary hover:bg-fill-hover">
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? t('Copied') : t('Copy remote link')}
          </button>
          <button type="button" onClick={() => void openRemote()} className="flex items-center gap-1.5 rounded-control bg-[#1a1a19] px-3 py-1.5 text-sm font-medium text-white dark:bg-white/90 dark:text-black">
            <ExternalLink className="size-4" /> {t('Open remote page')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
