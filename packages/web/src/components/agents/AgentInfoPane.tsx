'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, Settings, Play, Loader2, AlertCircle, FileText, Folder } from 'lucide-react';
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
  nextRunAt?: string;
  lastRunAt?: string;
  lastTaskId?: string;
  agentId?: string;
}

type TabId = 'overview' | 'routines' | 'media' | 'computer' | 'members';

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
        {activeTab === 'routines' && <RoutinesTab agentId={agent.id} />}
        {activeTab === 'media' && <MediaTab threadUid={threadUid} />}
        {activeTab === 'computer' && <ComputerTab threadUid={threadUid} />}
        {activeTab === 'members' && <MembersTab />}
      </div>
    </aside>
  );
}

const TAB_ITEMS: { id: TabId; label: string }[] = [
  { id: 'overview', label: t('Overview') },
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

function RoutinesTab({ agentId }: { agentId: string }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/schedules`, { headers: await getApiHeaders() });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { schedules?: Schedule[] };
      setSchedules((data.schedules ?? []).filter((s) => s.agentId === agentId));
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
        const res = await fetch(`${getApiBase()}/api/schedules`, { headers: await getApiHeaders() });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { schedules?: Schedule[] };
        if (mounted) setSchedules((data.schedules ?? []).filter((s) => s.agentId === agentId));
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
          <div className="flex items-center gap-2 text-xs text-text-tertiary">
            <span className={`rounded-full px-2 py-0.5 ${s.enabled ? 'bg-function-success-tsp text-function-success' : 'bg-fill-tsp text-text-tertiary'}`}>
              {s.enabled ? t('Enabled') : t('Disabled')}
            </span>
            <span>{formatInterval(s.intervalSeconds)}</span>
          </div>
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

function MembersTab() {
  return (
    <div className="flex flex-col gap-2">
      <TeamRunsList />
    </div>
  );
}
