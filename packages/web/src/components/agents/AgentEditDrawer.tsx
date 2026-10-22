'use client';

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Button, Spinner } from '@/components/ui/Button';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { agentLabel } from './agentLabels';
import type { AgentCardAgent } from './AgentCard';
import { InstructionHistoryList, recordInstructionEdit } from './InstructionHistory';

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

interface Skill {
  name: string;
  description?: string;
}

interface Connector {
  name: string;
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

const CUSTOM_MODEL_VALUE = '__custom__';
const DEFAULT_MODEL_VALUE = '';

export function AgentEditDrawer({ agent, open, onClose, onSaved }: AgentEditDrawerProps) {
  const [workModes, setWorkModes] = useState<WorkMode[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [configuredModel, setConfiguredModel] = useState<string>('');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedInstructions, setSavedInstructions] = useState('');

  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🤖');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [mode, setMode] = useState('build');
  const [workMode, setWorkMode] = useState('loam');
  const [model, setModel] = useState(DEFAULT_MODEL_VALUE);
  const [customModel, setCustomModel] = useState('');
  const [effort, setEffort] = useState('high');
  const [enabledServices, setEnabledServices] = useState<Set<string>>(new Set());
  const [enabledSkills, setEnabledSkills] = useState<Set<string>>(new Set());
  const [enabledConnectors, setEnabledConnectors] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setCatalogLoading(true);
    setError(null);
    let mounted = true;
    (async () => {
      try {
        const headers = await getApiHeaders();
        const [workModesRes, skillsRes, mcpRes, configRes, tagsRes] = await Promise.all([
          fetch(`${getApiBase()}/api/work-modes`, { headers }),
          fetch(`${getApiBase()}/api/skills`, { headers }),
          fetch(`${getApiBase()}/api/mcp/status`, { headers }),
          fetch(`${getApiBase()}/api/config`, { headers }),
          fetch(`${getApiBase()}/api/tags`, { headers }).catch(() => null),
        ]);
        if (!workModesRes.ok) throw new Error(`work-modes ${workModesRes.status}`);
        if (!skillsRes.ok) throw new Error(`skills ${skillsRes.status}`);
        if (!mcpRes.ok) throw new Error(`mcp ${mcpRes.status}`);
        if (!configRes.ok) throw new Error(`config ${configRes.status}`);
        const workModesData = (await workModesRes.json()) as { workModes?: WorkMode[]; services?: Service[] };
        const skillsData = (await skillsRes.json()) as { skills?: Skill[] };
        const mcpData = (await mcpRes.json()) as { servers?: Connector[] };
        const configData = (await configRes.json()) as { defaultModel?: string; model?: string };
        const tagsData = tagsRes && tagsRes.ok ? ((await tagsRes.json()) as { models?: Array<{ name?: string }> }) : { models: [] };
        if (!mounted) return;
        const serviceList = workModesData.services ?? [];
        setWorkModes(workModesData.workModes ?? []);
        setServices(serviceList);
        setSkills(skillsData.skills ?? []);
        setConnectors(mcpData.servers ?? []);
        const cfgModel = configData.model || configData.defaultModel || '';
        setConfiguredModel(cfgModel);
        const tagNames = (tagsData.models ?? [])
          .map((m) => m.name)
          .filter((n): n is string => Boolean(n) && n !== cfgModel);
        setModels([...(cfgModel ? [cfgModel] : []), ...tagNames]);
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
      setEmoji(agent.emoji || '🤖');
      setDescription(agent.description || '');
      const existingInstructions = (agent as unknown as { instructions?: string }).instructions || '';
      setInstructions(existingInstructions);
      setSavedInstructions(existingInstructions);
      setMode(agent.mode || 'build');
      setWorkMode(agent.workMode || 'loam');
      const agentModel = agent.model || '';
      if (agentModel && (models.includes(agentModel) || agentModel === configuredModel)) {
        setModel(agentModel);
        setCustomModel('');
      } else if (agentModel) {
        setModel(CUSTOM_MODEL_VALUE);
        setCustomModel(agentModel);
      } else {
        setModel(DEFAULT_MODEL_VALUE);
        setCustomModel('');
      }
      setEffort((agent as unknown as { effort?: string }).effort || 'high');
    }
  }, [agent, models, configuredModel]);

  useEffect(() => {
    if (agent && services.length > 0) {
      const allowed = (agent as unknown as { allowedServices?: string[] }).allowedServices;
      const serviceIds = services.map((s) => s.id);
      if (allowed && allowed.length > 0) {
        const serviceAllowed = allowed.filter((id) => serviceIds.includes(id));
        const skillAllowed = allowed.filter((id) => skills.some((s) => s.name === id));
        const connectorAllowed = allowed.filter((id) => connectors.some((c) => c.name === id));
        setEnabledServices(new Set(serviceAllowed));
        setEnabledSkills(new Set(skillAllowed));
        setEnabledConnectors(new Set(connectorAllowed));
      } else {
        setEnabledServices(new Set(serviceIds));
        setEnabledSkills(new Set());
        setEnabledConnectors(new Set());
      }
    }
  }, [agent, services, skills, connectors]);

  const allServicesEnabled = useMemo(() => {
    return services.length > 0 && services.every((s) => enabledServices.has(s.id));
  }, [services, enabledServices]);

  const memoryEnabled = useMemo(() => {
    return workMode === 'loam';
  }, [workMode]);

  const toggleService = (id: string) => {
    setEnabledServices((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSkill = (name: string) => {
    setEnabledSkills((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleConnector = (name: string) => {
    setEnabledConnectors((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const effectiveModel = useMemo(() => {
    if (model === CUSTOM_MODEL_VALUE) return customModel.trim();
    return model;
  }, [model, customModel]);

  const handleSave = async () => {
    if (!agent) return;
    if (!name.trim()) {
      setError(agentLabel('nameRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const serviceIds = Array.from(enabledServices);
      const chosenCapabilityIds = [...serviceIds, ...enabledSkills, ...enabledConnectors];
      const uniqueCapabilities = [...new Set(chosenCapabilityIds)];
      const allowedServices = allServicesEnabled && enabledSkills.size === 0 && enabledConnectors.size === 0
        ? []
        : uniqueCapabilities;
      const patch: Record<string, unknown> = {
        name: name.trim(),
        emoji: emoji.trim() || '🤖',
        description: description.trim(),
        instructions: instructions.trim(),
        mode,
        workMode,
        effort,
        allowedServices,
      };
      if (effectiveModel) patch.model = effectiveModel;
      else patch.model = null;
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
      const nextInstructions = instructions.trim();
      if (nextInstructions !== savedInstructions) {
        await recordInstructionEdit(agent.id, savedInstructions, nextInstructions).catch(() => undefined);
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

  const handleMemoryToggle = (enabled: boolean) => {
    if (workMode === 'loam' || workMode === 'chat') {
      setWorkMode(enabled ? 'loam' : 'chat');
    }
  };

  if (!open || !agent) return null;

  return (
    <div className="fixed inset-y-0 end-0 z-50 flex w-full max-w-[480px] flex-col border-s border-border-main bg-bg-menu shadow-menu">
      <div className="flex h-row items-center justify-between border-b border-border-main px-4">
        <h2 className="text-title-lg text-text-primary">{agentLabel('editAgent')}</h2>
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
            {agent.id && (
              <div className="flex flex-col gap-2">
                <InstructionHistoryList agentId={agent.id} />
              </div>
            )}
            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              {t('Name')}
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={agentLabel('namePlaceholder')}
                className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              {agentLabel('avatar')}
              <input
                type="text"
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                placeholder={agentLabel('emojiPlaceholder')}
                className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              {agentLabel('description')}
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={agentLabel('descriptionPlaceholder')}
                className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              {agentLabel('instructions')}
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={agentLabel('instructionsPlaceholder')}
                rows={4}
                className="resize-none rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              {agentLabel('loamMode')}
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
              {agentLabel('model')}
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark"
              >
                <option value={DEFAULT_MODEL_VALUE}>{agentLabel('defaultModel')}</option>
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
                <option value={CUSTOM_MODEL_VALUE}>{agentLabel('customModel')}</option>
              </select>
              {model === CUSTOM_MODEL_VALUE && (
                <input
                  type="text"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  placeholder={agentLabel('customModelPlaceholder')}
                  className="mt-1 rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark"
                />
              )}
            </label>

            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              {agentLabel('workMode')}
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

            <label className="flex cursor-pointer items-start gap-2 rounded-control border border-border-main bg-bg-main p-3 hover:bg-fill-hover">
              <input
                type="checkbox"
                checked={memoryEnabled}
                disabled={workMode !== 'loam' && workMode !== 'chat'}
                onChange={(e) => handleMemoryToggle(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-text-primary disabled:opacity-50"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-text-primary">{agentLabel('memory')}</p>
                <p className="text-xs text-text-tertiary">{memoryEnabled ? agentLabel('memoryOn') : agentLabel('memoryOff')}</p>
              </div>
            </label>

            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              {agentLabel('effort')}
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
              <span className="text-sm text-text-secondary">{agentLabel('capabilities')}</span>

              {services.length > 0 && (
                <div className="flex flex-col gap-1">
                  <label className="flex cursor-pointer items-start gap-2 rounded-control border border-border-main bg-bg-main p-2 hover:bg-fill-hover">
                    <input
                      type="checkbox"
                      checked={allServicesEnabled}
                      onChange={() => {
                        setEnabledServices(new Set(allServicesEnabled ? [] : services.map((s) => s.id)));
                      }}
                      className="mt-0.5 size-4 shrink-0 accent-text-primary"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-text-primary">{agentLabel('allServices')}</p>
                    </div>
                  </label>
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
              )}

              {skills.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="px-1 text-xs font-medium text-text-tertiary">{agentLabel('skills')}</span>
                  {skills.map((s) => (
                    <label
                      key={s.name}
                      className="flex cursor-pointer items-start gap-2 rounded-control border border-border-main bg-bg-main p-2 hover:bg-fill-hover"
                    >
                      <input
                        type="checkbox"
                        checked={enabledSkills.has(s.name)}
                        onChange={() => toggleSkill(s.name)}
                        className="mt-0.5 size-4 shrink-0 accent-text-primary"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-text-primary">{s.name}</p>
                        {s.description && <p className="text-xs text-text-tertiary">{s.description}</p>}
                      </div>
                    </label>
                  ))}
                </div>
              )}

              {connectors.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="px-1 text-xs font-medium text-text-tertiary">{agentLabel('connectors')}</span>
                  {connectors.map((c) => (
                    <label
                      key={c.name}
                      className="flex cursor-pointer items-start gap-2 rounded-control border border-border-main bg-bg-main p-2 hover:bg-fill-hover"
                    >
                      <input
                        type="checkbox"
                        checked={enabledConnectors.has(c.name)}
                        onChange={() => toggleConnector(c.name)}
                        className="mt-0.5 size-4 shrink-0 accent-text-primary"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-text-primary">{c.name}</p>
                      </div>
                    </label>
                  ))}
                </div>
              )}
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
