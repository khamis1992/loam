'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, PackagePlus } from 'lucide-react';
import { t } from '@/i18n/t';
import { Button } from '@/components/ui/Button';
import { Section } from './SettingsDialog';
import { installServicePack, listServicePacks, type ServicePack } from '@/services/servicePacksApi';

const inputClass = 'rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark placeholder:text-text-tertiary';

export function ServicePackGallery() {
  const [packs, setPacks] = useState<ServicePack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('slack');
  const [name, setName] = useState('slack-work');
  const [transport, setTransport] = useState<'stdio' | 'http'>('http');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [accountName, setAccountName] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await listServicePacks();
      setPacks(data.packs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const install = async () => {
    setSaving(true);
    setError(null);
    try {
      await installServicePack(selectedId, name.trim(), {
        transport,
        ...(transport === 'http' ? { url: url.trim() } : { command: command.trim() }),
        ...(accountName.trim() ? { accountName: accountName.trim() } : {}),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title={t('Service packs')}>
      <div className="mb-3 flex flex-col gap-2 rounded-card border border-border-main bg-bg-main p-3">
        <p className="text-xs text-text-tertiary">{t('Install a provider to enable its services. Nothing is downloaded or connected automatically.')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <select className={inputClass} value={selectedId} onChange={(e) => { setSelectedId(e.target.value); setName(`${e.target.value}-work`); }} aria-label={t('Service pack')}>
            {packs.map((pack) => <option key={pack.id} value={pack.id}>{pack.title}</option>)}
          </select>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Server name')} />
          <select className={inputClass} value={transport} onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')} aria-label={t('Transport')}>
            <option value="http">HTTP/SSE</option>
            <option value="stdio">stdio</option>
          </select>
          <input className={inputClass} value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder={t('Account name')} />
        </div>
        {transport === 'http' ? (
          <input className={inputClass} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://provider.example/mcp" />
        ) : (
          <input className={inputClass} value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t('Command')} />
        )}
        <Button type="button" variant="secondary" size="sm" loading={saving} disabled={!name.trim() || (transport === 'http' ? !url.trim() : !command.trim())} onClick={() => void install()}>
          <PackagePlus className="size-4" /> {t('Install service pack')}
        </Button>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-text-secondary"><Loader2 className="size-4 animate-spin" /> {t('Loading')}</div>
      ) : (
        <ul className="flex max-h-[480px] flex-col gap-2 overflow-y-auto">
          {packs.map((pack) => (
            <li key={pack.id} className="rounded-card border border-border-main bg-bg-menu p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{pack.title}</p>
                  <p className="text-xs text-text-tertiary">{pack.description}</p>
                  <p className="mt-1 text-[11px] text-text-tertiary">{pack.category} · {pack.capabilities.length} {t('capabilities')}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${pack.installed.length > 0 ? 'bg-function-success-tsp text-function-success' : 'bg-fill-tsp text-text-tertiary'}`}>
                  {pack.installed.length > 0 ? t('Installed') : t('Not configured')}
                </span>
              </div>
              {pack.installed.length > 0 && (
                <p className="mt-1 text-[11px] text-text-tertiary">{pack.installed.map((item) => `${item.name} (${item.runtime.toolCount})`).join(', ')}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <div className="flex items-center gap-2 pt-2 text-xs text-function-error"><AlertCircle className="size-3.5" /> {error}</div>}
    </Section>
  );
}
