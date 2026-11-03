'use client';

/**
 * Unified marketplace › Bridges & connectors tab. Mounts the exact same API
 * surface the Settings panes drive — bridgesApi (GET /api/bridges, PUT
 * /api/bridges/:id, POST /api/bridges/:id/skill) and connectorsApi (GET
 * /api/connectors, POST /api/connectors/:id/connect|disconnect) — so this is
 * a second window on one backend, never a parallel one.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, Puzzle, ToggleLeft, ToggleRight } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import {
  createBridgeSkill, listBridges, setBridgeEnabled,
  type BridgeInfo, type BridgeStatus,
} from '@/services/bridgesApi';
import {
  listConnectors, connectConnector, disconnectConnector, type OAuthConnector,
} from '@/services/connectorsApi';
import { bi } from './labels';

const STATUS_CHIP: Record<BridgeStatus, { label: string; cls: string }> = {
  ready: { label: 'Ready', cls: 'bg-function-success-tsp text-function-success' },
  disabled: { label: 'Disabled', cls: 'bg-fill-tsp text-text-tertiary' },
  missing: { label: 'Not installed', cls: 'bg-fill-tsp text-text-tertiary' },
  error: { label: 'Error', cls: 'bg-function-error-tsp text-function-error' },
};

function SectionHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="border-b border-border-main pb-2">
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      <p className="mt-1 text-[12.5px] text-text-tertiary">{hint}</p>
    </div>
  );
}

export function BridgesMarket() {
  const [bridges, setBridges] = useState<BridgeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [skillMade, setSkillMade] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBridges((await listBridges()).bridges);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (bridge: BridgeInfo) => {
    setBusyId(bridge.id);
    try {
      const { bridge: updated } = await setBridgeEnabled(bridge.id, !bridge.enabled);
      setBridges((list) => (list ?? []).map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const makeSkill = async (bridge: BridgeInfo) => {
    setBusyId(bridge.id);
    try {
      await createBridgeSkill(bridge.id);
      setSkillMade(bridge.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-label={t('App bridges')} className="mt-2">
      <SectionHeading
        title={t('App bridges')}
        hint={t('Let the agent drive installed apps from the command line instead of clicking. Every bridge stays off until you enable it.')}
      />
      {error && (
        <div className="mt-3 flex items-center gap-2 text-sm text-func-error" data-testid="bridges-error">
          <AlertCircle className="size-4 shrink-0" /> {error}
        </div>
      )}
      {bridges === null ? (
        <div className="flex items-center justify-center gap-2 py-10 text-text-secondary" data-testid="bridges-loading">
          <Loader2 className="size-4 animate-spin" /> {t('Loading')}
        </div>
      ) : bridges.length === 0 ? (
        <p className="py-8 text-sm text-text-tertiary">{t('No bridges found.')}</p>
      ) : (
        <ul className="divide-y divide-border-main" data-testid="bridges-list">
          {bridges.map((bridge) => {
            const chip = STATUS_CHIP[bridge.status] ?? STATUS_CHIP.disabled;
            const busy = busyId === bridge.id;
            return (
              <li key={bridge.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-medium text-text-primary">{bridge.name}</span>
                    <span className={clsx('rounded-[7px] px-2 py-0.5 text-[11px] font-semibold', chip.cls)}>{t(chip.label)}</span>
                  </div>
                  <p className="mt-0.5 text-[12.5px] text-text-tertiary">{bridge.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void makeSkill(bridge)}
                    disabled={busy}
                    className="rounded-[9px] border border-border-main px-2.5 py-1.5 text-[12.5px] font-medium text-text-secondary hover:bg-fill-hover disabled:opacity-60"
                  >
                    {skillMade === bridge.id ? t('Skill created') : t('Create skill')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggle(bridge)}
                    disabled={busy}
                    aria-pressed={bridge.enabled}
                    aria-label={`${bridge.enabled ? t('Disable') : t('Enable')} ${bridge.name}`}
                    data-testid={`bridge-toggle-${bridge.id}`}
                    className={clsx('flex items-center gap-1 rounded-[9px] px-2 py-1.5 text-[12.5px] font-medium', bridge.enabled ? 'text-function-success' : 'text-text-tertiary', 'hover:bg-fill-hover disabled:opacity-60')}
                  >
                    {bridge.enabled ? <ToggleRight className="size-4" /> : <ToggleLeft className="size-4" />}
                    {bridge.enabled ? t('On') : t('Off')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function ConnectorsMarket() {
  const [items, setItems] = useState<OAuthConnector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems((await listConnectors()).connectors ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const connect = async (id: string) => {
    setBusyId(id);
    try {
      const data = await connectConnector(id);
      if (data.authUrl) window.open(data.authUrl, '_blank', 'noopener');
      else if (data.error) throw new Error(data.error);
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
    <section aria-label={t('Connectors')} className="mt-8">
      <SectionHeading
        title={t('Connectors')}
        hint={t('Link the accounts the agent may use. Disconnecting revokes the stored tokens.')}
      />
      {error && (
        <div className="mt-3 flex items-center gap-2 text-sm text-func-error" data-testid="connectors-error">
          <AlertCircle className="size-4 shrink-0" /> {error}
        </div>
      )}
      {items === null ? (
        <div className="flex items-center justify-center gap-2 py-10 text-text-secondary" data-testid="connectors-loading">
          <Loader2 className="size-4 animate-spin" /> {t('Loading')}
        </div>
      ) : items.length === 0 ? (
        <div className="flex items-center gap-2 py-8 text-sm text-text-tertiary">
          <Puzzle className="size-4" /> {t('No connectors configured.')}
        </div>
      ) : (
        <ul className="divide-y divide-border-main" data-testid="connectors-list">
          {items.map((connector) => {
            const busy = busyId === connector.id;
            return (
              <li key={connector.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-medium text-text-primary">{connector.name}</span>
                    {connector.connected ? (
                      <span className="rounded-[7px] bg-function-success-tsp px-2 py-0.5 text-[11px] font-semibold text-function-success">
                        {t('Connected')}
                      </span>
                    ) : connector.configured ? (
                      <span className="rounded-[7px] bg-fill-tsp px-2 py-0.5 text-[11px] font-semibold text-text-tertiary">
                        {t('Not connected')}
                      </span>
                    ) : (
                      <span className="rounded-[7px] bg-fill-tsp px-2 py-0.5 text-[11px] font-semibold text-text-tertiary">
                        {t('Not configured')}
                      </span>
                    )}
                  </div>
                  {connector.account && <p className="mt-0.5 text-[12.5px] text-text-tertiary">{connector.account}</p>}
                </div>
                {connector.configured ? (
                  connector.connected ? (
                    <button
                      type="button"
                      onClick={() => void disconnect(connector.id)}
                      disabled={busy}
                      data-testid={`connector-disconnect-${connector.id}`}
                      className="shrink-0 rounded-[9px] border border-border-main px-3 py-1.5 text-[12.5px] font-medium text-text-secondary hover:bg-fill-hover disabled:opacity-60"
                    >
                      {busy ? <Loader2 className="size-3.5 animate-spin" /> : t('Disconnect')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void connect(connector.id)}
                      disabled={busy}
                      data-testid={`connector-connect-${connector.id}`}
                      className="shrink-0 rounded-[9px] bg-text-primary px-3 py-1.5 text-[12.5px] font-medium text-text-onblack disabled:opacity-60"
                    >
                      {busy ? <Loader2 className="size-3.5 animate-spin" /> : t('Connect')}
                    </button>
                  )
                ) : (
                  <span className="shrink-0 text-[12px] text-text-tertiary">{t('Add its keys to connect.')}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The combined Bridges & connectors tab content. */
export function IntegrationsMarket() {
  return (
    <div>
      <BridgesMarket />
      <ConnectorsMarket />
    </div>
  );
}
