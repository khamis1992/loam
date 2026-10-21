'use client';

import { useCallback, useEffect, useState } from 'react';
import { Puzzle, Loader2, AlertCircle, Github, Mail, Calendar, Plug } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { Section } from './SettingsDialog';

interface Connector {
  name: string;
  connected?: boolean;
  toolCount?: number;
}

interface OAuthConnector {
  id: string;
  name: string;
  configured: boolean;
  connected: boolean;
  account: string | null;
  envVars: string[];
}

const OAUTH_ICONS: Record<string, typeof Github> = { github: Github, gmail: Mail, calendar: Calendar };

function OAuthConnectorsSection() {
  const [items, setItems] = useState<OAuthConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const headers = await getApiHeaders();
      const res = await fetch(`${getApiBase()}/api/connectors`, { headers });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { connectors?: OAuthConnector[] };
      setItems(data.connectors ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const headers = await getApiHeaders();
        const res = await fetch(`${getApiBase()}/api/connectors`, { headers });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { connectors?: OAuthConnector[] };
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
      const headers = { ...(await getApiHeaders()), 'content-type': 'application/json' };
      const res = await fetch(`${getApiBase()}/api/connectors/${id}/connect`, { method: 'POST', headers });
      const data = (await res.json().catch(() => ({}))) as { authUrl?: string; error?: string };
      if (!res.ok || !data.authUrl) {
        setError(data.error ?? `connect failed (${res.status})`);
      } else {
        window.open(data.authUrl, '_blank', 'noopener');
      }
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
      const headers = { ...(await getApiHeaders()), 'content-type': 'application/json' };
      await fetch(`${getApiBase()}/api/connectors/${id}/disconnect`, { method: 'POST', headers });
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
  const [servers, setServers] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const headers = await getApiHeaders();
        const res = await fetch(`${getApiBase()}/api/mcp/status`, { headers });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { servers?: Connector[] };
        if (mounted) setServers(data.servers ?? []);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
        // eslint-disable-next-line no-console
        console.error('failed to load connectors', e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  return (
    <div className="space-y-2">
      <OAuthConnectorsSection />
      <Section title={t('MCP Servers')}>
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-text-secondary">
            <Loader2 className="size-4 animate-spin" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-start gap-1 py-4 text-function-error">
            <div className="flex items-center gap-2">
              <AlertCircle className="size-4" />
              <p className="text-sm">{t('Failed to load connectors')}</p>
            </div>
            <p className="max-w-[320px] text-xs">{error}</p>
          </div>
        ) : servers.length === 0 ? (
          <p className="py-4 text-sm text-text-tertiary">{t('No MCP servers connected.')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {servers.map((s) => (
              <li key={s.name} className="flex items-center gap-3 rounded-card border border-border-main bg-bg-menu p-3">
                <Puzzle className="size-4 text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{s.name}</p>
                  <p className="text-xs text-text-tertiary">{s.toolCount ?? 0} {t('Tools')}</p>
                </div>
                <span className={clsConnected(s.connected)}>
                  {s.connected ? t('Connected') : t('Disconnected')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function clsConnected(connected?: boolean) {
  return `shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${connected ? 'bg-function-success-tsp text-function-success' : 'bg-fill-tsp text-text-tertiary'}`;
}
