'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { Section, Row } from './SettingsDialog';
import {
  createBridgeSkill, listBridges, setBridgeEnabled,
  type BridgeInfo, type BridgeStatus,
} from '@/services/bridgesApi';

const CHIP: Record<BridgeStatus, { label: string; cls: string }> = {
  ready: { label: 'Ready', cls: 'bg-function-success-tsp text-function-success' },
  disabled: { label: 'Disabled', cls: 'bg-fill-tsp text-text-tertiary' },
  missing: { label: 'Not installed', cls: 'bg-fill-tsp text-text-tertiary' },
  error: { label: 'Error', cls: 'bg-function-error-tsp text-function-error' },
};

/** Settings pane for the app bridges: status, a per-run switch and skill generation. */
export function BridgesPane() {
  const [bridges, setBridges] = useState<BridgeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBridges((await listBridges()).bridges);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (b: BridgeInfo) => {
    try {
      const { bridge } = await setBridgeEnabled(b.id, !b.enabled);
      setBridges((list) => (list ?? []).map((x) => (x.id === bridge.id ? bridge : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const makeSkill = async (b: BridgeInfo) => {
    try {
      await createBridgeSkill(b.id);
      setSaved(b.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Section title={t('App bridges')}>
      <p className="pb-2 text-xs text-text-secondary">
        {t('Let the agent drive installed apps from the command line instead of clicking. Every bridge stays off until you enable it.')}{' '}
        {t('The switch lasts until the app restarts.')}
      </p>
      {error && <p className="py-2 text-xs text-function-error">{error}</p>}
      {bridges === null && !error ? (
        <div className="flex items-center gap-2 py-4 text-text-secondary">
          <Loader2 className="size-4 animate-spin" /> {t('Loading')}
        </div>
      ) : (
        (bridges ?? []).map((b) => (
          <Row key={b.id} label={b.name} description={b.detail ?? b.description}>
            <span className="flex items-center gap-2">
              <span className={clsx('rounded-full px-2 py-0.5 text-[10px] font-medium', CHIP[b.status].cls)}>{t(CHIP[b.status].label)}</span>
              <button
                type="button"
                disabled={b.status === 'missing'}
                onClick={() => void toggle(b)}
                className="rounded-full bg-fill-tsp px-2 py-0.5 text-[10px] text-text-secondary disabled:opacity-50"
              >
                {b.enabled ? t('Disable') : t('Enable')}
              </button>
              <button
                type="button"
                onClick={() => void makeSkill(b)}
                className="rounded-full bg-fill-tsp px-2 py-0.5 text-[10px] text-text-secondary"
              >
                {saved === b.id ? t('Skill saved') : t('Create skill')}
              </button>
            </span>
          </Row>
        ))
      )}
    </Section>
  );
}
