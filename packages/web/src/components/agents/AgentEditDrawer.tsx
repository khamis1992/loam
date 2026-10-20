'use client';

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Button, Spinner } from '@/components/ui/Button';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import type { AgentCardAgent } from './AgentCard';

interface WorkMode {
  id: string;
  labelAr: string;
  description: string;
}

interface Service {
  id: string;
  labelAr: string;
  description: string;
  dynamic?: boolean;
}

interface AgentEditDrawerProps {
  agent: AgentCardAgent | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const LOAM_MODES = [
  { id: 'ask', labelAr: 'استكشف' },
  { id: 'research', labelAr: 'ابحث' },
  { id: 'build', labelAr: 'ابنِ' },
  { id: 'write', labelAr: 'اكتب' },
  { id: 'data', labelAr: 'حلّل' },
  { id: 'media', labelAr: 'صمّم' },
  { id: 'security', labelAr: 'افحص' },
  { id: 'automate', labelAr: 'أنجز' },
];

const EFFORT_LEVELS = [
  { id: 'max', labelAr: 'أقصى' },
  { id: 'high', labelAr: 'عالٍ' },
  { id: 'medium', labelAr: 'متوسط' },
  { id: 'low', labelAr: 'منخفض' },
];

export function AgentEditDrawer({ agent, open, onClose, onSaved }: AgentEditDrawerProps) {
  const [workModes, setWorkModes] = useState<WorkMode[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [mode, setMode] = useState('build');
  const [workMode, setWorkMode] = useState('loam');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('high');
  const [enabledServices, setEnabledServices] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setCatalogLoading(true);
    setError(null);
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/work-modes`, {
          headers: await getApiHeaders(),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { workModes?: WorkMode[]; services?: Service[] };
        if (mounted) {
          setWorkModes(data.workModes ?? []);
          setServices(data.services ?? []);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
      } finally {
        if (mounted) setCatalogLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [open]);

  useEffect(() => {
    if (agent) {
      setName(agent.name || '');
      setMode(agent.mode || 'build');
      setWorkMode(agent.workMode || 'loam');
      setModel(agent.model || '');
      setEffort((agent as unknown as { effort?: string }).effort || 'high');
    }
  }, [agent]);

  useEffect(() => {
    if (agent && services.length > 0) {
      const allowed = (agent as unknown as { allowedServices?: string[] }).allowedServices;
      if (allowed && allowed.length > 0) {
        setEnabledServices(new Set(allowed.filter((id) => services.some((s) => s.id === id))));
      } else {
        setEnabledServices(new Set(services.map((s) => s.id)));
      }
    }
  }, [agent, services]);

  const allServicesEnabled = useMemo(() => {
    return services.length > 0 && services.every((s) => enabledServices.has(s.id));
  }, [services, enabledServices]);

  const toggleService = (id: string) => {
    setEnabledServices((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    if (!agent) return;
    setSaving(true);
    setError(null);
    try {
      const allowedServices = allServicesEnabled ? [] : Array.from(enabledServices);
      const patch = {
        name: name.trim(),
        mode,
        workMode,
        effort,
        model: model.trim() || null,
        allowedServices,
      };
      const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agent.id)}`, {
        method: 'POST',
        headers: {
          ...(await getApiHeaders()),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `status ${res.status}`);
      }
      onSaved();
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  if (!open || !agent) return null;

  return (
    <div className="fixed inset-y-0 end-0 z-50 flex w-full max-w-[440px] flex-col border-s border-border-main bg-bg-menu shadow-menu">
      <div className="flex h-row items-center justify-between border-b border-border-main px-4">
        <h2 className="text-title-lg text-text-primary">{t('Edit agent')}</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {catalogLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-text-secondary">
            <Spinner className="size-5" /> {t('Loading')}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              {t('Name')}
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              {t('Mode')}
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark"
              >
                {LOAM_MODES.map((m) => (
                  <option key={m.id} value={m.id}>{m.labelAr}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              {t('Work mode')}
              <select
                value={workMode}
                onChange={(e) => setWorkMode(e.target.value)}
                className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark"
              >
                {workModes.map((m) => (
                  <option key={m.id} value={m.id}>{m.labelAr}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              {t('Model')}
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={t('Model override')}
                className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              {t('Effort')}
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
                className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark"
              >
                {EFFORT_LEVELS.map((l) => (
                  <option key={l.id} value={l.id}>{l.labelAr}</option>
                ))}
              </select>
            </label>

            <div className="flex flex-col gap-2">
              <span className="text-sm text-text-secondary">{t('Allowed services')}</span>
              <div className="grid grid-cols-1 gap-1">
                {services.map((svc) => (
                  <label
                    key={svc.id}
                    className="flex cursor-pointer items-start gap-2 rounded-control border border-border-main bg-bg-main p-2 hover:bg-fill-hover"
                  >
                    <input
                      type="checkbox"
                      checked={enabledServices.has(svc.id)}
                      onChange={() => toggleService(svc.id)}
                      className="mt-0.5 size-4 shrink-0 accent-text-primary"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-text-primary">{svc.labelAr}</p>
                      <p className="text-xs text-text-tertiary">{svc.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {error && (
              <div className="rounded-control bg-function-error-tsp px-3 py-2 text-sm text-function-error">
                {error}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border-main p-4">
        <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
          {t('Cancel')}
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={saving}
          disabled={saving || !name.trim()}
          onClick={handleSave}
        >
          {t('Save')}
        </Button>
      </div>
    </div>
  );
}
