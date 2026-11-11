'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  Download,
  ListTodo,
  Loader2,
  Monitor,
  MonitorOff,
  MoreHorizontal,
  Play,
  Plus,
  Settings2,
  Smartphone,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { Dialog } from '@/components/ui/Dialog';
import { CompanionCreateDialog } from '@/components/computer/CompanionCreateDialog';
import { ComputerDetailsDialog } from '@/components/computer/ComputerDetailsDialog';
import { ComputerTasksDialog } from '@/components/computer/ComputerTasksDialog';
import { CompanionDeviceViewer } from '@/components/computer/CompanionDeviceViewer';
import { CompanionCardPreview } from '@/components/computer/CompanionCardPreview';
import { ComputerMetrics } from '@/components/computer/ComputerMetrics';
import { ConnectComputerDialog } from '@/components/computer/ConnectComputerDialog';
import { PhoneControlDialog } from '@/components/computer/PhoneControlDialog';
import {
  actOnCompanionDevice,
  createCompanionDevice,
  deleteCompanionDevice,
  listCompanionDevices,
  listCompanions,
  prepareGoldenImage,
  type CompanionDevice,
  type CompanionOption,
  type CompanionProviders,
  type DeviceAction,
  type DeviceTemplate,
} from '@/services/companionsApi';

type Device = CompanionDevice;
type AgentOption = CompanionOption;
type Providers = CompanionProviders;

function stateDot(state: string): string {
  if (state === 'running') return 'bg-func-success';
  if (state === 'error') return 'bg-func-error';
  if (state === 'provisioning') return 'bg-func-warning';
  return 'bg-white/60';
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
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [tasksId, setTasksId] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);

  const [pairOpen, setPairOpen] = useState(false);
  const [pairAgent, setPairAgent] = useState('');
  const [pairTemplate, setPairTemplate] = useState('coding');
  const [pairName, setPairName] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [goldenDistro, setGoldenDistro] = useState('');
  const [goldenBusy, setGoldenBusy] = useState(false);
  const [newCompanionOpen, setNewCompanionOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await listCompanionDevices();
      setDevices(data.devices ?? []);
      setTemplates(data.templates ?? []);
      setGoldenReady(Boolean(data.goldenReady));
      setProviders({
        wsl: Boolean(data.providers?.wsl),
        hyperv: Boolean(data.providers?.hyperv),
        fake: Boolean(data.providers?.fake),
        wslDistros: data.providers?.wslDistros,
      });
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

  const loadAgents = useCallback(async () => {
    try {
      setAgents(await listCompanions());
    } catch {
      // agents unavailable: pairing dialog will show "no companions"
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadAgents();
  }, [refresh, loadAgents]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 30_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const agentName = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) map.set(a.id, a.name);
    return (id: string) => map.get(id) ?? id;
  }, [agents]);

  const settingsDevice = devices.find((device) => device.id === settingsId) ?? null;
  const tasksDevice = devices.find((device) => device.id === tasksId) ?? null;
  const viewerDevice = devices.find((device) => device.id === viewerId) ?? null;

  const act = async (id: string, action: DeviceAction) => {
    setBusyId(id);
    try {
      await actOnCompanionDevice(id, action);
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
      await deleteCompanionDevice(id);
      setSettingsId(null);
      setTasksId(null);
      setViewerId(null);
      setMenuId(null);
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
      await prepareGoldenImage(goldenDistro);
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
      const body: { agentId: string; template: string; name?: string } = { agentId: pairAgent, template: pairTemplate };
      if (pairName.trim()) body.name = pairName.trim();
      await createCompanionDevice(body);
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
  const openPair = () => {
    setPairError(null);
    setPairOpen(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-main">
      <header className="mx-auto flex h-[60px] w-full max-w-[960px] shrink-0 items-center justify-between px-6">
        <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-text-primary">{t('Computers')}</h1>
        <button
          type="button"
          onClick={openPair}
          className="flex items-center gap-1.5 rounded-[6px] border border-border-main bg-bg-menu px-3 py-1.5 text-[13px] font-medium text-text-primary shadow-sm transition-colors hover:bg-fill-hover"
        >
          <Plus className="size-3.5" /> {t('Create cloud computer')}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto w-full max-w-[960px]">
          {loading ? (
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2" aria-label={t('Loading')}>
              {[0, 1].map((item) => (
                <div key={item} className="animate-pulse overflow-hidden rounded-[10px] border border-border-main bg-bg-menu">
                  <div className="aspect-[16/9] bg-fill-tsp" />
                  <div className="flex h-12 items-center gap-4 px-4">
                    <span className="h-4 flex-1 rounded bg-fill-tsp" />
                    <span className="h-4 flex-1 rounded bg-fill-tsp" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              {error && (
                <div className="mb-4 flex items-center gap-3 rounded-card border border-func-error/20 bg-func-error/5 px-4 py-3 text-sm text-func-error" role="alert">
                  <AlertCircle className="size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{t('Failed to load computers')}</p>
                    <p className="mt-0.5 text-xs">{error}</p>
                  </div>
                  <button type="button" onClick={() => void refresh()} className="shrink-0 rounded-control border border-border-main px-3 py-1.5 text-xs text-text-primary hover:bg-fill-hover">
                    {t('Retry')}
                  </button>
                </div>
              )}
              <ul className="grid grid-cols-1 items-start gap-5 md:grid-cols-2">
                {devices.map((d) => (
                  <li key={d.id} className="relative rounded-[10px] bg-bg-menu shadow-[0_0_0_1px_var(--border-main)]">
                    <div className="relative aspect-[16/9] overflow-hidden rounded-t-[9px] bg-[radial-gradient(circle_at_50%_45%,rgba(107,48,73,0.55),transparent_42%),linear-gradient(135deg,#120b12_0%,#241018_55%,#100b0b_100%)] text-white">
                      <CompanionCardPreview deviceId={d.id} state={d.state} />
                      <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 p-4 text-[13px]">
                        <Monitor className="size-4 shrink-0 text-white/70" />
                        <p className="min-w-0 flex-1 truncate font-medium text-white/85">{d.name || d.id}</p>
                        <span className="flex shrink-0 items-center gap-1.5 text-xs text-white/70">
                          <span className={clsx('size-1.5 rounded-full', stateDot(d.state))} />
                          {d.state}
                        </span>
                        <span className="h-4 w-px bg-white/15" />
                        <button
                          type="button"
                          aria-label={t('More')}
                          onClick={() => setMenuId(menuId === d.id ? null : d.id)}
                          className="rounded-[4px] p-0.5 text-white/65 transition-colors hover:bg-white/10 hover:text-white"
                        >
                          <MoreHorizontal className="size-4" />
                        </button>
                      </div>
                      {menuId === d.id && (
                        <div className="absolute end-3 top-12 z-20 w-64 rounded-card border border-border-main bg-bg-menu p-1.5 text-text-primary shadow-layer">
                          <button type="button" onClick={() => { setTasksId(d.id); setMenuId(null); }} className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-start text-xs hover:bg-fill-hover">
                            <Plus className="size-3.5" /> {t('New task')}
                          </button>
                          <p className="border-t border-border-main px-3 py-2 text-[11px] text-text-tertiary">{d.provider} / {d.template} / {agentName(d.agentId)}</p>
                          <ComputerMetrics deviceId={d.id} />
                        </div>
                      )}
                      <div className="absolute inset-0 flex items-center justify-center">
                        {busyId === d.id ? (
                          <span className="flex size-12 items-center justify-center rounded-full bg-white/20 text-white/75 backdrop-blur-sm"><Loader2 className="size-6 animate-spin" /></span>
                        ) : d.state === 'running' ? (
                          <button type="button" onClick={() => setViewerId(d.id)} className="flex items-center gap-2 rounded-[8px] bg-black/45 px-3 py-2 text-sm font-medium text-white opacity-90 backdrop-blur-sm transition-colors hover:bg-black/60">
                            <Monitor className="size-4" /> {t('Connect')}
                          </button>
                        ) : d.state === 'stopped' || d.state === 'error' || d.state === 'suspended' ? (
                          <button type="button" onClick={() => void act(d.id, d.state === 'suspended' ? 'resume' : 'start')} className="flex items-center gap-2 rounded-[8px] bg-white/20 px-3 py-2 text-sm font-medium text-white/85 backdrop-blur-sm hover:bg-white/25">
                            <Play className="size-4" /> {d.state === 'suspended' ? t('Resume') : t('Start')}
                          </button>
                        ) : (
                          <span className="flex size-12 items-center justify-center rounded-full bg-white/20 text-white/75 backdrop-blur-sm"><MonitorOff className="size-6" /></span>
                        )}
                      </div>
                      {d.lastError && (
                        <p className="absolute inset-x-0 bottom-12 truncate px-4 text-center text-[10px] text-red-200" title={d.lastError}>
                          {d.lastError}
                        </p>
                      )}
                      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 p-4 text-[13px]">
                        <span className="font-medium text-white/90">{d.environment}</span>
                        <span className="truncate text-xs text-white/55" title={`${d.provider} / ${d.template}`}>
                          {agentName(d.agentId)}
                        </span>
                      </div>
                    </div>
                    <div className="flex h-12 items-center divide-x divide-border-main">
                      <ActionButton label={t('Settings')} onClick={() => setSettingsId(d.id)} icon={<Settings2 className="size-4" />} />
                      <ActionButton label={t('Tasks')} onClick={() => setTasksId(d.id)} icon={<ListTodo className="size-4" />} />
                    </div>
                  </li>
                ))}
                <li onClick={openPair} className="flex min-h-[280px] cursor-pointer items-center justify-center rounded-[10px] border border-dashed border-black/10 bg-fill-tsp transition-colors hover:bg-fill-hover md:min-h-[312px] dark:border-white/15">
                  <div className="flex flex-col items-center gap-4 p-6 text-center">
                    <Monitor className="size-5 text-text-tertiary" />
                    <p className="text-[13px] text-text-secondary">{t('Create cloud computer')}</p>
                    <button
                      type="button"
                      onClick={openPair}
                      className="flex items-center gap-2 rounded-[6px] bg-[#1a1a19] px-3.5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-black dark:bg-white/90 dark:text-black dark:hover:bg-white"
                    >
                      <Monitor className="size-4" /> {t('Create cloud computer')}
                    </button>
                  </div>
                </li>
              </ul>
            </>
          )}
        </div>
      </div>

      <div className="shrink-0 px-6 pb-4">
        <div className="mx-auto flex w-full max-w-[960px] flex-wrap items-center justify-between gap-3 rounded-card border border-border-main bg-bg-menu px-4 py-3.5 shadow-sm">
          <p className="text-[13px] font-medium text-text-primary">{t('Connect your devices')}</p>
          <div className="ms-auto flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => setConnectOpen(true)}
              className="flex items-center gap-2 rounded-[6px] border border-border-main bg-bg-menu px-3 py-1.5 text-[13px] text-text-primary transition-colors hover:bg-fill-hover"
            >
              <Monitor className="size-3.5" /> {t('Connect new computer')}
            </button>
            <button
              type="button"
              onClick={() => setPhoneOpen(true)}
              className="flex items-center gap-2 rounded-[6px] border border-border-main bg-bg-menu px-3 py-1.5 text-[13px] text-text-primary transition-colors hover:bg-fill-hover"
            >
              <Smartphone className="size-3.5" /> {t('Control from your phone')}
            </button>
          </div>
        </div>
      </div>

      <ConnectComputerDialog
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        onOpenDevices={() => {
          setConnectOpen(false);
          router.push('/app/devices');
        }}
        onNewCompanion={() => {
          setConnectOpen(false);
          setNewCompanionOpen(true);
        }}
      />
      <PhoneControlDialog open={phoneOpen} onClose={() => setPhoneOpen(false)} />

      {settingsDevice && (
        <ComputerDetailsDialog
          device={settingsDevice}
          open={Boolean(settingsId)}
          onClose={() => setSettingsId(null)}
          onAction={act}
          onDelete={removeDevice}
          busy={busyId === settingsDevice.id}
        />
      )}
      {tasksDevice && (
        <ComputerTasksDialog
          device={tasksDevice}
          open={Boolean(tasksId)}
          onClose={() => setTasksId(null)}
          onOpenTask={(taskId) => {
            setTasksId(null);
            router.push(`/app/${taskId}`);
          }}
        />
      )}
      {viewerDevice && (
        <CompanionDeviceViewer
          device={viewerDevice}
          open={Boolean(viewerId)}
          onClose={() => setViewerId(null)}
        />
      )}

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
            {agents.length === 0 && (
              <button
                type="button"
                onClick={() => setNewCompanionOpen(true)}
                className="flex items-center gap-1 self-start rounded-control bg-fill-hover px-2.5 py-1.5 text-xs font-medium text-text-primary"
              >
                <Plus className="size-3.5" /> {t('Create companion')}
              </button>
            )}
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

      <CompanionCreateDialog
        open={newCompanionOpen}
        onClose={() => setNewCompanionOpen(false)}
        onCreated={() => void loadAgents()}
      />
    </div>
  );
}

function ActionButton({ label, icon, onClick, disabled }: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-full flex-1 items-center justify-center gap-2 px-3 text-[13px] font-medium text-text-primary transition-colors hover:bg-fill-hover disabled:opacity-50"
    >
      {icon} {label}
    </button>
  );
}
