'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, Settings, Play, Loader2, AlertCircle, FileText, Folder, Plus, Send, Mail, Trash2 } from 'lucide-react';
import { t } from '@/i18n/t';
import { Button, Spinner } from '@/components/ui/Button';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { TeamRunsList } from './TeamRunsList';
import type { AgentCardAgent } from './AgentCard';
import { loadAgentThreadFiles } from './AgentThreadView';

interface AgentWithMeta extends AgentCardAgent {
  description?: string;
  instructions?: string;
  effort?: string;
  allowedServices?: string[];
  workMode?: string;
}

interface MemoryEntry {
  id: string;
  text: string;
  kind?: string;
  source?: string;
  at?: string;
}

interface Schedule {
  id: string;
  prompt: string;
  intervalSeconds: number;
  enabled: boolean;
  cron?: string | null;
  runAt?: string | null;
  timezone?: string | null;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastTaskId?: string | null;
  lastStatus?: 'ok' | 'retrying' | 'failed' | null;
  attempts?: number | null;
  lastError?: string | null;
  agentId?: string | null;
}

type TabId = 'overview' | 'channels' | 'routines' | 'media' | 'computer' | 'members';

interface AgentInfoPaneProps {
  agent: AgentWithMeta;
  threadUid: string | null;
  onClose: () => void;
  onEdit: () => void;
}

export function AgentInfoPane({ agent, threadUid, onClose, onEdit }: AgentInfoPaneProps) {
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-s border-border-main bg-bg-menu">
      <div className="flex h-row items-center justify-between border-b border-border-main px-4">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-control bg-fill-tsp text-base">
            {agent.emoji || '🤖'}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text-primary">{agent.name}</p>
            <p className="truncate text-xs text-text-tertiary">{agent.description || agent.mode || 'loam'}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onEdit}
            className="h-row-sm w-row-sm px-0"
            aria-label={t('Edit agent')}
            title={t('Edit agent')}
          >
            <Settings className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-row-sm w-row-sm px-0"
            aria-label={t('Close')}
            title={t('Close')}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex h-row-sm shrink-0 items-center border-b border-border-main">
        {TAB_ITEMS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={[
              'flex h-full flex-1 items-center justify-center px-1 text-[11px] font-medium transition-colors',
              activeTab === tab.id
                ? 'border-b-2 border-text-primary text-text-primary'
                : 'border-b-2 border-transparent text-text-tertiary hover:bg-fill-hover hover:text-text-secondary',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'overview' && <OverviewTab agent={agent} />}
        {activeTab === 'channels' && <ChannelsTab agentId={agent.id} />}
        {activeTab === 'routines' && <RoutinesTab agentId={agent.id} />}
        {activeTab === 'media' && <MediaTab threadUid={threadUid} />}
        {activeTab === 'computer' && <ComputerTab threadUid={threadUid} />}
        {activeTab === 'members' && <MembersTab agentId={agent.id} />}
      </div>
    </aside>
  );
}

const TAB_ITEMS: { id: TabId; label: string }[] = [
  { id: 'overview', label: t('Overview') },
  { id: 'channels', label: t('Channels') },
  { id: 'routines', label: t('Routines') },
  { id: 'media', label: t('Media') },
  { id: 'computer', label: t('Computer') },
  { id: 'members', label: t('Members') },
];

function OverviewTab({ agent }: { agent: AgentWithMeta }) {
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agent.id)}/memory`, {
          headers: await getApiHeaders(),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { entries?: MemoryEntry[] };
        if (mounted) setMemory(data.entries ?? []);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [agent.id]);

  return (
    <div className="flex flex-col gap-4">
      <Field label={t('Name')} value={agent.name} />
      {agent.description && <Field label={t('Description')} value={agent.description} />}
      {agent.instructions && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-tertiary">{t('Instructions')}</span>
          <p className="whitespace-pre-wrap text-sm text-text-primary">{agent.instructions}</p>
        </div>
      )}
      <Field label={t('Mode')} value={agent.mode || '—'} />
      <Field label={t('Work mode')} value={agent.workMode || 'loam'} />
      <Field label={t('Model')} value={agent.model || t('Default')} />
      <Field label={t('Effort')} value={agent.effort ? agent.effort.toUpperCase() : '—'} />

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-text-tertiary">{t('Allowed services')}</span>
        {agent.allowedServices && agent.allowedServices.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {agent.allowedServices.map((svc) => (
              <li key={svc} className="rounded-control bg-fill-tsp px-2 py-1 text-xs text-text-secondary">{svc}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-secondary">{t('All services')}</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-text-tertiary">{t('Memory')}</span>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Spinner className="size-4" /> {t('Loading')}
          </div>
        ) : error ? (
          <p className="text-xs text-function-error">{error}</p>
        ) : memory.length === 0 ? (
          <p className="text-sm text-text-tertiary">{t('No memory entries yet.')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {memory.slice(0, 20).map((entry) => (
              <li key={entry.id} className="rounded-card border border-border-main bg-bg-main p-2">
                <p className="text-sm text-text-primary">{entry.text}</p>
                <p className="mt-1 text-[11px] text-text-tertiary">
                  {entry.kind} · {entry.source}
                  {entry.at && ` · ${new Date(entry.at).toLocaleString()}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ScratchpadSection agentId={agent.id} />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-text-tertiary">{label}</span>
      <p className="text-sm text-text-primary">{value}</p>
    </div>
  );
}

interface ChannelStatus {
  name: 'telegram' | 'email';
  configured: boolean;
  envVarNames: string[];
  hint?: string;
}

interface ChannelBinding {
  id: string;
  channel: 'telegram' | 'email';
  chatId: string;
  agentId: string;
  createdAt: string;
}

function ChannelsTab({ agentId }: { agentId: string }) {
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [bindings, setBindings] = useState<ChannelBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chatIds, setChatIds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const headers = await getApiHeaders();
        const [statusRes, bindingsRes] = await Promise.all([
          fetch(`${getApiBase()}/api/channels`, { headers }),
          fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/channels`, { headers }),
        ]);
        if (!statusRes.ok) throw new Error(`status ${statusRes.status}`);
        const statusData = (await statusRes.json()) as { channels?: ChannelStatus[] };
        const bindingsData = bindingsRes.ok
          ? ((await bindingsRes.json()) as { bindings?: ChannelBinding[] })
          : { bindings: [] as ChannelBinding[] };
        if (mounted) {
          setChannels(statusData.channels ?? []);
          setBindings(bindingsData.bindings ?? []);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [agentId]);

  const bind = async (channel: ChannelStatus['name']) => {
    const chatId = (chatIds[channel] ?? '').trim();
    if (!chatId) return;
    setBusy(true);
    try {
      const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/channels`, {
        method: 'POST',
        headers: await getApiHeaders(),
        body: JSON.stringify({ channel, chatId }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { binding?: ChannelBinding };
      if (data.binding) setBindings((prev) => [...prev, data.binding!]);
      setChatIds((prev) => ({ ...prev, [channel]: '' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unbind = async (bindingId: string) => {
    setBusy(true);
    try {
      const res = await fetch(
        `${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(bindingId)}`,
        { method: 'DELETE', headers: await getApiHeaders() },
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      setBindings((prev) => prev.filter((b) => b.id !== bindingId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        <Spinner className="size-4" /> {t('Loading')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p className="flex items-center gap-1 text-xs text-function-error">
          <AlertCircle className="size-3.5" /> {t('Failed to load channels')} {error}
        </p>
      )}
      {(['telegram', 'email'] as const).map((name) => {
        const status = channels.find((c) => c.name === name);
        const bound = bindings.filter((b) => b.channel === name);
        return (
          <div key={name} className="flex flex-col gap-2 rounded-card border border-border-main bg-bg-main p-3">
            <div className="flex items-center gap-2">
              {name === 'telegram' ? <Send className="size-4 text-text-secondary" /> : <Mail className="size-4 text-text-secondary" />}
              <span className="text-sm font-medium text-text-primary">{t(name === 'telegram' ? 'Telegram' : 'Email')}</span>
              <span
                className={[
                  'ms-auto rounded-control px-2 py-0.5 text-[11px]',
                  status?.configured ? 'bg-fill-tsp text-text-secondary' : 'bg-fill-tsp text-text-tertiary',
                ].join(' ')}
              >
                {status ? (status.configured ? t('Configured') : t('Not configured')) : t('Not configured')}
              </span>
            </div>
            {status && !status.configured && (
              <p className="text-[11px] text-text-tertiary">
                {status.hint || t('Not configured - set {var}', { var: status.envVarNames.join(', ') })}
              </p>
            )}
            {bound.length === 0 ? (
              <p className="text-xs text-text-tertiary">{t('No chats bound yet.')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {bound.map((b) => (
                  <li key={b.id} className="flex items-center gap-2 rounded-control bg-fill-tsp px-2 py-1">
                    <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{b.chatId}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void unbind(b.id)}
                      className="h-row-sm w-row-sm px-0"
                      aria-label={t('Remove binding')}
                      title={t('Remove binding')}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2">
              <input
                value={chatIds[name] ?? ''}
                onChange={(e) => setChatIds((prev) => ({ ...prev, [name]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void bind(name);
                }}
                placeholder={name === 'telegram' ? t('Chat id') : t('Email address')}
                className="h-row-sm min-w-0 flex-1 rounded-control border border-border-main bg-bg-menu px-2 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-text-tertiary"
              />
              <Button type="button" variant="secondary" size="sm" disabled={busy || !(chatIds[name] ?? '').trim()} onClick={() => void bind(name)}>
                {t('Bind')}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface ScratchpadItem {
  id: string;
  text: string;
  status: 'open' | 'done';
  createdAt: string;
  doneAt?: string;
}

function ScratchpadSection({ agentId }: { agentId: string }) {
  const [items, setItems] = useState<ScratchpadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/scratchpad`, {
        headers: await getApiHeaders(),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { items?: ScratchpadItem[] };
      setItems(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/scratchpad`, {
          headers: await getApiHeaders(),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { items?: ScratchpadItem[] };
        if (mounted) setItems(data.items ?? []);
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [agentId]);

  const handleAdd = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/scratchpad`, {
        method: 'POST',
        headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setText('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const handleComplete = async (id: string) => {
    setCompletingIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/scratchpad/${encodeURIComponent(id)}/complete`, {
        method: 'POST',
        headers: await getApiHeaders(),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCompletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-text-tertiary">{t('To-do')}</span>
      <div className="flex gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
          placeholder={t('Add to-do')}
          className="min-w-0 flex-1 rounded-control border border-border-main bg-bg-main px-2 py-1 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-text-primary"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={adding}
          disabled={adding || !text.trim()}
          onClick={() => void handleAdd()}
          aria-label={t('Add')}
          title={t('Add')}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Spinner className="size-4" /> {t('Loading')}
        </div>
      ) : error ? (
        <p className="text-xs text-function-error">{t('Failed to load to-do')} {error}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-tertiary">{t('No to-do items yet.')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-2 rounded-card border border-border-main bg-bg-main p-2">
              <input
                type="checkbox"
                checked={item.status === 'done'}
                disabled={completingIds.has(item.id) || item.status === 'done'}
                onChange={() => void handleComplete(item.id)}
                aria-label={t('Mark as done')}
                title={t('Mark as done')}
                className="mt-0.5 size-4 shrink-0 accent-text-primary"
              />
              <div className="min-w-0 flex-1">
                <p className={`text-sm text-text-primary ${item.status === 'done' ? 'line-through text-text-tertiary' : ''}`}>{item.text}</p>
                <p className="text-[11px] text-text-tertiary">
                  {item.status === 'done' ? t('Done') : t('Open to-do')} · {new Date(item.createdAt).toLocaleString()}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RoutinesTab({ agentId }: { agentId: string }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/schedules`, {
        headers: await getApiHeaders(),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { schedules?: Schedule[] };
      setSchedules(data.schedules ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/schedules`, {
          headers: await getApiHeaders(),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { schedules?: Schedule[] };
        if (mounted) setSchedules(data.schedules ?? []);
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [agentId]);

  const handleRunNow = async (id: string) => {
    setRunningIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`${getApiBase()}/api/schedules/${encodeURIComponent(id)}/run-now`, {
        method: 'POST',
        headers: await getApiHeaders(),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-text-secondary">
        <Loader2 className="size-5 animate-spin" /> {t('Loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-function-error">
        <AlertCircle className="size-5" />
        <p className="text-sm">{t('Failed to load routines')}</p>
        <p className="text-center text-xs">{error}</p>
      </div>
    );
  }

  if (schedules.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-text-tertiary">
        <p className="text-sm">{t('No routines for this agent.')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {schedules.map((s) => (
        <div key={s.id} className="flex flex-col gap-2 rounded-card border border-border-main bg-bg-main p-3">
          <p className="text-sm font-medium text-text-primary">{s.prompt.slice(0, 120)}{s.prompt.length > 120 ? '…' : ''}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
            <span className={`rounded-full px-2 py-0.5 ${s.enabled ? 'bg-function-success-tsp text-function-success' : 'bg-fill-tsp text-text-tertiary'}`}>
              {s.enabled ? t('Enabled') : t('Disabled')}
            </span>
            <span>{cadenceLabel(s)}</span>
          </div>
          {(s.cron || s.runAt) && s.timezone && (
            <p className="text-[11px] text-text-tertiary">{t('Time zone: {tz}', { tz: s.timezone })}</p>
          )}
          {s.nextRunAt && (
            <p className="text-[11px] text-text-tertiary">{t('Next run')} · {formatDateTime(s.nextRunAt)}</p>
          )}
          {s.lastRunAt && (
            <p className="text-[11px] text-text-tertiary">{t('Last run')} · {formatDateTime(s.lastRunAt)}</p>
          )}
          {statusLabel(s) && (
            <p className={`text-[11px] ${s.lastStatus === 'ok' ? 'text-text-tertiary' : 'text-function-error'}`}>{statusLabel(s)}</p>
          )}
          {s.lastStatus === 'failed' && s.lastError && (
            <p className="text-[11px] text-function-error">{s.lastError}</p>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={runningIds.has(s.id)}
            disabled={runningIds.has(s.id)}
            onClick={() => handleRunNow(s.id)}
            className="mt-1 w-full"
          >
            <Play className="size-3.5" />
            {t('Run now')}
          </Button>
        </div>
      ))}
    </div>
  );
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return t('{s}s', { s: seconds });
  if (seconds < 3600) return t('{m}m', { m: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('{h}h', { h: Math.floor(seconds / 3600) });
  return t('{d}d', { d: Math.floor(seconds / 86400) });
}

function formatDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function cadenceLabel(s: Schedule): string {
  if (s.cron) return t('Cron: {cron}', { cron: s.cron });
  if (s.runAt) return t('At {time}', { time: formatDateTime(s.runAt) });
  return formatInterval(s.intervalSeconds);
}

function statusLabel(s: Schedule): string | null {
  if (s.lastStatus === 'ok') return t('Last run ok');
  if (s.lastStatus === 'retrying') return t('Retrying · attempt {n}', { n: s.attempts ?? 1 });
  if (s.lastStatus === 'failed') return t('Failed · attempt {n}', { n: s.attempts ?? 1 });
  return null;
}

function MediaTab({ threadUid }: { threadUid: string | null }) {
  const [files, setFiles] = useState<Array<{ name: string; path: string; bytes: number }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    if (!threadUid) {
      setFiles([]);
      setLoading(false);
      return;
    }
    loadAgentThreadFiles(threadUid).then((entries) => {
      if (!mounted) return;
      setFiles(entries.map((e) => ({ name: e.name, path: e.path, bytes: e.bytes })));
      setLoading(false);
    });
    return () => { mounted = false; };
  }, [threadUid]);

  if (!threadUid) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-text-tertiary">
        <p className="text-sm">{t('No thread yet.')}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-text-secondary">
        <Loader2 className="size-5 animate-spin" /> {t('Loading')}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-text-tertiary">
        <Folder className="size-5" />
        <p className="text-sm">{t('No media files in this thread.')}</p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {files.map((f) => (
        <li key={f.path} className="flex items-center gap-2 rounded-card border border-border-main bg-bg-main p-2">
          <FileText className="size-4 shrink-0 text-text-tertiary" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-text-primary">{f.name}</p>
            <p className="text-[11px] text-text-tertiary">{formatBytes(f.bytes)}</p>
          </div>
          <a
            href={`${getApiBase()}/api/media?taskId=${encodeURIComponent(threadUid)}&path=${encodeURIComponent(f.path)}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
            aria-label={t('Open')}
          >
            ✕
          </a>
        </li>
      ))}
    </ul>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ComputerTab({ threadUid }: { threadUid: string | null }) {
  if (!threadUid) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-text-tertiary">
        <p className="text-sm">{t('No thread yet.')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-text-secondary">
        {t('Computer preview opens automatically when the agent uses a tool. Open the task view for the full computer panel.')}
      </p>
    </div>
  );
}

function MembersTab({ agentId }: { agentId: string }) {
  return (
    <div className="flex flex-col gap-4">
      <ChildrenSection agentId={agentId} />
      <TeamRunsList />
    </div>
  );
}

interface ChildAgent {
  childId: string;
  spawnKey: string;
  name: string;
  emoji: string;
  description: string;
  mode?: string;
  archived: boolean;
  createdAt: string;
}

/** MF6: the child agents this companion spawned (persistent, reusable). */
function ChildrenSection({ agentId }: { agentId: string }) {
  const [children, setChildren] = useState<ChildAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/children`, {
          headers: await getApiHeaders(),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { children?: ChildAgent[] };
        if (mounted) setChildren(data.children ?? []);
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [agentId]);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-text-tertiary">{t('Child agents')}</span>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Spinner className="size-4" /> {t('Loading')}
        </div>
      ) : error ? (
        <p className="text-xs text-function-error">{t('Failed to load children')} {error}</p>
      ) : children.length === 0 ? (
        <p className="text-sm text-text-tertiary">{t('No child agents yet.')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {children.map((child) => (
            <li key={child.childId} className="flex items-start gap-2 rounded-card border border-border-main bg-bg-main p-2">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-control bg-fill-tsp text-base">
                {child.emoji || '🤖'}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text-primary">{child.name}</p>
                {child.description && (
                  <p className="truncate text-xs text-text-secondary">{child.description}</p>
                )}
                <p className="text-[11px] text-text-tertiary">
                  {t('Spawn key')}: {child.spawnKey} · {new Date(child.createdAt).toLocaleString()}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
