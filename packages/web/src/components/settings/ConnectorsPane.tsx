'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertCircle, Github, Mail, Calendar, Plug } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { listConnectors, connectConnector, disconnectConnector, type OAuthConnector } from '@/services/connectorsApi';
import { Section } from './SettingsDialog';
import { McpServerManager } from './McpServerManager';
import { ServicePackGallery } from './ServicePackGallery';

const OAUTH_ICONS: Record<string, typeof Github> = { github: Github, gmail: Mail, calendar: Calendar };

function OAuthConnectorsSection() {
  const [items, setItems] = useState<OAuthConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listConnectors();
      setItems(data.connectors ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const data = await listConnectors();
        if (mounted) setItems(data.connectors ?? []);
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const connect = async (id: string) => {
    setBusyId(id);
    try {
      const data = await connectConnector(id);
      if (!data.authUrl) throw new Error(data.error ?? 'connect failed');
      window.open(data.authUrl, '_blank', 'noopener');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
      void refresh();
    }
  };

  const disconnect = async (id: string) => {
    setBusyId(id);
    try {
      await disconnectConnector(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
      void refresh();
    }
  };

  return (
    <Section title={t('Connectors')}>
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-text-secondary">
          <Loader2 className="size-4 animate-spin" /> {t('Loading')}
        </div>
      ) : (
        <ul className="flex flex-col gap-2 py-1">
          {items.map((c) => {
            const Icon = OAUTH_ICONS[c.id] ?? Plug;
            return (
              <li key={c.id} className="flex items-center gap-3 rounded-card border border-border-main bg-bg-menu p-3">
                <Icon className="size-4 text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{c.name}</p>
                  {!c.configured ? (
                    <p className="text-xs text-text-tertiary">
                      {t('Not configured')} — {t('Set these environment variables on the Loam server:')}{' '}
                      <code className="text-[11px]">{c.envVars.join(', ')}</code>
                    </p>
                  ) : c.connected ? (
                    <p className="text-xs text-text-tertiary">{t('Connected as {account}', { account: c.account ?? c.name })}</p>
                  ) : (
                    <p className="text-xs text-text-tertiary">{t('Sign in opens in a new browser tab.')}</p>
                  )}
                </div>
                <span className={clsx('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium', c.connected ? 'bg-function-success-tsp text-function-success' : 'bg-fill-tsp text-text-tertiary')}>
                  {!c.configured ? t('Not configured') : c.connected ? t('Connected') : t('Disconnected')}
                </span>
                {c.configured && (
                  <button
                    type="button"
                    disabled={busyId === c.id}
                    onClick={() => (c.connected ? void disconnect(c.id) : void connect(c.id))}
                    className="shrink-0 rounded-control border border-border-main px-3 py-1 text-xs text-text-primary hover:bg-fill-hover disabled:opacity-50"
                  >
                    {c.connected ? t('Disconnect') : t('Connect')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <div className="flex items-center gap-2 pt-2 text-xs text-function-error">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}
    </Section>
  );
}

export function ConnectorsPane() {
  return (
    <div className="space-y-2">
      <OAuthConnectorsSection />
      <McpServerManager />
      <ServicePackGallery />
    </div>
  );
}
