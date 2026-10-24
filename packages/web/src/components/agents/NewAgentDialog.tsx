'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Spinner } from '@/components/ui/Button';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { agentLabel } from './agentLabels';

interface AgentTemplate {
  id: string;
  labelAr: string;
  emoji: string;
  description: string;
  instructions: string;
  mode: string;
  workMode: string;
  allowedServices?: string[];
}

interface WorkModeService {
  id: string;
  labelAr: string;
  description: string;
}

interface Skill {
  name: string;
  description?: string;
}

interface Connector {
  name: string;
}

interface NewAgentDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
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
const BLANK_TEMPLATE_ID = '__blank__';

export function NewAgentDialog({ open, onClose, onCreated }: NewAgentDialogProps) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [services, setServices] = useState<WorkModeService[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [configuredModel, setConfiguredModel] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🤖');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [mode, setMode] = useState('build');
  const [model, setModel] = useState(DEFAULT_MODEL_VALUE);
  const [customModel, setCustomModel] = useState('');
  const [effort, setEffort] = useState('high');
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [enabledServices, setEnabledServices] = useState<Set<string>>(new Set());
  const [enabledSkills, setEnabledSkills] = useState<Set<string>>(new Set());
  const [enabledConnectors, setEnabledConnectors] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    setLoading(true);
    setError(null);
    setSelectedTemplateId(null);
    resetForm();
    (async () => {
      try {
        const headers = await getApiHeaders();
        const [templatesRes, workModesRes, skillsRes, mcpRes, configRes, tagsRes] = await Promise.all([
          fetch(`${getApiBase()}/api/agent-templates`, { headers }),
          fetch(`${getApiBase()}/api/work-modes`, { headers }),
          fetch(`${getApiBase()}/api/skills`, { headers }),
          fetch(`${getApiBase()}/api/mcp/status`, { headers }),
          fetch(`${getApiBase()}/api/config`, { headers }),
          fetch(`${getApiBase()}/api/tags`, { headers }).catch(() => null),
        ]);
        if (!templatesRes.ok) throw new Error(`templates ${templatesRes.status}`);
        if (!workModesRes.ok) throw new Error(`work-modes ${workModesRes.status}`);
        if (!skillsRes.ok) throw new Error(`skills ${skillsRes.status}`);
        if (!mcpRes.ok) throw new Error(`mcp ${mcpRes.status}`);
        if (!configRes.ok) throw new Error(`config ${configRes.status}`);
        const templatesData = (await templatesRes.json()) as { templates?: AgentTemplate[] };
        const workModesData = (await workModesRes.json()) as { services?: WorkModeService[] };
        const skillsData = (await skillsRes.json()) as { skills?: Skill[] };
        const mcpData = (await mcpRes.json()) as { servers?: Connector[] };
        const configData = (await configRes.json()) as { defaultModel?: string; model?: string };
        const tagsData = tagsRes && tagsRes.ok ? ((await tagsRes.json()) as { models?: Array<{ name?: string }> }) : { models: [] };
        if (!mounted) return;
        const serviceList = workModesData.services ?? [];
        setTemplates(templatesData.templates ?? []);
        setServices(serviceList);
        setSkills(skillsData.skills ?? []);
        setConnectors(mcpData.servers ?? []);
        const cfgModel = configData.model || configData.defaultModel || '';
        setConfiguredModel(cfgModel);
        const tagNames = (tagsData.models ?? [])
          .map((m) => m.name)
          .filter((n): n is string => Boolean(n) && n !== cfgModel);
        setModels([...(cfgModel ? [cfgModel] : []), ...tagNames]);
        setEnabledServices(new Set(serviceList.map((s) => s.id)));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [open]);

  const resetForm = () => {
    setName('');
    setEmoji('🤖');
    setDescription('');
    setInstructions('');
    setMode('build');
    setModel(DEFAULT_MODEL_VALUE);
    setCustomModel('');
    setEffort('high');
    setMemoryEnabled(true);
    setEnabledServices(new Set(services.map((s) => s.id)));
    setEnabledSkills(new Set());
    setEnabledConnectors(new Set());
  };

  const applyTemplate = (tpl: AgentTemplate) => {
    setName(tpl.labelAr);
    setEmoji(tpl.emoji);
    setDescription(tpl.description);
    setInstructions(tpl.instructions);
    setMode(tpl.mode);
    setModel(DEFAULT_MODEL_VALUE);
    setCustomModel('');
    setEffort('high');
    setMemoryEnabled(tpl.workMode !== 'chat');
    setEnabledServices(new Set(tpl.allowedServices && tpl.allowedServices.length > 0
      ? tpl.allowedServices.filter((id) => services.some((s) => s.id === id))
      : services.map((s) => s.id)));
    setEnabledSkills(new Set());
    setEnabledConnectors(new Set());
  };

  const handleSelectTemplate = (id: string | null) => {
    setSelectedTemplateId(id);
    if (id === BLANK_TEMPLATE_ID) {
      resetForm();
    } else if (id !== null) {
      const tpl = templates.find((t) => t.id === id);
      if (tpl) applyTemplate(tpl);
    }
  };

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

  const buildBody = () => {
    const allowedServices = Array.from(enabledServices);
    // Skills/connectors are presented as capabilities; the backend's allowedServices field is
    // the existing service allowlist. Per task, chosen capability items map to allowedServices.
    const chosenCapabilityIds = [...allowedServices, ...enabledSkills, ...enabledConnectors];
    const uniqueCapabilities = [...new Set(chosenCapabilityIds)];
    const finalAllowedServices = allServicesEnabled && enabledSkills.size === 0 && enabledConnectors.size === 0
      ? []
      : uniqueCapabilities;
    const body: Record<string, unknown> = {
      name: name.trim(),
      emoji: emoji.trim() || '🤖',
      description: description.trim(),
      instructions: instructions.trim(),
      mode,
      effort,
      workMode: memoryEnabled ? 'loam' : 'chat',
      allowedServices: finalAllowedServices,
    };
    if (effectiveModel) body.model = effectiveModel;
    return body;
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError(agentLabel('nameRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/agents`, {
        method: 'POST',
        headers: {
          ...(await getApiHeaders()),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildBody()),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `status ${res.status}`);
      }
      onCreated();
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const starterOptions = [
    {
      id: BLANK_TEMPLATE_ID,
      emoji: '🤖',
      labelAr: agentLabel('blankAgent'),
      description: agentLabel('blankAgentDescription'),
      mode: '',
      workMode: '',
    },
    ...templates,
  ];

  return (
    <Dialog open={open} onClose={onClose} title={agentLabel('newAgent')} width={560}>
      <div className="flex flex-col gap-4">
        <div>
          <p className="mb-2 text-sm font-medium text-text-primary">{agentLabel('stepTemplate')}</p>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-text-secondary">
              <Spinner className="size-5" /> {t('Loading')}
            </div>
          ) : (
            <div className="grid max-h-[160px] grid-cols-1 gap-2 overflow-y-auto">
              {starterOptions.map((opt) => (
                <button
                  key={opt.id ?? 'blank'}
                  type="button"
                  onClick={() => handleSelectTemplate(opt.id)}
                  className={`flex items-start gap-3 rounded-control border p-3 text-start transition-colors ${
                    selectedTemplateId === opt.id
                      ? 'border-border-dark bg-fill-hover'
                      : 'border-border-main bg-bg-main hover:bg-fill-hover'
                  }`}
                >
                  <span className="text-xl">{opt.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary">{opt.labelAr}</p>
                    <p className="text-xs text-text-tertiary">{opt.description}</p>
                    {opt.mode && opt.workMode && (
                      <p className="mt-1 text-[11px] text-text-tertiary">{opt.mode} · {opt.workMode}</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {selectedTemplateId !== null && !loading && (
          <>
            <div className="border-t border-border-main" />
            <p className="text-sm font-medium text-text-primary">{agentLabel('stepDetails')}</p>

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

            <label className="flex cursor-pointer items-start gap-2 rounded-control border border-border-main bg-bg-main p-3 hover:bg-fill-hover">
              <input
                type="checkbox"
                checked={memoryEnabled}
                onChange={(e) => setMemoryEnabled(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-text-primary"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-text-primary">{agentLabel('memory')}</p>
                <p className="text-xs text-text-tertiary">{memoryEnabled ? agentLabel('memoryOn') : agentLabel('memoryOff')}</p>
              </div>
            </label>
          </>
        )}

        {error && (
          <div className="rounded-control bg-function-error-tsp px-3 py-2 text-sm text-function-error">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {t('Cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={saving}
            disabled={selectedTemplateId === null || saving || !name.trim()}
            onClick={handleCreate}
          >
            {t('Create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
