'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Monitor, Play, Pause, Power, Trash2, Plus, X, AlertCircle, Download } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { Dialog } from '@/components/ui/Dialog';

interface Device {
  id: string;
  agentId: string;
  name: string;
  environment: 'linux' | 'windows';
  provider: 'wsl' | 'hyperv' | 'fake';
  template: string;
  state: string;
  lastError?: string;
}

interface DeviceTemplate {
  id: string;
  labelAr: string;
  description: string;
  environment: 'linux' | 'windows';
}

interface AgentOption { id: string; name: string; }

interface Providers {
  wsl: boolean;
  hyperv: boolean;
  fake: boolean;
  wslDistros?: string[];
}

function stateBadge(state: string): string {
  if (state === 'running') return 'bg-fill-tsp text-func-success';
  if (state === 'error') return 'bg-fill-tsp text-func-error';
  if (state === 'provisioning') return 'bg-fill-tsp text-func-warning';
  return 'bg-fill-tsp text-text-tertiary';
}

export default function ComputersPage() {
  const router = useRouter();
  const [devices, setDevices] = useState<Device[]>([]);
  const [templates, setTemplates] = useState<DeviceTemplate[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [goldenReady, setGoldenReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [pairOpen, setPairOpen] = useState(false);
  const [pairAgent, setPairAgent] = useState('');
  const [pairTemplate, setPairTemplate] = useState('coding');
  const [pairName, setPairName] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [goldenDistro, setGoldenDistro] = useState('');
  const [goldenBusy, setGoldenBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/companion-devices`, { headers: await getApiHeaders() });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as {
        devices?: Device[]; templates?: DeviceTemplate[]; goldenReady?: boolean;
        wsl?: boolean; hyperv?: boolean; fake?: boolean; wslDistros?: string[];
      };
      setDevices(data.devices ?? []);
      setTemplates(data.templates ?? []);
      setGoldenReady(Boolean(data.goldenReady));
      setProviders({ wsl: Boolean(data.wsl), hyperv: Boolean(data.hyperv), fake: Boolean(data.fake), wslDistros: data.wslDistros });
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // eslint-disable-next-line no-console
      console.error('failed to load computers', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/agents`, { headers: await getApiHeaders() });
        if (!res.ok) return;
        const data = (await res.json()) as { agents?: Array<{ id: string; name?: string }> };
        setAgents((data.agents ?? []).map((a) => ({ id: a.id, name: a.name || a.id })));
      } catch {
        // agents unavailable: pairing dialog will show "no companions"
      }
    })();
  }, [refresh]);

  const agentName = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) map.set(a.id, a.name);
    return (id: string) => map.get(id) ?? id;
  }, [agents]);

  const act = async (id: string, action: 'start' | 'stop' | 'suspend' | 'resume') => {
    setBusyId(id);
    try {
      const res = await fetch(`${getApiBase()}/api/companion-devices/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        headers: await getApiHeaders(),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `status ${res.status}`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const removeDevice = async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch(`${getApiBase()}/api/companion-devices/${encodeURIComponent(id)}?confirm=true`, {
        method: 'DELETE',
        headers: await getApiHeaders(),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `status ${res.status}`);
      }
      setConfirmDelete(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const prepareGolden = async () => {
    setGoldenBusy(true);
    setPairError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/companion-devices/golden`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await getApiHeaders()) },
        body: JSON.stringify({ fromDistro: goldenDistro }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? `status ${res.status}`);
      await refresh();
    } catch (e) {
      setPairError(e instanceof Error ? e.message : String(e));
    } finally {
      setGoldenBusy(false);
    }
  };

  const pair = async () => {
    setPairBusy(true);
    setPairError(null);
    try {
      const body: Record<string, unknown> = { agentId: pairAgent, template: pairTemplate };
      if (pairName.trim()) body.name = pairName.trim();
      const res = await fetch(`${getApiBase()}/api/companion-devices`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await getApiHeaders()) },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { device?: Device; error?: string };
      if (!res.ok || !data.device) throw new Error(data.error ?? `status ${res.status}`);
      setPairOpen(false);
      setPairName('');
      await refresh();
    } catch (e) {
      setPairError(e instanceof Error ? e.message : String(e));
    } finally {
      setPairBusy(false);
    }
  };

  const needsGolden = providers?.wsl === true && !goldenReady;

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg-main">
      <div className="flex h-row items-center gap-3 border-b border-border-main px-4">
        <button
          type="button"
          onClick={() => router.push('/app')}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
        >
          <ArrowLeft className="size-4" />
        </button>
        <h1 className="text-title-lg text-text-primary">{t('Computers')}</h1>
        <button
          type="button"
          onClick={() => { setPairError(null); setPairOpen(true); }}
          className="ms-auto flex items-center gap-1 rounded-control bg-fill-hover px-3 py-1.5 text-sm font-medium text-text-primary"
        >
          <Plus className="size-4" /> {t('New computer')}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : error && devices.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-func-error">
            <AlertCircle className="size-6" />
            <p className="text-sm">{t('Failed to load computers')}</p>
            <p className="max-w-[320px] text-center text-xs">{error}</p>
          </div>
        ) : devices.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary">
            <Monitor className="size-8" />
            <p className="text-sm">{t('No computers connected.')}</p>
            <button
              type="button"
              onClick={() => { setPairError(null); setPairOpen(true); }}
              className="flex items-center gap-1 rounded-control bg-fill-hover px-3 py-1.5 text-sm font-medium text-text-primary"
            >
              <Plus className="size-4" /> {t('Pair a new computer')}
            </button>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {error && <li className="col-span-full text-xs text-func-error">{error}</li>}
            {devices.map((d) => (
              <li key={d.id} className="rounded-card border border-border-main bg-bg-menu p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <Monitor className="size-4 shrink-0 text-text-tertiary" />
                  <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{d.name || d.id}</p>
                  <span className={clsx('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium', stateBadge(d.state))}>
                    {d.state}
                  </span>
                </div>
                <p className="mb-2 text-xs text-text-tertiary">
                  {d.provider} / {d.environment} / {d.template} - {t('Companion')}: {agentName(d.agentId)}
                </p>
                {d.lastError && <p className="mb-2 text-[11px] text-func-error">{d.lastError}</p>}
                <div className="flex items-center gap-1">
                  {d.state === 'running' && (
                    <>
                      <ActionButton label={t('Suspend')} disabled={busyId === d.id} onClick={() => void act(d.id, 'suspend')} icon={<Pause className="size-3.5" />} />
                      <ActionButton label={t('Stop')} disabled={busyId === d.id} onClick={() => void act(d.id, 'stop')} icon={<Power className="size-3.5" />} />
                    </>
                  )}
                  {(d.state === 'stopped' || d.state === 'error') && (
                    <ActionButton label={t('Start')} disabled={busyId === d.id} onClick={() => void act(d.id, 'start')} icon={<Play className="size-3.5" />} />
                  )}
                  {d.state === 'suspended' && (
                    <ActionButton label={t('Resume')} disabled={busyId === d.id} onClick={() => void act(d.id, 'resume')} icon={<Play className="size-3.5" />} />
                  )}
                  <span className="flex-1" />
                  {confirmDelete === d.id ? (
                    <button
                      type="button"
                      disabled={busyId === d.id}
                      onClick={() => void removeDevice(d.id)}
                      className="rounded-control px-1.5 py-1 text-[11px] font-medium text-func-error hover:bg-fill-hover"
                    >
                      {t('Confirm delete')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label={t('Delete')}
                      onClick={() => setConfirmDelete(d.id)}
                      className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover hover:text-func-error"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={pairOpen} onClose={() => setPairOpen(false)} title={t('Pair a new computer')}>
        <div className="flex flex-col gap-3">
          {needsGolden && (
            <div className="rounded-card bg-fill-tsp p-3">
              <p className="mb-2 text-xs text-text-secondary">{t('A base image must be prepared before cloning companion computers.')}</p>
              <div className="flex items-center gap-2">
                <select
                  value={goldenDistro}
                  onChange={(e) => setGoldenDistro(e.target.value)}
                  className="min-w-0 flex-1 rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-xs text-text-primary"
                >
                  <option value="">{t('Choose an installed WSL distro')}</option>
                  {(providers?.wslDistros ?? []).map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!goldenDistro || goldenBusy}
                  onClick={() => void prepareGolden()}
                  className="flex items-center gap-1 rounded-control bg-fill-hover px-2.5 py-1.5 text-xs font-medium text-text-primary disabled:opacity-50"
                >
                  {goldenBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} {t('Prepare base image')}
                </button>
              </div>
            </div>
          )}
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t('Companion')}
            <select
              value={pairAgent}
              onChange={(e) => setPairAgent(e.target.value)}
              className="rounded-control border border-border-main bg-bg-main px-2 py-2 text-sm text-text-primary"
            >
              <option value="">{agents.length === 0 ? t('No companions yet - create one first') : t('Choose a companion')}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t('Template')}
            <select
              value={pairTemplate}
              onChange={(e) => setPairTemplate(e.target.value)}
              className="rounded-control border border-border-main bg-bg-main px-2 py-2 text-sm text-text-primary"
            >
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>{tpl.labelAr || tpl.id} - {tpl.id}</option>
              ))}
            </select>
          </label>
          <input
            type="text"
            value={pairName}
            onChange={(e) => setPairName(e.target.value)}
            placeholder={t('Computer name (optional)')}
            className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
          />
          {pairError && <p className="text-xs text-func-error">{pairError}</p>}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setPairOpen(false)}
              className="flex items-center gap-1 rounded-control px-3 py-1.5 text-sm text-text-secondary hover:bg-fill-hover"
            >
              <X className="size-4" /> {t('Cancel')}
            </button>
            <button
              type="button"
              disabled={!pairAgent || pairBusy || needsGolden}
              onClick={() => void pair()}
              className="flex items-center gap-1 rounded-control bg-fill-hover px-3 py-1.5 text-sm font-medium text-text-primary disabled:opacity-50"
            >
              {pairBusy && <Loader2 className="size-4 animate-spin" />} {t('Pair')}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function ActionButton({ label, icon, onClick, disabled }: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-1 rounded-control px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-fill-hover disabled:opacity-50"
    >
      {icon} {label}
    </button>
  );
}
